"""Blob transfer over an in-memory stream pair: whole, resumed after a drop, back-pressure, corruption.

Usage: python -m tests.test_blob
"""
import asyncio
import os
import tempfile
from pathlib import Path

from podtorrent import pipeline_pb2 as pb
from podtorrent.net import blob


class Pipe:
    """Two queues standing in for one QUIC stream. `cut_after` drops the holder after that many chunks."""

    def __init__(self, cut_after=None):
        self.up, self.down = asyncio.Queue(), asyncio.Queue()
        self.cut_after, self.sent, self.max_ahead = cut_after, 0, 0
        self.acked = 0

    async def holder_recv(self):
        b = await self.up.get()
        if b is None:
            raise asyncio.IncompleteReadError(b"", 4)
        self.acked = max(self.acked, pb.BlobAck.FromString(b).offset)
        return b

    def holder_send(self, b):
        c = pb.BlobChunk.FromString(b)
        self.max_ahead = max(self.max_ahead, c.offset + len(c.data) - self.acked)
        self.sent += 1
        if self.cut_after is not None and self.sent > self.cut_after:
            self.down.put_nowait(None)
            raise ConnectionError("cut")
        self.down.put_nowait(b)

    async def puller_recv(self):
        b = await self.down.get()
        if b is None:
            raise asyncio.IncompleteReadError(b"", 4)
        return b


async def main():
    tmp = Path(tempfile.mkdtemp(prefix="podtorrent-blob-"))
    store = blob.BlobStore(tmp / "store")
    data = os.urandom(20 * blob.CHUNK + 12345)
    sha, size = store.put_bytes(data)
    fails = 0

    def check(ok, msg):
        nonlocal fails
        fails += not ok
        print(f"{'PASS' if ok else 'FAIL'} {msg}", flush=True)

    def opener(cuts):
        pipes = []

        async def open_call(first):
            p = Pipe(cuts.pop(0) if cuts else None)
            pipes.append(p)
            p.up.put_nowait(first)

            async def run():
                try:
                    await blob.serve(store, await p.up.get(), p.holder_recv, p.holder_send)
                except ConnectionError:
                    pass
            asyncio.ensure_future(run())
            return p.puller_recv, p.up.put_nowait, lambda: p.up.put_nowait(None)
        return open_call, pipes

    # whole
    open_call, pipes = opener([])
    dest = tmp / "a.bin"
    await blob.fetch(open_call, sha, size, dest)
    check(dest.read_bytes() == data, "whole blob arrives intact")
    check(pipes[0].max_ahead <= blob.WINDOW + blob.CHUNK, f"holder stays within the window ({pipes[0].max_ahead >> 20} MB ahead)")

    # dropped twice, resumes
    open_call, pipes = opener([5, 7])
    dest = tmp / "b.bin"
    await blob.fetch(open_call, sha, size, dest)
    check(dest.read_bytes() == data, "blob intact after two dropped connections")
    check(len(pipes) == 3, f"three tries ({len(pipes)})")

    # resume starts where the .part ended
    seen = []
    orig = blob.serve

    async def spy(store_, first, recv, send):
        seen.append(pb.BlobAck.FromString(first).offset)
        await orig(store_, first, recv, send)
    blob.serve = spy
    open_call, pipes = opener([3])
    await blob.fetch(open_call, sha, size, tmp / "c.bin")
    blob.serve = orig
    check(seen[0] == 0 and seen[1] == 3 * blob.CHUNK, f"second try resumes at 3 MB (asked for {seen})")

    # corruption: a bad .part of the right size is thrown away and fetched again
    dest = tmp / "d.bin"
    dest.with_name("d.bin.part").write_bytes(os.urandom(size))
    open_call, pipes = opener([])
    await blob.fetch(open_call, sha, size, dest)
    check(dest.read_bytes() == data, "corrupted .part is detected and replaced")

    # missing blob
    open_call, _ = opener([])
    try:
        await blob.fetch(open_call, "0" * 64, 10, tmp / "e.bin")
        check(False, "missing blob raises")
    except FileNotFoundError:
        check(True, "missing blob raises FileNotFoundError")

    print("OK" if not fails else f"{fails} FAILED")
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    asyncio.run(main())
