# The engine: why PodTorrent runs model layers itself

PodTorrent does three jobs:

1. **Download** a slice of a model's layers (`podtorrent/slicer.py`).
2. **Run** that slice: hidden states in, this slice's layers, hidden states out (`podtorrent/shard.py`,
   `podtorrent/shard_torch.py`).
3. **Connect** the machines holding the slices: QUIC, rendezvous, routing, pods (`podtorrent/net/`,
   `podtorrent/route.py`, `podtorrent/pod.py`).

Job 2 is the engine. PodTorrent never changes a model: the weights are the published `mlx-community`
files, and the math is the model's own. The engine only decides how that math runs on a GPU. Outputs
are checked against a plain reference run (`tests/`).

## Why not an off-the-shelf engine

On Apple Silicon, PodTorrent borrows one: `shard.py` is a thin wrapper around MLX and `mlx_lm`.

Everywhere else, no existing engine does what splitting needs:

- **Run a range of layers only**, and hand the intermediate hidden states to another machine.
  Most engines (vLLM, Hugging Face transformers) run a whole model in one process.
- **Read the same MLX 4-bit files as the Macs**, so one download format serves every machine.
- **Round like MLX** (float32 math, bfloat16 where MLX keeps bfloat16), so a Mac and a PC can sit in
  the same chain and the hand-off between them stays consistent.

llama.cpp is fast and broad, but it uses its own format (GGUF) and its own way of splitting across
machines; Mac and non-Mac peers could not share one chain. So `shard_torch.py` is PodTorrent's own small
PyTorch engine for machines without MLX.

The alternative that needs no engine code already exists for whole models: `podtorrent-agent` forwards
requests to any OpenAI-compatible engine (llama.cpp, vLLM, Ollama). That gives up splitting one model
across machines, which is the case PodTorrent exists for: a model too big for any single machine.

## Generic vs per model family

Most of the engine's speed comes from parts that work for any model in a supported family, with no
per-model work (dimensions come from each model's config):

| Part | Applies to |
| --- | --- |
| 4-bit / 8-bit matrix kernels that read the MLX format as stored (`torch_kernels.py`) | every linear layer of every model |
| Batched routed experts (one launch for the experts a token picks) | every mixture-of-experts model, any expert count or size |
| Decode step captured as a CUDA graph and replayed | any model, NVIDIA (CUDA) and AMD (ROCm) |
| Preallocated KV cache, fused norms, RoPE and attention | standard transformer attention |

Some parts are written once per architecture family and shared by every model in it:

| Part | Family |
| --- | --- |
| Gated DeltaNet linear attention: conv step, delta rule, gated norm | Qwen3.5 (`qwen3_5_moe`) |
| Attention output gate, partial RoPE | Qwen3.5 |

Supported families today: `qwen3_moe` and `qwen3_5_moe` (`SUPPORTED` in `peer.py`), 4-bit and 8-bit.
Any size or variant in those families (Qwen3-30B-A3B, its 2507 and Coder versions, Qwen3.5-35B-A3B,
Qwen3.5-122B-A10B, Qwen3-235B-A22B) gets the fast path automatically.

A new family (Llama, DeepSeek, Gemma) first needs support itself: its layer code in both `shard.py` and
`shard_torch.py`, plus parity tests. That holds with or without these optimizations. It then reuses the
generic parts; only a genuinely new piece (DeepSeek's compressed attention, say) needs its own kernel.
Until that kernel exists, the model still runs correctly on the reference path, more slowly: a layer
uses the fast path only when every piece of it has one (`Layer.fast`).

## How the PyTorch engine runs

- **Reference path:** plain PyTorch, any device, any number of positions. It defines the expected
  output.
- **Fast decode path:** used on a GPU with Triton, one position at a time (generation). Fused kernels
  from `torch_kernels.py`; each session's step is captured as a CUDA graph from its second token.
  Kernels are compiled and a graph capture is tried when a slice loads; any failure falls back to the
  reference path.
- **Without Triton** (CPU, Windows PyTorch wheels): the reference path, with experts batched and a
  faster 4-bit unpack.
- `PODTORRENT_TORCH_FAST=0` forces the reference path; `PODTORRENT_CUDA_GRAPHS=0` keeps the kernels
  but not the graphs.
- `scripts/bench_torch.py` times a slice (`--compare` against the reference, `--synthetic` for
  Qwen3.5-122B-sized layers with random weights). `tests/test_torch_kernels.py` checks the kernels and
  the fast path on a GPU.

Measured with Qwen3-30B-A3B-4bit split 24/24 between an AMD Strix Halo and a Jetson AGX Orin:
1.1 → 35 tokens/s end to end. Each 24-layer slice went from 214 and 571 ms per token to about 8.4 ms.
