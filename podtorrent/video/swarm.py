"""Video jobs across the swarm (docs/VIDEO_PLAN.md, phases 2–3).

The requester drives the job; the data moves peer to peer:

    requester ──VideoStage(encode 0..k)──► Mac A   holds hidden state h1
    requester ──VideoStage(encode k..50, input=h1@A)──► Mac B   pulls h1 from A, holds h2
    requester ──VideoStage(render, input=h2@B)──► video peer   pulls h2 from B, holds the MP4
    requester pulls the MP4 from the video peer

Each stage is one VideoStage call: a VideoJob goes out, JobEvents stream back until done or failed
(a second VideoJob with cancel=true stops it). Blobs move with net/blob.py.

Peers advertise roles in NodeInfo.roles: `h3-encoder:LO:HI` for each encoder slice on disk, `h3-video`
when this machine can render. PODTORRENT_VIDEO_FAKE_ROLES (e.g. "h3-encoder:0:25,h3-video") adds
roles whose stages are simulated: random hidden states and a placeholder MP4, for testing without
the weights or a GPU.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from pathlib import Path
from typing import Callable

import numpy as np

from .. import pipeline_pb2 as pb
from ..net import blob
from ..net.identity import home
from ..net.quic import M_BLOB, M_VIDEO, PeerNet, _frame, _read_frame
from .. import route
from . import h3
from .encoder_mlx import H3_LAYERS

HIDDEN = 5120   # Qwen3-VL-32B's hidden size
PLACEHOLDER = Path(__file__).with_name("placeholder.mp4")
FAKE_ROLES = [r for r in os.environ.get("PODTORRENT_VIDEO_FAKE_ROLES", "").replace(" ", "").split(",") if r]
FAKE_STEP_S = float(os.environ.get("PODTORRENT_VIDEO_FAKE_STEP_S", "0.3"))


def parse_encoder(role: str) -> tuple[int, int] | None:
    r = route.parse_role(role)
    return (r[1], r[2]) if r and r[0] == "encoder" else None


class VideoSwarm:
    def __init__(self, net: PeerNet, svc, enc, me: str):
        self.net, self.svc, self.enc, self.me = net, svc, enc, me
        self.store = blob.BlobStore(home() / "video" / "blobs")
        self.tasks: dict[str, asyncio.Task] = {}     # requester side: job id -> driver
        self.streams: dict[str, list] = {}           # job id -> open stage streams (for cancel)
        net.handlers[M_VIDEO] = self._serve_stage
        net.handlers[M_BLOB] = self._serve_blob

    # ---------- roles ----------
    def roles(self) -> list[str]:
        out = [f"h3-encoder:{s['lo']}:{s['hi']}" for s in self.enc.slices()]
        if self.svc.capability().get("ok") and self.svc.render_ready():
            out.append(route.video_role(self.svc.gpu.get("vram_gb", 0), self.svc.ram or 0))
        return sorted(set(out + FAKE_ROLES))

    def offers(self) -> list[route.VideoOffer]:
        out = [route.VideoOffer(self.me, "this machine", tuple(self.roles()))]
        for pid, l in self.net.links.items():
            if l.state == "direct" and l.conn:
                out.append(route.VideoOffer(pid, self._name(pid), tuple(l.info.get("roles") or []), l.rtt_ms or 0.0))
        return out

    def plan(self) -> tuple[list[tuple[str, int, int]], str]:
        hops, video = route.plan_video(H3_LAYERS, self.offers(), self.me)
        return [(h.peer_id, h.lo, h.hi) for h in hops], video

    def status(self) -> dict:
        offers = self.offers()
        try:
            hops, video = self.plan()
            plan, reason = {"encoder": [[self._name(p), lo, hi] for p, lo, hi in hops], "video": self._name(video)}, ""
        except ValueError as e:
            plan, reason = None, str(e)

        def describe(o: route.VideoOffer) -> dict:
            enc = sorted(s for r in o.roles if (s := parse_encoder(r)))
            why = route.can_render(o)
            return {"name": o.name, "me": o.peer_id == self.me, "rtt_ms": None if o.peer_id == self.me else o.rtt_ms,
                    "roles": list(o.roles), "encoder": [list(x) for x in enc], "video": why is None,
                    "video_why": "" if why in (None, "doesn't render video") else why}
        active = [{"id": j["id"], "state": j["state"], "detail": j["detail"], "step": j["step"], "steps": j["steps"],
                   "route": j.get("route")} for jid in self.tasks if (j := self.svc.jobs.get(jid))]
        return {"roles": self.roles(), "route": plan, "reason": reason, "machines": [describe(o) for o in offers],
                "peers": [{"name": o.name, "roles": list(o.roles)} for o in offers if o.peer_id != self.me],
                "jobs": active}

    def _name(self, pid: str) -> str:
        return "this machine" if pid == self.me else self.net._name(pid)

    # ---------- blobs ----------
    async def _serve_blob(self, conn, body, reader, writer):
        def send(b: bytes):
            writer.write(_frame(b))
            conn.transmit()
        await blob.serve(self.store, body, lambda: _read_frame(reader), send)

    async def pull(self, ref: pb.BlobRef, dest: Path | None = None, progress=None) -> Path:
        """A local path holding `ref`: ours already, or pulled from its holder into the store."""
        if self.store.has(ref.sha256):
            path = self.store.path(ref.sha256)
            if dest:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(path.read_bytes())
                return dest
            return path

        async def open_call(first: bytes):
            s = await self.net.conn_to(ref.holder).open(M_BLOB, first)
            return s.recv, s.send, s.close
        return await blob.fetch(open_call, ref.sha256, ref.size, dest or self.store.path(ref.sha256), progress)

    # ---------- serving a stage ----------
    async def _serve_stage(self, conn, body, reader, writer):
        job = pb.VideoJob.FromString(body)
        cancelled = asyncio.Event()

        def send(ev: pb.JobEvent):
            writer.write(_frame(ev.SerializeToString()))
            conn.transmit()

        async def watch():
            try:
                while True:
                    if pb.VideoJob.FromString(await _read_frame(reader)).cancel:
                        cancelled.set()
            except (asyncio.IncompleteReadError, ConnectionError, ValueError):
                cancelled.set()  # the requester is gone: stop working for it

        w = asyncio.ensure_future(watch())
        print(f"video: {job.stage} for {self.net._name(conn.peer_id)} job {job.job_id}"
              + (f" layers [{job.layer_lo},{job.layer_hi})" if job.stage == "encode" else ""), flush=True)
        try:
            await self.run_stage(job, send, cancelled, self.net._name(conn.peer_id))
        finally:
            w.cancel()

    async def run_stage(self, job: pb.VideoJob, send: Callable[[pb.JobEvent], None], cancelled: asyncio.Event,
                        who: str = "this machine"):
        t0 = time.time()
        ev = lambda **k: send(pb.JobEvent(job_id=job.job_id, **k))  # noqa: E731
        try:
            if job.stage == "encode":
                out = await self._encode(job, ev, cancelled)
            elif job.stage == "render":
                out = await self._render(job, ev, cancelled, who)
            else:
                raise ValueError(f"unknown stage {job.stage!r}")
            if cancelled.is_set():
                ev(state="cancelled", detail="Cancelled")
            else:
                ev(state="done", detail="Done", output=out, seconds=time.time() - t0)
        except Exception as e:  # noqa: BLE001 - reported to the requester
            ev(state="failed", detail="Failed", error=f"{type(e).__name__}: {e}" if not str(e) else str(e))

    def _fake(self, role: str) -> bool:
        return role in FAKE_ROLES

    async def _encode(self, job: pb.VideoJob, ev, cancelled) -> pb.BlobRef:
        lo, hi = job.layer_lo, job.layer_hi
        role = next((r for r in self.roles() if parse_encoder(r) == (lo, hi)), None)
        if role is None:
            raise RuntimeError(f"This machine doesn't hold encoder layers {lo}–{hi - 1}.")
        prompt = next((p.text for p in job.inputs if p.type == "text"), "")
        h = None
        if lo > 0:
            ev(state="encoding", detail="Receiving the hidden state")
            path = await self.pull(job.input)
            h = np.frombuffer(path.read_bytes(), dtype=np.float32).reshape(list(job.input.shape))
        ev(state="encoding", detail=f"Encoder layers {lo}–{hi - 1}")
        if self._fake(role):
            n = h.shape[1] if h is not None else max(1, len(prompt.split()))
            await asyncio.sleep(FAKE_STEP_S * 2)
            seed = int.from_bytes(hashlib.sha256(f"{prompt}|{lo}|{hi}".encode()).digest()[:4], "big")
            out = np.random.default_rng(seed).standard_normal((1, n, HIDDEN)).astype(np.float32)
        else:
            out = await asyncio.to_thread(self._encode_real, prompt, h, role)
        if not np.isfinite(out).all():
            raise RuntimeError("The encoder output has NaN or infinite values.")
        sha, size = self.store.put_bytes(out.astype(np.float32).tobytes())
        return pb.BlobRef(sha256=sha, size=size, holder=self.me, kind="hidden", shape=list(out.shape))

    def _encode_real(self, prompt: str, h, role: str):
        from .. import backend
        from .encoder_mlx import tokenize
        lo, hi = parse_encoder(role)
        shard = self.enc._shard(lo, hi)
        if backend.NAME == "mlx":
            import mlx.core as mx
            x = shard.embed(mx.array([tokenize(self.enc.dir, prompt)])) if h is None else mx.array(h).astype(mx.bfloat16)
            y = shard.run_layers(x)
            return np.array(y.astype(mx.float32))
        import torch
        x = shard.embed([tokenize(self.enc.dir, prompt)]) if h is None else torch.from_numpy(h.copy())
        return shard.run_layers(x).float().cpu().numpy()

    async def _render(self, job: pb.VideoJob, ev, cancelled, who: str) -> pb.BlobRef:
        if not any((r := route.parse_role(x)) and r[0] == "video" for x in self.roles()):
            raise RuntimeError("This machine can't render video.")
        ev(state="generating", detail="Receiving the prompt embeddings")
        path = await self.pull(job.input)
        h = np.frombuffer(path.read_bytes(), dtype=np.float32)
        if h.size != int(np.prod(job.input.shape)) or not np.isfinite(h).all():
            raise RuntimeError("The prompt embeddings arrived damaged.")
        if not self._fake("h3-video"):
            return await self._render_real(job, h.reshape(list(job.input.shape)), ev, cancelled, who)
        for i in range(1, job.steps + 1):
            if cancelled.is_set():
                return pb.BlobRef()
            ev(state="generating", detail=f"Step {i} of {job.steps}", step=i, steps=job.steps)
            await asyncio.sleep(FAKE_STEP_S)
        ev(state="decoding", detail="Decoding frames and audio")
        await asyncio.sleep(FAKE_STEP_S)
        sha, size = self.store.put_file(PLACEHOLDER)
        return pb.BlobRef(sha256=sha, size=size, holder=self.me, kind="mp4")

    async def _render_real(self, job: pb.VideoJob, h: np.ndarray, ev, cancelled, who: str) -> pb.BlobRef:
        """Render on this machine's ComfyUI, in the same queue as its local jobs."""
        if h.ndim != 3 or h.shape[0] != 1 or h.shape[2] != HIDDEN:
            raise RuntimeError(f"The prompt embeddings have the wrong shape {list(h.shape)}.")
        inbox = self.svc.root / "inbox"
        inbox.mkdir(parents=True, exist_ok=True)
        npy = inbox / f"{job.job_id}.npy"
        np.save(npy, h)
        finished = asyncio.Event()

        def watch(j: dict):
            if j["state"] in ("done", "failed", "cancelled"):
                finished.set()
            elif j["state"] == "queued":
                ev(state="generating", detail="Waiting for the video machine's queue")
            else:
                ev(state="decoding" if j["state"] in ("decoding", "saving") else "generating",
                   detail=j["detail"], step=j.get("step") or 0, steps=j.get("steps") or 0)

        mode = job.mode if job.mode in h3.MODES else "best"
        rjob = self.svc.submit_render(npy, who,
                                      job.width, job.height, job.seconds, job.seed, mode, watch)
        try:
            c = asyncio.ensure_future(cancelled.wait())
            f = asyncio.ensure_future(finished.wait())
            await asyncio.wait({c, f}, return_when=asyncio.FIRST_COMPLETED)
            c.cancel()
            if not finished.is_set():
                await self.svc.cancel(rjob["id"])
                await finished.wait()
                f.cancel()
        finally:
            self.svc.watchers.pop(rjob["id"], None)
            npy.unlink(missing_ok=True)
        if cancelled.is_set() or rjob["state"] == "cancelled":
            return pb.BlobRef()
        if rjob["state"] != "done":
            raise RuntimeError(rjob["error"] or "The render failed.")
        video = self.svc.outputs / rjob["video"] if rjob.get("video") else (PLACEHOLDER if self.svc.jobs[rjob["id"]].get("fake") else None)
        if not video or not video.exists():
            raise RuntimeError("The render finished but saved no video.")
        sha, size = self.store.put_file(video)
        return pb.BlobRef(sha256=sha, size=size, holder=self.me, kind="mp4")

    # ---------- requesting ----------
    def submit(self, prompt: str, preset: str, seconds: float, seed: int | None, mode: str = "best") -> dict:
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("Write a prompt first")
        if preset not in h3.PRESETS or mode not in h3.MODES:
            raise ValueError("unknown preset or mode")
        hops, video = self.plan()
        seconds = min(h3.MAX_SECONDS, max(h3.MIN_SECONDS, float(seconds)))
        p = h3.PRESETS[preset]
        job = {"id": uuid.uuid4().hex[:10], "node": self.svc.node, "prompt": prompt[:4000], "preset": preset,
               "width": p["width"], "height": p["height"], "seconds": seconds, "frames": h3.frames_for(seconds),
               "mode": mode, "seed": seed if seed is not None else int.from_bytes(os.urandom(6), "big"),
               "state": "queued", "detail": "Waiting", "step": 0, "steps": h3.MODES[mode]["steps"],
               "created": time.time(), "started": None, "finished": None, "error": "", "video": None, "fake": False,
               "where": "swarm", "route": {"encoder": [[self._name(pid), lo, hi] for pid, lo, hi in hops],
                                           "video": self._name(video)}}
        self.svc.jobs[job["id"]] = job
        self.svc._job_event(job)
        self.tasks[job["id"]] = asyncio.ensure_future(self._drive(job, hops, video))
        return job

    def owns(self, jid: str) -> bool:
        return jid in self.tasks

    async def cancel(self, jid: str) -> dict:
        job = self.svc.jobs[jid]
        if job["state"] in ("done", "failed", "cancelled"):
            return job
        self.svc.cancelled.add(jid)
        for s in self.streams.get(jid, []):
            try:
                s.send(pb.VideoJob(job_id=jid, cancel=True).SerializeToString())
            except Exception:  # noqa: BLE001 - link already gone
                pass
        return job

    def _proto(self, job: dict, **k) -> pb.VideoJob:
        return pb.VideoJob(job_id=job["id"], inputs=[pb.InputPart(type="text", text=job["prompt"])],
                           width=job["width"], height=job["height"], seconds=job["seconds"], frames=job["frames"],
                           seed=job["seed"], steps=job["steps"], mode=job["mode"], **k)

    async def _stage(self, job: dict, pid: str, req: pb.VideoJob, on_event) -> pb.JobEvent:
        """Run one stage on pid (here, or over QUIC) and return its final event."""
        jid = job["id"]
        if pid == self.me:
            q: asyncio.Queue = asyncio.Queue()
            cancelled = asyncio.Event()
            local = _LocalStage(cancelled)
            self.streams.setdefault(jid, []).append(local)
            task = asyncio.ensure_future(self.run_stage(req, q.put_nowait, cancelled))
            try:
                while True:
                    ev = await q.get()
                    if ev.state in ("done", "failed", "cancelled"):
                        return ev
                    on_event(ev)
            finally:
                self.streams[jid].remove(local)
                await task
        s = await self.net.conn_to(pid).open(M_VIDEO, req.SerializeToString())
        self.streams.setdefault(jid, []).append(s)
        try:
            while True:
                ev = pb.JobEvent.FromString(await s.recv())
                if ev.state in ("done", "failed", "cancelled"):
                    return ev
                on_event(ev)
        except (asyncio.IncompleteReadError, ConnectionError) as e:
            raise RuntimeError(f"Lost the link to {self._name(pid)} during the job ({e or type(e).__name__}).") from e
        finally:
            self.streams[jid].remove(s)
            s.close()

    async def _drive(self, job: dict, hops: list[tuple[str, int, int]], video: str):
        jid, svc = job["id"], self.svc
        diag = {"job": jid, "where": "swarm", "route": job["route"], "stages": []}
        t0 = time.time()
        svc._job_event(job, state="encoding", detail="Encoding the prompt", started=t0)
        try:
            ref = pb.BlobRef()
            for pid, lo, hi in hops:
                t = time.time()
                done = await self._stage(job, pid, self._proto(job, stage="encode", layer_lo=lo, layer_hi=hi, input=ref),
                                         lambda ev, n=self._name(pid): svc._job_event(job, detail=f"{n}: {ev.detail}"))
                self._check(job, done, pid)
                ref = done.output
                diag["stages"].append({"stage": "encode", "peer": self._name(pid), "layers": [lo, hi],
                                       "seconds": round(time.time() - t, 2), "compute_s": round(done.seconds, 2),
                                       "out_bytes": ref.size, "shape": list(ref.shape)})
            t = time.time()
            svc._job_event(job, state="generating", detail=f"{self._name(video)}: starting")
            done = await self._stage(job, video, self._proto(job, stage="render", input=ref),
                                     lambda ev: svc._job_event(job, state=ev.state or job["state"], detail=f"{self._name(video)}: {ev.detail}",
                                                               step=ev.step or job["step"]))
            self._check(job, done, video)
            diag["stages"].append({"stage": "render", "peer": self._name(video), "seconds": round(time.time() - t, 2),
                                   "compute_s": round(done.seconds, 2), "out_bytes": done.output.size})
            t = time.time()
            svc._job_event(job, state="decoding", detail="Fetching the video")
            last = [0.0]

            def progress(got, total):
                if time.monotonic() - last[0] > 0.5:
                    last[0] = time.monotonic()
                    svc._job_event(job, detail=f"Fetching the video ({got * 100 // max(total, 1)}%)")
            await self.pull(done.output, svc.outputs / f"{jid}.mp4", progress)
            diag["stages"].append({"stage": "fetch", "seconds": round(time.time() - t, 2), "bytes": done.output.size})
            svc._job_event(job, state="done", detail="Done", video=f"{jid}.mp4", finished=time.time())
        except Exception as e:  # noqa: BLE001
            c = jid in svc.cancelled
            svc._job_event(job, state="cancelled" if c else "failed", detail="Cancelled" if c else "Failed",
                           error="" if c else (str(e) or type(e).__name__), finished=time.time())
        finally:
            self.tasks.pop(jid, None)
            self.streams.pop(jid, None)
            diag.update(state=job["state"], error=job["error"], total_s=round(time.time() - t0, 1))
            svc.outputs.mkdir(parents=True, exist_ok=True)
            (svc.outputs / f"{jid}.json").write_text(json.dumps(diag, indent=2))

    def _check(self, job: dict, ev: pb.JobEvent, pid: str):
        if ev.state == "cancelled" or job["id"] in self.svc.cancelled:
            raise RuntimeError("cancelled")
        if ev.state != "done":
            raise RuntimeError(f"{self._name(pid)}: {ev.error or 'stage failed'}")


class _LocalStage:
    """Stands in for a stage stream when the stage runs on this machine: a send is a cancel."""

    def __init__(self, cancelled: asyncio.Event):
        self.cancelled = cancelled

    def send(self, _body: bytes):
        self.cancelled.set()
