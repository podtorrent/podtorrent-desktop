"""Video jobs on this machine: installs and drives a headless ComfyUI that renders MiniMax-H3.

Everything lives under ~/.podtorrent/video/:
    ComfyUI-<ver>/   pinned ComfyUI sources        venv/     its own Python (CUDA PyTorch)
    models/          the H3 weights (~44 GB)       outputs/  <job>.mp4 + <job>.json (diagnostics)
    comfyui.log      ComfyUI's output              jobs.json job history

Release 1 is local only: the machine that asks is the machine that renders. Set
PODTORRENT_VIDEO_FAKE=1 to simulate setup and jobs without a GPU (UI work on a Mac).
"""

from __future__ import annotations

import asyncio
import json
import os
import platform
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Callable

import aiohttp

from ..net.identity import home
from . import h3

COMFY_PORT = 8188
COMFY = f"http://127.0.0.1:{COMFY_PORT}"
COMFY_ZIP = f"https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/{h3.COMFY_VERSION}.zip"
# ComfyUI's fast CUDA kernels (comfy-kitchen) need CUDA 13 PyTorch, which needs NVIDIA driver 580+.
# Older drivers fall back to CUDA 12.8 and the slow reference kernels.
TORCH_INDEX = "https://download.pytorch.org/whl/{cuda}"
MIN_DRIVER_CU130 = 580
MIN_VRAM_GB = 11.0      # a "12 GB" card reports ~11.9
MIN_RAM_GB = 31.0       # ComfyUI parks the 21 GB video model and 16 GB encoder in RAM
DISK_SPARE_GB = 15.0    # ComfyUI + venv + outputs
FAKE = os.environ.get("PODTORRENT_VIDEO_FAKE") == "1"
WIN = sys.platform == "win32"


def _gb(n: float) -> float:
    return round(n / 1024**3, 1)


def _ssl():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def driver_major() -> int | None:
    smi = shutil.which("nvidia-smi")
    if not smi:
        return None
    try:
        out = subprocess.run([smi, "--query-gpu=driver_version", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
        return int(out[0].split(".")[0]) if out else None
    except Exception:  # noqa: BLE001
        return None


def cuda_build() -> str:
    d = driver_major()
    return "cu130" if FAKE or d is None or d >= MIN_DRIVER_CU130 else "cu128"


def gpu_info() -> dict:
    """{name, vram_gb, driver} for the first CUDA GPU, or {error}. Uses the engine's PyTorch when present."""
    if FAKE:
        return {"name": "Simulated RTX 5070", "vram_gb": 11.9, "driver": 581}
    try:
        import torch
        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            return {"name": p.name, "vram_gb": _gb(p.total_memory), "driver": driver_major()}
    except Exception:  # noqa: BLE001 - no torch (Apple Silicon) or a broken driver
        pass
    smi = shutil.which("nvidia-smi")
    if smi:
        try:
            out = subprocess.run([smi, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=10).stdout.strip().splitlines()
            if out:
                name, mib = [x.strip() for x in out[0].split(",")]
                return {"name": name, "vram_gb": round(float(mib) / 1024, 1), "driver": driver_major()}
        except Exception:  # noqa: BLE001
            pass
    return {"error": "No NVIDIA GPU found"}


def ram_gb() -> float:
    if FAKE:
        return 64.0
    try:
        import psutil
        return _gb(psutil.virtual_memory().total)
    except ImportError:
        return 0.0


def keep_awake(on: bool):
    """Stop Windows sleeping mid-render (a sleeping PC stalled one step for 50 minutes)."""
    if WIN:
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))


class VideoService:
    def __init__(self, emit: Callable, node: str):
        self.emit, self.node = emit, node
        self.root = home() / "video"
        self.comfy_dir = self.root / f"ComfyUI-{h3.COMFY_VERSION.lstrip('v')}"
        self.venv = self.root / "venv"
        self.models = self.root / "models"
        self.outputs = self.root / "outputs"
        self.gpu = gpu_info()
        self.cuda = cuda_build()
        self.install_id = f"{h3.COMFY_VERSION}+{self.cuda}"
        self.ram = ram_gb()
        self.setup_state = {"phase": "idle", "done": 0, "total": 0, "message": ""}
        self.setup_task: asyncio.Task | None = None
        self.jobs: dict[str, dict] = self._load_jobs()
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.worker: asyncio.Task | None = None
        self.proc: subprocess.Popen | None = None
        self.running: str | None = None
        self.cancelled: set[str] = set()

    # ---------- state ----------
    def _load_jobs(self) -> dict:
        try:
            jobs = json.loads((self.root / "jobs.json").read_text())
        except (OSError, ValueError):
            return {}
        for j in jobs.values():  # anything unfinished died with the last engine
            if j["state"] not in ("done", "failed", "cancelled"):
                j.update(state="failed", error="The engine stopped before this finished.")
        return jobs

    def _save_jobs(self):
        self.root.mkdir(parents=True, exist_ok=True)
        keep = sorted(self.jobs.values(), key=lambda j: j["created"])[-50:]
        (self.root / "jobs.json").write_text(json.dumps({j["id"]: j for j in keep}, indent=1))

    def _python(self) -> Path:
        return self.venv / ("Scripts/python.exe" if WIN else "bin/python")

    def _missing_bytes(self) -> int:
        return sum(max(0, size - self._have(folder, name)) for folder, name, size in h3.FILES)

    def _have(self, folder: str, name: str) -> int:
        f = self.models / folder / name
        if f.exists():
            return f.stat().st_size
        p = f.with_name(name + ".part")
        return p.stat().st_size if p.exists() else 0

    def installed(self) -> bool:
        if FAKE:
            return self.setup_state["phase"] == "ready"
        return ((self.root / ".installed").read_text().strip() == self.install_id
                if (self.root / ".installed").exists() else False)

    def models_ready(self) -> bool:
        if FAKE:
            return self.setup_state["phase"] == "ready"
        return all((self.models / folder / name).exists() for folder, name, _ in h3.FILES)

    def capability(self) -> dict:
        """Can this machine render? {ok, reason, warn}."""
        if "error" in self.gpu:
            return {"ok": False, "reason": "Video needs a machine with an NVIDIA GPU (12 GB or more). "
                    "Support for running it on other machines in the swarm is coming."}
        if self.gpu["vram_gb"] < MIN_VRAM_GB:
            return {"ok": False, "reason": f"{self.gpu['name']} has {self.gpu['vram_gb']} GB of GPU memory; video needs 12 GB or more."}
        if self.ram and self.ram < MIN_RAM_GB:
            return {"ok": False, "reason": f"This machine has {self.ram} GB of RAM; video needs 32 GB or more."}
        self.root.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(self.root).free
        need = 0 if FAKE else self._missing_bytes() + (0 if self.installed() else DISK_SPARE_GB * 1024**3)
        if need > free:
            return {"ok": False, "reason": f"Not enough disk space: needs {_gb(need)} GB more, {_gb(free)} GB free on {self.root.anchor or '/'}."}
        warn = " ".join(w for w in (
            "With less than 48 GB of RAM, clips take longer." if self.ram and self.ram < 47 else "",
            f"Update your NVIDIA driver (580 or newer) for much faster video." if self.cuda != "cu130" else "") if w)
        return {"ok": True, "reason": "", "warn": warn}

    def status(self) -> dict:
        return {"gpu": self.gpu, "ram_gb": self.ram, "capability": self.capability(),
                "installed": self.installed(), "models_ready": self.models_ready(),
                "models_gb": _gb(h3.MODELS_BYTES), "missing_gb": 0 if FAKE else _gb(self._missing_bytes()),
                "setup": self.setup_state, "fake": FAKE, "folder": str(self.root),
                "update": self.models_ready() and not self.installed() and (self.root / ".installed").exists(),
                "presets": h3.PRESETS, "modes": h3.MODES, "min_seconds": h3.MIN_SECONDS, "max_seconds": h3.MAX_SECONDS, "jobs": sorted(self.jobs.values(), key=lambda j: -j["created"])}

    def _setup_event(self, phase: str, done: float = 0, total: float = 0, message: str = ""):
        self.setup_state = {"phase": phase, "done": done, "total": total, "message": message}
        self.emit("video_setup", key="video_setup", **self.setup_state,
                  installed=self.installed(), models_ready=self.models_ready())

    def _job_event(self, job: dict, **changes):
        job.update(changes)
        self.emit("video_job", key=f"video:{job['id']}", **job)
        if job["state"] in ("done", "failed", "cancelled") or "state" in changes:
            self._save_jobs()

    # ---------- setup: ComfyUI + Python + weights ----------
    def start_setup(self) -> dict:
        if self.setup_task and not self.setup_task.done():
            return self.setup_state
        cap = self.capability()
        if not cap["ok"]:
            raise RuntimeError(cap["reason"])
        self.setup_task = asyncio.ensure_future(self._setup())
        return self.setup_state

    async def _setup(self):
        try:
            if FAKE:
                for i in range(1, 21):
                    self._setup_event("models", i * h3.MODELS_BYTES / 20, h3.MODELS_BYTES, "Downloading the video model (simulated)")
                    await asyncio.sleep(0.25)
            else:
                await asyncio.to_thread(self._install)
                await asyncio.to_thread(self._download_models)
            self._setup_event("ready", message="Ready")
        except Exception as e:  # noqa: BLE001 - surfaced to the UI, retry restarts where it stopped
            self._setup_event("error", message=str(e) or type(e).__name__)

    def _install(self):
        if self.installed():
            return
        self.root.mkdir(parents=True, exist_ok=True)
        if not (self.comfy_dir / "main.py").exists():
            self._setup_event("install", message="Downloading ComfyUI")
            z = self.root / "comfyui.zip"
            self._fetch(COMFY_ZIP, z, label="Downloading ComfyUI")
            with zipfile.ZipFile(z) as zf:
                zf.extractall(self.root)
            z.unlink()
        uv = os.environ.get("UV") or shutil.which("uv")
        if not uv:
            raise RuntimeError("uv not found (it ships with the app; reinstall PodTorrent)")
        env = {**os.environ, "VIRTUAL_ENV": ""}
        steps = [
            ("Creating the video Python environment", [uv, "venv", str(self.venv), "--python", "3.12", "--allow-existing"]),
            # Torch first from the CUDA index (the engine already cached it); then ComfyUI's own
            # requirements, which see torch as satisfied instead of pulling the CPU build from PyPI.
            ("Installing PyTorch for your GPU", [uv, "pip", "install", "--python", str(self._python()),
                                                  "torch", "torchvision", "torchaudio", "--index-url", TORCH_INDEX.format(cuda=self.cuda),
                                                  # replace an older CUDA build left by a previous install
                                                  "--reinstall-package", "torch", "--reinstall-package", "torchvision",
                                                  "--reinstall-package", "torchaudio"]),
            ("Installing ComfyUI", [uv, "pip", "install", "--python", str(self._python()),
                                    "-r", str(self.comfy_dir / "requirements.txt")]),
        ]
        with open(self.root / "install.log", "a", encoding="utf-8") as log:
            for i, (msg, cmd) in enumerate(steps):
                self._setup_event("install", i, len(steps), msg)
                log.write(f"\n$ {' '.join(cmd)}\n")
                log.flush()
                r = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, env=env,
                                   creationflags=subprocess.CREATE_NO_WINDOW if WIN else 0)
                if r.returncode:
                    raise RuntimeError(f"{msg} failed (see {self.root / 'install.log'})")
        (self.root / "extra_model_paths.yaml").write_text(
            "podtorrent:\n"
            f"  base_path: {self.models.as_posix()}\n"
            + "".join(f"  {d}: {d}\n" for d in sorted({f[0] for f in h3.FILES})))
        (self.root / ".installed").write_text(self.install_id)

    def _download_models(self):
        total = h3.MODELS_BYTES
        base = total - self._missing_bytes()
        for folder, name, size in h3.FILES:
            dest = self.models / folder / name
            if dest.exists():
                continue
            url = f"https://huggingface.co/{h3.REPO}/resolve/main/{folder}/{name}"
            start = base - self._have(folder, name)
            self._fetch(url, dest, label="Downloading the video model",
                        progress=lambda got, _s=start: self._setup_event("models", _s + got, total, "Downloading the video model"))
            base = start + dest.stat().st_size

    def _fetch(self, url: str, dest: Path, label: str, progress: Callable[[int], None] | None = None):
        """Resumable download to dest (via dest.part). progress(bytes_of_this_file_so_far)."""
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        for attempt in range(6):
            have = part.stat().st_size if part.exists() else 0
            req = urllib.request.Request(url, headers={"User-Agent": "podtorrent", **({"Range": f"bytes={have}-"} if have else {})})
            try:
                with urllib.request.urlopen(req, context=_ssl(), timeout=60) as r:
                    if have and r.status != 206:  # server ignored the range: start over
                        have = 0
                    mode = "ab" if have else "wb"
                    with open(part, mode) as f:
                        last = 0.0
                        while chunk := r.read(8 << 20):
                            f.write(chunk)
                            have += len(chunk)
                            if progress and time.monotonic() - last > 1:
                                last = time.monotonic()
                                progress(have)
                if r.status == 416 or have:  # 416: already complete
                    os.replace(part, dest)
                    if progress:
                        progress(have)
                    return
            except urllib.error.HTTPError as e:
                if e.code == 416 and part.exists():
                    os.replace(part, dest)
                    return
                if attempt == 5 or e.code in (401, 403, 404):
                    raise RuntimeError(f"{label}: HTTP {e.code}") from e
            except OSError as e:
                if attempt == 5:
                    raise RuntimeError(f"{label}: {e}") from e
            time.sleep(min(30, 2 ** attempt))

    # ---------- ComfyUI process ----------
    async def _ensure_comfy(self, job: dict):
        if FAKE:
            return
        if self.proc and self.proc.poll() is None and await self._comfy_up():
            return
        self._job_event(job, state="starting", detail="Starting the video engine")
        out = self.outputs / "comfy"
        out.mkdir(parents=True, exist_ok=True)
        cmd = [str(self._python()), "main.py", "--listen", "127.0.0.1", "--port", str(COMFY_PORT),
               "--disable-auto-launch", "--output-directory", str(out),
               "--extra-model-paths-config", str(self.root / "extra_model_paths.yaml")]
        log = open(self.root / "comfyui.log", "w", encoding="utf-8")
        self.proc = subprocess.Popen(cmd, cwd=self.comfy_dir, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                     creationflags=subprocess.CREATE_NO_WINDOW if WIN else 0)
        for _ in range(600):  # first start compiles/caches kernels; be patient
            if self.proc.poll() is not None:
                raise RuntimeError(f"The video engine exited at startup (see {self.root / 'comfyui.log'})")
            if await self._comfy_up():
                return
            await asyncio.sleep(1)
        raise RuntimeError("The video engine didn't start within 10 minutes")

    async def _comfy_up(self) -> bool:
        try:
            async with aiohttp.ClientSession() as s, s.get(COMFY + "/system_stats", timeout=aiohttp.ClientTimeout(total=2)) as r:
                return r.status == 200
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            return False

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    # ---------- jobs ----------
    def submit(self, prompt: str, preset: str, seconds: float, seed: int | None, mode: str = "best") -> dict:
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("Write a prompt first")
        if preset not in h3.PRESETS:
            raise ValueError(f"unknown preset {preset!r}")
        if mode not in h3.MODES:
            raise ValueError(f"unknown mode {mode!r}")
        if not (self.installed() and self.models_ready()):
            raise RuntimeError("Set up video on this machine first")
        seconds = min(h3.MAX_SECONDS, max(h3.MIN_SECONDS, float(seconds)))
        p = h3.PRESETS[preset]
        job = {"id": uuid.uuid4().hex[:10], "node": self.node, "prompt": prompt[:4000], "preset": preset,
               "width": p["width"], "height": p["height"], "seconds": seconds, "frames": h3.frames_for(seconds), "mode": mode,
               "seed": seed if seed is not None else int.from_bytes(os.urandom(6), "big"),
               "state": "queued", "detail": "Waiting", "step": 0, "steps": h3.MODES[mode]["steps"],
               "created": time.time(), "started": None, "finished": None, "error": "", "video": None, "fake": FAKE}
        self.jobs[job["id"]] = job
        self._job_event(job)
        self.queue.put_nowait(job["id"])
        if not self.worker or self.worker.done():
            self.worker = asyncio.ensure_future(self._work())
        return job

    async def cancel(self, jid: str) -> dict:
        job = self.jobs.get(jid)
        if not job:
            raise KeyError(jid)
        if job["state"] in ("done", "failed", "cancelled"):
            return job
        self.cancelled.add(jid)
        if self.running == jid and not FAKE:
            try:
                async with aiohttp.ClientSession() as s:
                    await s.post(COMFY + "/interrupt", json={})
            except aiohttp.ClientError:
                pass
        if self.running != jid:
            self._job_event(job, state="cancelled", detail="Cancelled", finished=time.time())
        return job

    async def _work(self):
        keep_awake(True)
        try:
            await self._drain()
        finally:
            keep_awake(False)

    async def _drain(self):
        while not self.queue.empty():
            jid = await self.queue.get()
            job = self.jobs.get(jid)
            if not job or jid in self.cancelled and job["state"] == "cancelled":
                continue
            self.running = jid
            diag = {"job": jid, "machine": self._machine(), "stages": {}, "step_seconds": []}
            t0 = time.time()
            self._job_event(job, state="starting", detail="Starting", started=t0)
            try:
                await self._ensure_comfy(job)
                diag["stages"]["engine_start_s"] = round(time.time() - t0, 1)
                await (self._run_fake(job, diag) if FAKE else self._run_comfy(job, diag))
                if jid in self.cancelled:
                    self._job_event(job, state="cancelled", detail="Cancelled", finished=time.time())
                else:
                    self._job_event(job, state="done", detail="Done", finished=time.time())
            except Exception as e:  # noqa: BLE001 - one bad job must not stop the queue
                self._job_event(job, state="cancelled" if jid in self.cancelled else "failed",
                                detail="Cancelled" if jid in self.cancelled else "Failed",
                                error="" if jid in self.cancelled else (str(e) or type(e).__name__), finished=time.time())
            finally:
                self.running = None
                diag.update(state=job["state"], error=job["error"], total_s=round(time.time() - t0, 1),
                            settings={k: job.get(k) for k in ("preset", "mode", "width", "height", "seconds", "frames", "seed", "steps")},
                            prompt_chars=len(job["prompt"]))
                st = diag["step_seconds"]
                if st:
                    diag["sec_per_step"] = round(sum(st) / len(st), 2)
                self.outputs.mkdir(parents=True, exist_ok=True)
                (self.outputs / f"{jid}.json").write_text(json.dumps(diag, indent=2, default=str))

    def _machine(self) -> dict:
        return {"os": platform.platform(), "gpu": self.gpu, "ram_gb": self.ram, "cpu_cores": os.cpu_count(),
                "comfyui": h3.COMFY_VERSION, "torch_cuda": self.cuda, "weights": [f[1] for f in h3.FILES], "fake": FAKE}

    async def _run_fake(self, job: dict, diag: dict):
        for stage, secs in (("loading", 1.5), ("encoding", 1.5)):
            self._job_event(job, state=stage, detail=stage.capitalize())
            await asyncio.sleep(secs)
        n = job["steps"]
        for i in range(1, n + 1):
            if job["id"] in self.cancelled:
                return
            self._job_event(job, state="generating", detail=f"Step {i} of {n}", step=i)
            await asyncio.sleep(0.8)
            diag["step_seconds"].append(0.8)
        self._job_event(job, state="decoding", detail="Decoding frames and audio")
        await asyncio.sleep(1.5)

    async def _run_comfy(self, job: dict, diag: dict):
        cid = uuid.uuid4().hex
        prefix = f"podtorrent/{job['id']}"
        g = h3.graph(job["prompt"], job["width"], job["height"], job["seconds"], job["seed"], prefix, job.get("mode", "best"))
        peak = {"vram_used_gb": 0.0, "ram_rss_gb": 0.0}
        stage_t = {"name": None, "t": time.time()}
        last_step = [time.time()]

        def stage(name: str, detail: str):
            if name != stage_t["name"]:
                if stage_t["name"]:
                    k = f"{stage_t['name']}_s"
                    diag["stages"][k] = round(diag["stages"].get(k, 0) + time.time() - stage_t["t"], 1)
                stage_t.update(name=name, t=time.time())
            self._job_event(job, state=name, detail=detail)

        async def sample_memory():
            try:
                import psutil
                proc = psutil.Process(self.proc.pid) if self.proc else None
            except Exception:  # noqa: BLE001
                proc = None
            async with aiohttp.ClientSession() as s:
                while True:
                    try:
                        async with s.get(COMFY + "/system_stats") as r:
                            d = (await r.json())["devices"][0]
                            peak["vram_used_gb"] = max(peak["vram_used_gb"], _gb(d["vram_total"] - d["vram_free"]))
                        if proc:  # on Windows the venv's python.exe is a launcher; the real one is its child
                            rss = sum(p.memory_info().rss for p in [proc, *proc.children(recursive=True)])
                            peak["ram_rss_gb"] = max(peak["ram_rss_gb"], _gb(rss))
                    except Exception:  # noqa: BLE001 - best effort
                        pass
                    await asyncio.sleep(2)

        sampler = asyncio.ensure_future(sample_memory())
        try:
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(f"{COMFY}/ws?clientId={cid}", max_msg_size=0) as ws:
                    async with s.post(COMFY + "/prompt", json={"prompt": g, "client_id": cid}) as r:
                        body = await r.json(content_type=None)
                        if r.status != 200:
                            raise RuntimeError(_comfy_error(body))
                        pid = body["prompt_id"]
                    stage("loading", "Loading the video model")
                    async for msg in ws:
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue  # binary = preview images
                        ev = json.loads(msg.data)
                        d = ev.get("data", {})
                        if d.get("prompt_id") not in (None, pid):
                            continue
                        t = ev.get("type")
                        if t == "executing" and d.get("node"):
                            name = h3.STAGE.get(d["node"])
                            if name and name != "generating":
                                stage(name, {"loading": "Loading the video model", "encoding": "Reading your prompt",
                                             "decoding": "Decoding frames and audio", "saving": "Saving the video"}[name])
                            if name == "generating":
                                last_step[0] = time.time()
                        elif t == "progress" and d.get("node") == "sample":
                            now = time.time()
                            diag["step_seconds"].append(round(now - last_step[0], 2))
                            last_step[0] = now
                            stage("generating", f"Step {d['value']} of {d['max']}")
                            self._job_event(job, step=d["value"], steps=d["max"])
                        elif t == "execution_error":
                            raise RuntimeError(f"{d.get('exception_type', 'Error')}: {d.get('exception_message', '').strip()}"[:500])
                        elif t == "execution_interrupted":
                            return
                        elif t == "execution_success" or (t == "executing" and d.get("node") is None):
                            break
                stage("saving", "Saving the video")
                async with s.get(f"{COMFY}/history/{pid}") as r:
                    hist = (await r.json()).get(pid, {})
            src = _output_file(hist, self.outputs / "comfy")
            if not src:
                raise RuntimeError("The video engine finished but saved no video")
            dest = self.outputs / f"{job['id']}.mp4"
            shutil.move(str(src), dest)
            job["video"] = dest.name
            stage("done", "Done")
        finally:
            sampler.cancel()
            diag.update(peak)


def _comfy_error(body) -> str:
    if isinstance(body, dict):
        err = body.get("error", {})
        msg = err.get("message", "") if isinstance(err, dict) else str(err)
        nodes = body.get("node_errors") or {}
        details = "; ".join(f"{n}: {e.get('message', '')} {e.get('details', '')}".strip()
                            for v in nodes.values() for e in v.get("errors", []) for n in [v.get("class_type", "?")])
        return f"The video engine rejected the job: {msg} {details}".strip()[:600]
    return f"The video engine rejected the job: {body}"[:600]


def _output_file(hist: dict, out: Path) -> Path | None:
    for node_out in hist.get("outputs", {}).values():
        for items in node_out.values():
            if not isinstance(items, list):
                continue
            for it in items:
                if isinstance(it, dict) and str(it.get("filename", "")).endswith((".mp4", ".webm", ".mkv")):
                    f = out / it.get("subfolder", "") / it["filename"]
                    if f.exists():
                        return f
    return None
