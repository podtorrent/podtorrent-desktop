"""Phase 2 exit test: a video job on A goes through fake encoder halves on B and C and a fake video
worker on C, and the MP4 comes back to A over QUIC.

Usage: python -m tests.video_swarm [--port 8300]

Three peers, each with its own identity and home, find each other through the rendezvous:
    A: requester, no roles      B: h3-encoder:0:25      C: h3-encoder:25:50, h3-video
Checks the route, the job's stages, that the MP4 on A matches the placeholder byte for byte, the
report, and that cancelling a job mid-render stops it on C.
"""
import argparse
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from tests.golden import http

PLACEHOLDER = Path(__file__).resolve().parents[1] / "podtorrent" / "video" / "placeholder.mp4"


def wait(what, fn, timeout):
    t = time.time()
    while time.time() - t < timeout:
        if (r := fn()):
            return r
        time.sleep(1)
    raise SystemExit(f"timed out waiting for {what}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8300)
    a = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix="podtorrent-video-"))
    roles = {"A": "", "B": "h3-encoder:0:25", "C": "h3-encoder:25:50,h3-video"}
    procs, bases = {}, {}
    for i, (name, r) in enumerate(roles.items()):
        env = {**os.environ, "PODTORRENT_HOME": str(tmp / name), "PODTORRENT_NAME": f"vt{name}",
               "PODTORRENT_VIDEO_FAKE_ROLES": r, "PODTORRENT_VIDEO_FAKE_STEP_S": "0.2"}
        procs[name] = subprocess.Popen([sys.executable, "-m", "podtorrent.cli", "peer", "--port", str(a.port + i)],
                                       env=env, stdout=open(tmp / f"{name}.log", "w"), stderr=subprocess.STDOUT)
        bases[name] = f"http://127.0.0.1:{a.port + i}"
    print(f"peers: {roles} (logs in {tmp})", flush=True)
    A = bases["A"]
    fails = 0

    def check(ok, msg):
        nonlocal fails
        fails += not ok
        print(f"{'PASS' if ok else 'FAIL'} {msg}", flush=True)

    def swarm():
        try:
            s = http(A + "/api/video/swarm", timeout=3)
        except OSError:
            return None
        return s if s.get("route") else None

    try:
        s = wait("a full video route on A", swarm, 180)
        print(f"  route: {s['route']}")
        check(s["route"] == {"encoder": [["vtB", 0, 25], ["vtC", 25, 50]], "video": "vtC"}, "A routes B → C, renders on C")

        job = http(A + "/api/video/swarm/jobs", {"prompt": "A red fox runs through snow at dawn.", "mode": "fast"})
        check("id" in job, f"job accepted ({job.get('error') or job.get('id')})")
        seen = set()

        def finished():
            j = http(A + "/api/video/status")["jobs"]
            j = next(x for x in j if x["id"] == job["id"])
            seen.add(j["state"])
            return j if j["state"] in ("done", "failed", "cancelled") else None
        j = wait("job to finish", finished, 120)
        check(j["state"] == "done", f"job done ({j['state']}: {j.get('error')})")
        check({"encoding", "generating"} <= seen, f"saw encoding and generating ({sorted(seen)})")
        mp4 = (tmp / "A" / "video" / "outputs" / f"{job['id']}.mp4")
        check(mp4.exists() and mp4.read_bytes() == PLACEHOLDER.read_bytes(), "the MP4 on A matches C's placeholder")
        rep = http(A + f"/api/video/report/{job['id']}")
        stages = [s["stage"] for s in rep.get("stages", [])]
        check(stages == ["encode", "encode", "render", "fetch"], f"report lists the stages ({stages})")
        enc = rep["stages"][1]
        check(enc["shape"][2] == 5120 and enc["out_bytes"] == 4 * 5120 * enc["shape"][1], f"hidden state shape {enc['shape']}")

        job = http(A + "/api/video/swarm/jobs", {"prompt": "Waves at night.", "mode": "best"})

        def rendering():
            j = next(x for x in http(A + "/api/video/status")["jobs"] if x["id"] == job["id"])
            return j if j["state"] == "generating" and j["step"] >= 2 else None
        wait("second job to render", rendering, 120)
        http(A + f"/api/video/jobs/{job['id']}/cancel", {})
        j = wait("cancel", finished, 30)
        check(j["state"] == "cancelled", f"cancelled mid-render ({j['state']})")
        check(not (tmp / "A" / "video" / "outputs" / f"{job['id']}.mp4").exists(), "no MP4 for the cancelled job")
    finally:
        for p in procs.values():
            p.terminate()
        for p in procs.values():
            p.wait(10)
    print("OK" if not fails else f"{fails} FAILED")
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    main()
