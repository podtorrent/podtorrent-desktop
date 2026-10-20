"""Local API for video jobs (loopback only, like the rest of the peer's API)."""

from aiohttp import web

from .encoder_node import EncoderNode
from .service import VideoService
from .swarm import VideoSwarm


def routes(svc: VideoService, enc: EncoderNode, swarm: VideoSwarm) -> list:
    def err(e: Exception, status=400):
        return web.json_response({"error": str(e)}, status=status)

    async def status(_):
        return web.json_response(svc.status())

    async def setup(_):
        try:
            return web.json_response(svc.start_setup())
        except RuntimeError as e:
            return err(e)

    async def submit(request):
        b = await request.json()
        try:
            seed = b.get("seed")
            job = svc.submit(str(b.get("prompt") or ""), str(b.get("preset") or "draft"), float(b.get("seconds") or 5),
                             int(seed) if seed not in (None, "") else None, str(b.get("mode") or "best"))
        except (ValueError, RuntimeError) as e:
            return err(e)
        return web.json_response(job)

    async def swarm_status(_):
        return web.json_response(swarm.status())

    async def swarm_submit(request):
        b = await request.json()
        try:
            seed = b.get("seed")
            job = swarm.submit(str(b.get("prompt") or ""), str(b.get("preset") or "draft"), float(b.get("seconds") or 5),
                               int(seed) if seed not in (None, "") else None, str(b.get("mode") or "best"))
        except (ValueError, RuntimeError) as e:
            return err(e)
        return web.json_response(job)

    async def cancel(request):
        jid = request.match_info["id"]
        try:
            return web.json_response(await (swarm.cancel(jid) if swarm.owns(jid) else svc.cancel(jid)))
        except KeyError:
            return err(KeyError("no such job"), 404)

    def _file(request, suffix):
        jid = request.match_info["id"]
        if not jid.isalnum():
            raise web.HTTPNotFound()
        f = svc.outputs / f"{jid}{suffix}"
        if not f.exists():
            raise web.HTTPNotFound()
        return web.FileResponse(f)

    async def video(request):
        return _file(request, ".mp4")

    async def report(request):
        return _file(request, ".json")

    async def enc_status(_):
        return web.json_response(enc.status())

    async def enc_fetch(request):
        b = await request.json()
        try:
            return web.json_response(enc.start_fetch(int(b["lo"]), int(b["hi"])))
        except (KeyError, ValueError, RuntimeError) as e:
            return err(e)

    async def enc_remove(request):
        b = await request.json()
        try:
            return web.json_response(await enc.remove(int(b["lo"]), int(b["hi"])))
        except (KeyError, ValueError, RuntimeError) as e:
            return err(e)

    async def enc_test(request):
        b = await request.json()
        try:
            return web.json_response(await enc.test(str(b.get("prompt") or "").strip() or "A red fox runs through snow."))
        except RuntimeError as e:
            return err(e)

    return [web.get("/api/video/encoder", enc_status), web.post("/api/video/encoder/fetch", enc_fetch),
            web.post("/api/video/encoder/remove", enc_remove), web.post("/api/video/encoder/test", enc_test),
            web.get("/api/video/status", status), web.post("/api/video/setup", setup),
            web.post("/api/video/jobs", submit), web.get("/api/video/swarm", swarm_status),
            web.post("/api/video/swarm/jobs", swarm_submit), web.post("/api/video/jobs/{id}/cancel", cancel),
            web.get("/api/video/file/{id}", video), web.get("/api/video/report/{id}", report)]
