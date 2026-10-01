"""Host engine: tokenizer, embeddings, first layers, remote call, lm_head, greedy sampling."""
import queue
import time
import uuid
from dataclasses import dataclass

import grpc
import mlx.core as mx

from . import pipeline_pb2 as pb
from . import pipeline_pb2_grpc as rpc
from .shard import Shard
from .worker import from_wire, to_wire


@dataclass
class TokenEvent:
    token: int
    text: str
    host_ms: float      # local layers + head
    worker_ms: float    # reported by worker
    network_ms: float   # round trip minus worker compute
    bytes_sent: int
    logits: mx.array | None = None


class _Stream:
    """Persistent bidirectional Forward stream."""
    def __init__(self, stub):
        self.q = queue.Queue()
        self.responses = stub.Forward(iter(self.q.get, None), wait_for_ready=True)

    def call(self, req):
        self.q.put(req)
        return next(self.responses)

    def send(self, req):
        self.q.put(req)


class Host:
    def __init__(self, shard: Shard, tokenizer, worker_addr):
        self.shard = shard
        self.tok = tokenizer
        self.channel = grpc.insecure_channel(
            worker_addr, options=[("grpc.max_receive_message_length", 256 * 2**20),
                                  ("grpc.max_send_message_length", 256 * 2**20)])
        self.stub = rpc.PipelineStub(self.channel)
        self._stream = None

    @property
    def stream(self):
        # Opened lazily: a stream that fails to connect never retries.
        if self._stream is None:
            self._stream = _Stream(self.stub)
        return self._stream

    def info(self):
        return self.stub.Info(pb.InfoRequest())

    def _step(self, rid, ids, cache, keep_logits):
        t0 = time.perf_counter()
        h = self.shard.run_layers(self.shard.embed(ids), cache)
        mx.eval(h)
        host1 = (time.perf_counter() - t0) * 1000
        payload = to_wire(h)
        t1 = time.perf_counter()
        resp = self.stream.call(pb.ForwardRequest(request_id=rid, hidden=payload, shape=list(h.shape)))
        rtt = (time.perf_counter() - t1) * 1000
        t2 = time.perf_counter()
        logits = self.shard.logits(from_wire(resp.hidden, list(resp.shape))[:, -1:, :])
        tok = mx.argmax(logits[0, -1])
        mx.eval(tok)
        host2 = (time.perf_counter() - t2) * 1000
        return (int(tok.item()), host1 + host2, resp.compute_ms,
                rtt - resp.compute_ms, len(payload),
                logits[0, -1].astype(mx.float32) if keep_logits else None)

    def generate(self, prompt_ids: list[int], max_tokens=64, keep_logits=False):
        rid = uuid.uuid4().hex
        cache = self.shard.make_cache()
        ids = mx.array(prompt_ids)[None]
        eos = set(self.tok.eos_token_ids) if hasattr(self.tok, "eos_token_ids") else {self.tok.eos_token_id}
        try:
            for _ in range(max_tokens):
                tok, h_ms, w_ms, n_ms, nbytes, lg = self._step(rid, ids, cache, keep_logits)
                yield TokenEvent(tok, self.tok.decode([tok]), h_ms, w_ms, n_ms, nbytes, lg)
                if tok in eos:
                    break
                ids = mx.array([[tok]])
        finally:
            self.stream.send(pb.ForwardRequest(request_id=rid, release=True))
