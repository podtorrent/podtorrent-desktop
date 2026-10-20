"""Blobs between peers: hidden states, MP4s and (later) images, pulled over one QUIC stream.

A blob's id is its SHA-256. The holder keeps it in a `BlobStore`; whoever needs it pulls it with
the Blob RPC (method M_BLOB):

    puller → BlobAck{sha256, offset}          where to start: the size of our .part file (resume)
    holder → BlobChunk{offset, data} ...      CHUNK bytes each, never more than WINDOW ahead of
    puller → BlobAck{offset} ...              the last ack (back-pressure)
    holder → (end of stream)                  once size is reached

A dropped connection leaves the .part file; the next try asks for the rest. The SHA-256 is checked
over the whole file before it's renamed into place.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
from pathlib import Path
from typing import Awaitable, Callable

from .. import pipeline_pb2 as pb

CHUNK = 1 << 20
WINDOW = 8 << 20
STALL_S = 30          # no chunk for this long: give up on this try
RETRIES = 5

Recv = Callable[[], Awaitable[bytes]]
Send = Callable[[bytes], None]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while b := f.read(CHUNK):
            h.update(b)
    return h.hexdigest()


class BlobStore:
    """Blobs this peer can hand out, as files named by their SHA-256."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def path(self, sha: str) -> Path:
        if len(sha) != 64 or not all(c in "0123456789abcdef" for c in sha):
            raise ValueError("bad blob id")
        return self.root / sha

    def has(self, sha: str) -> bool:
        try:
            return self.path(sha).exists()
        except ValueError:
            return False

    def put_bytes(self, data: bytes) -> tuple[str, int]:
        sha = hashlib.sha256(data).hexdigest()
        self.root.mkdir(parents=True, exist_ok=True)
        p = self.path(sha)
        if not p.exists():
            tmp = p.with_name(sha + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, p)
        return sha, len(data)

    def put_file(self, src: Path) -> tuple[str, int]:
        sha = sha256_file(src)
        self.root.mkdir(parents=True, exist_ok=True)
        p = self.path(sha)
        if not p.exists():
            tmp = p.with_name(sha + ".tmp")
            shutil.copyfile(src, tmp)
            os.replace(tmp, p)
        return sha, p.stat().st_size


async def serve(store: BlobStore, first: bytes, recv: Recv, send: Send):
    """Holder side of one Blob call. `first` is the puller's opening BlobAck."""
    req = pb.BlobAck.FromString(first)
    try:
        path = store.path(req.sha256)
        size = path.stat().st_size
    except (ValueError, OSError):
        send(pb.BlobChunk(sha256=req.sha256, error="this peer doesn't have that blob").SerializeToString())
        return
    acked = [req.offset]
    moved = asyncio.Event()

    async def read_acks():
        try:
            while True:
                acked[0] = max(acked[0], pb.BlobAck.FromString(await recv()).offset)
                moved.set()
        except (asyncio.IncompleteReadError, ConnectionError, ValueError):
            moved.set()

    acks = asyncio.ensure_future(read_acks())
    try:
        with open(path, "rb") as f:
            off = req.offset
            f.seek(off)
            while off < size:
                while off - acked[0] >= WINDOW:
                    if acks.done():
                        return  # puller went away
                    moved.clear()
                    await asyncio.wait_for(moved.wait(), STALL_S)
                data = f.read(CHUNK)
                send(pb.BlobChunk(sha256=req.sha256, offset=off, data=data, size=size).SerializeToString())
                off += len(data)
                await asyncio.sleep(0)
        # Wait for the last ack so the stream isn't torn down under the final chunks.
        while acked[0] < size and not acks.done():
            moved.clear()
            await asyncio.wait_for(moved.wait(), STALL_S)
    finally:
        acks.cancel()


async def pull_once(sha: str, size: int, dest: Path, recv: Recv, send: Send,
                    progress: Callable[[int, int], None] | None = None) -> None:
    """One try: append to dest.part from where it stopped. Raises on a dropped stream."""
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    if have > size:
        part.unlink()
        have = 0
    send(pb.BlobAck(sha256=sha, offset=have).SerializeToString())
    with open(part, "ab") as f:
        while have < size:
            c = pb.BlobChunk.FromString(await asyncio.wait_for(recv(), STALL_S))
            if c.error:
                raise FileNotFoundError(c.error)
            if c.offset != have or c.size != size:
                raise ConnectionError(f"blob out of step: got offset {c.offset}, expected {have}")
            f.write(c.data)
            have += len(c.data)
            send(pb.BlobAck(sha256=sha, offset=have).SerializeToString())
            if progress:
                progress(have, size)


def finish(sha: str, dest: Path):
    """Check the finished .part against its SHA-256 and move it into place."""
    part = dest.with_name(dest.name + ".part")
    got = sha256_file(part)
    if got != sha:
        part.unlink()
        raise ValueError(f"blob {sha[:12]} arrived corrupted (sha256 {got[:12]}); it will be fetched again")
    os.replace(part, dest)


async def fetch(open_call: Callable[[bytes], Awaitable[tuple[Recv, Send, Callable[[], None]]]],
                sha: str, size: int, dest: Path, progress: Callable[[int, int], None] | None = None,
                retries: int = RETRIES) -> Path:
    """Pull a blob into dest, resuming across dropped connections.

    `open_call(first_frame)` opens a fresh Blob call (reconnecting if needed) with `first_frame` as
    its first frame, and returns (recv, send, close)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size == size:
        return dest
    last: Exception | None = None
    for attempt in range(retries + 1):
        close = None
        try:
            part = dest.with_name(dest.name + ".part")
            have = part.stat().st_size if part.exists() else 0
            recv, send, close = await open_call(pb.BlobAck(sha256=sha, offset=have if have <= size else 0).SerializeToString())
            await pull_once(sha, size, dest, recv, _skip_first(send), progress)
            finish(sha, dest)
            return dest
        except FileNotFoundError:
            raise
        except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, ValueError, OSError) as e:
            last = e
            if attempt < retries:
                await asyncio.sleep(min(10, 0.5 * 2 ** attempt))
        finally:
            if close:
                close()
    raise ConnectionError(f"couldn't fetch blob {sha[:12]} after {retries + 1} tries: {last}")


def _skip_first(send: Send) -> Send:
    """pull_once opens with an ack that open_call already sent; drop that one."""
    state = {"first": True}

    def s(body: bytes):
        if state["first"]:
            state["first"] = False
            return
        send(body)
    return s
