"""OpenAI-compatible API over the swarm route, for the PodTorrent network agent.

The agent (bundled with the app) forwards network requests to these loopback paths, so this
Mac acts as the head of a pipeline: tokenizer, embeddings and head here, layers on the route.
Generation is greedy; sampling parameters are accepted and ignored.
"""

import asyncio
import json
import threading
import time
import uuid

from aiohttp import web


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # [{"type": "text", "text": ...}, ...]
        return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


def _err(message: str, status: int, kind: str = "invalid_request_error"):
    return web.json_response({"error": {"message": message, "type": kind}}, status=status)


def routes(app) -> list:
    """`app` is the PeerApp: models(), route(), ensure_head(), generate(), active/active_lock, stats."""

    async def models(_):
        data = [{"id": m["model"], "object": "model", "owned_by": "podtorrent"}
                for m in app.models() if m["state"] == "available"]
        return web.json_response({"object": "list", "data": data})

    async def chat(request):
        try:
            b = await request.json()
        except json.JSONDecodeError:
            return _err("body is not JSON", 400)
        model = str(b.get("model") or app.repo)
        msgs = b.get("messages")
        if not isinstance(msgs, list) or not msgs:
            return _err("messages is required", 400)
        if not app.route(model)[0]:
            return _err(f"{model} is not covered by reachable peers", 503, "unavailable")
        max_tokens = int(b.get("max_completion_tokens") or b.get("max_tokens") or 512)
        stream = bool(b.get("stream"))
        usage_wanted = bool((b.get("stream_options") or {}).get("include_usage"))
        cid, created = f"chatcmpl-{uuid.uuid4().hex}", int(time.time())

        loop = asyncio.get_running_loop()
        q: asyncio.Queue = asyncio.Queue()
        cancel = threading.Event()

        def run():
            with app.active_lock:
                app.active += 1
            try:
                _, tok_ = app.ensure_head(model)
                text = tok_.apply_chat_template([{"role": m.get("role", "user"), "content": _text(m.get("content"))}
                                                 for m in msgs], add_generation_prompt=True, tokenize=False,
                                                enable_thinking=False)
                ids = tok_.encode(text)
                loop.call_soon_threadsafe(q.put_nowait, ("prompt", len(ids)))
                n = 0
                for _, piece, _ in app.generate(ids, max_tokens, model):
                    if cancel.is_set():
                        break
                    n += 1
                    loop.call_soon_threadsafe(q.put_nowait, ("piece", piece))
                app.stats["requests"] += 1
                app.stats["prompt_tokens"] += len(ids)
                app.stats["generated_tokens"] += n
                loop.call_soon_threadsafe(q.put_nowait, ("end", "length" if n >= max_tokens else "stop"))
            except Exception as e:  # noqa: BLE001
                loop.call_soon_threadsafe(q.put_nowait, ("error", str(e)))
            finally:
                with app.active_lock:
                    app.active -= 1

        threading.Thread(target=run, daemon=True).start()

        def chunk(delta, finish=None, usage=None):
            c = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                 "choices": [] if usage else [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage:
                c["usage"] = usage
            return f"data: {json.dumps(c)}\n\n".encode()

        prompt_tokens, completion_tokens, parts = 0, 0, []
        resp = None
        try:
            while True:
                kind, val = await q.get()
                if kind == "prompt":
                    prompt_tokens = val
                    if stream:
                        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream",
                                                           "Cache-Control": "no-cache"})
                        await resp.prepare(request)
                        await resp.write(chunk({"role": "assistant", "content": ""}))
                elif kind == "piece":
                    completion_tokens += 1
                    if stream:
                        await resp.write(chunk({"content": val}))
                    else:
                        parts.append(val)
                elif kind == "error":
                    if resp is None:
                        return _err(f"generation failed: {val}", 502, "server_error")
                    await resp.write(f"data: {json.dumps({'error': {'message': val}})}\n\n".encode())
                    break
                else:  # end
                    usage = {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
                             "total_tokens": prompt_tokens + completion_tokens}
                    if not stream:
                        return web.json_response({
                            "id": cid, "object": "chat.completion", "created": created, "model": model,
                            "choices": [{"index": 0, "finish_reason": val,
                                         "message": {"role": "assistant", "content": "".join(parts)}}],
                            "usage": usage})
                    await resp.write(chunk({}, val))
                    if usage_wanted:
                        await resp.write(chunk(None, usage=usage))
                    break
            await resp.write(b"data: [DONE]\n\n")
            await resp.write_eof()
            return resp
        except (asyncio.CancelledError, ConnectionResetError):
            cancel.set()  # client went away: stop generating on the route
            raise

    return [web.get("/v1/models", models), web.post("/v1/chat/completions", chat)]


def network_manifest(app, base: dict) -> dict:
    """The agent's manifest (podtorrent-agent spec, "Manifest"): `base` (node, price, tiers, as
    saved by the app) plus every model the swarm fully covers, with its route as `pipeline`. In a pod,
    only the models whose plan names this machine as head.
    One slot per model: each request holds the whole route."""
    models = []
    roster = getattr(app, "pod", None)
    for m in app.models():
        if m["state"] != "available":
            continue
        if roster and not any(p["model"] == m["model"] and p["head"] == app.me for p in roster["plans"]):
            continue  # in a pod, only a plan's head offers its model, so the network sees one node per pod
        hops, _ = app.route(m["model"])
        models.append({"id": m["model"], "slots": 1,
                       "pipeline": {"layers": m["n_layers"],
                                    "hops": [{"peer": h.name, "lo": h.lo, "hi": h.hi} for h in hops]}})
    base = {k: v for k, v in base.items() if k != "network"}  # which gateway the app dials, not manifest
    return {**base, "models": models}


def write_network_manifest(app, home) -> None:
    """Rewrite home/network-manifest.json when it changes; the agent picks changes up itself.
    Does nothing until the app has saved home/network.json (the node joined the network)."""
    try:
        base = json.loads((home / "network.json").read_text())
    except (OSError, ValueError):
        return
    out = home / "network-manifest.json"
    text = json.dumps(network_manifest(app, base), indent=2)
    try:
        if out.read_text() == text:
            return
    except OSError:
        pass
    tmp = out.with_suffix(".tmp")
    tmp.write_text(text)
    tmp.replace(out)
