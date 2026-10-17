"""Local API for video jobs (loopback only, like the rest of the peer's API)."""

from aiohttp import web

from .service import VideoService


def routes(svc: VideoService) -> list:
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

    async def cancel(request):
        try:
            return web.json_response(await svc.cancel(request.match_info["id"]))
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

    return [web.get("/api/video/status", status), web.post("/api/video/setup", setup),
            web.post("/api/video/jobs", submit), web.post("/api/video/jobs/{id}/cancel", cancel),
            web.get("/api/video/file/{id}", video), web.get("/api/video/report/{id}", report)]
