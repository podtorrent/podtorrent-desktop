# PodTorrent video: MiniMax-H3 implementation plan

Status: agreed, starting phase 0 · branch `video-gen-h3` · updated 2026-10-15

## Goal

Generate short videos with sound using [MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) across the swarm. The video model alone is too large to use comfortably on any single machine we have. The target swarm is 2 Macs (16 GB each) and 1 Windows PC (RTX 5070 12 GB, 64 GB RAM, 16 cores), all on different networks.

Version 1 is **text to video**. **Image to video** comes later. Version 1 is shaped so that adding images doesn't change the job format, the protocol or the UI layout.

## Decisions (agreed)

| Topic | Decision |
|---|---|
| Split | **Split by component, not by layer.** The video transformer stays whole on one machine. The two cost rows below explain why. |
| Mac role | The **prompt encoder** (Qwen3-VL-32B, 4-bit, about 18 GB) runs as a layer chain across the Macs, the way the Qwen3 chain works today. Later phases add video decoding and post-processing on the Macs. |
| Windows role | The **video transformer** (about 20B weights once the precomputable part is removed), FP8 or 4-bit, with some layers offloaded to system RAM. It also holds the video and audio decoders. |
| Network cost of a layer split | Splitting the video transformer by layer sends about 300 MB per split point per step, and about 30 GB per clip. That's hours over home upload speeds, so it's rejected. |
| Network cost of the component split | The encoder output (a few MB) goes once per prompt to the Windows PC. The finished MP4 goes back to whoever asked for it. |
| Code location | **Same repo and app, not a fork.** The P2P stack, rendezvous, catalog, Tauri shell and Swarm UI are reused. The new code goes in `podtorrent/video/`. |
| Shared inference | Every machine still takes part. A video job always runs on the Mac encoder chain and then on the Windows video machine. |
| Expected output (v1) | 480p–720p, 4–6 seconds, minutes per clip. 2K is out of scope on 12 GB of GPU memory. |
| Inputs | v1 is text only. The job format, encoder interface and VAE loading are built so image input can be added without rework (phase 6). |
| Latency | Not interactive. Waiting several minutes per clip is acceptable, so we favour memory headroom (more offload, smaller quantized versions) over speed. |
| Mac contribution | Agreed: the Windows PC does most of the compute. The Macs run the encoder, and later the decoding and post-processing. |
| Weights | Community quantized versions are acceptable. We don't quantize ourselves unless phase 0 finds them unusable. |
| Licence | Our users are outside the US, EU, UK and Korea, so no access application is needed. Users still accept the licence on Hugging Face. |
| Video machine | Any peer that passes the capability check can take the video role (at least 12 GB of GPU memory and enough system RAM). It isn't tied to one PC. |

## Glossary

- **Encoder:** the model that turns the prompt (and later images) into embeddings, the numbers the video model reads.
- **Video transformer:** the 33B model in H3 that generates the video. It runs 30–50 steps per clip, starting from noise.
- **VAE:** the decoder that turns the video transformer's compressed output into real frames (H3-VisualVAE) and audio (H3-AudioVAE). Its encoder half turns an image into a starting frame.
- **Two-pass steps:** most setups run each step twice, once with the prompt and once without, and blend the results. This makes the prompt matter more.

## Architecture

```
 requester (any peer)
      │ VideoJob {inputs:[{type:text,...}], res, secs, seed, steps}
      ▼
 ┌──────────── Mac A ────────────┐    ┌──────────── Mac B ────────────┐
 │ Qwen3-VL encoder layers [0,k) │───►│ Qwen3-VL encoder layers [k,N) │
 └───────────────────────────────┘    └──────────────┬────────────────┘
                                                     │ embeddings + mask + position IDs (few MB)
                                                     ▼
                              ┌──────────── Windows (CUDA) ────────────┐
                              │ video transformer (FP8/4-bit, offload) │
                              │ 30–50 steps → VisualVAE + AudioVAE     │
                              └──────────────┬─────────────────────────┘
                                             │ MP4 (blob over QUIC)
                                             ▼
                                         requester
```

### Components

1. **Job model** (`podtorrent/video/job.py`): `VideoJob` and `JobState` (queued, encoding, generating, decoding, done, failed), progress events, and cancellation. The inputs are a **list of typed parts** from day one.
2. **Blob transfer** (`podtorrent/net/blob.py`): chunked transfer over QUIC with resume and a hash check. It carries the embeddings, MP4s and, later, images.
3. **Encoder chain** (`podtorrent/video/encoder_mlx.py`, `encoder_torch.py`): Qwen3-VL's language model as layer slices, reusing `shard.py` and `slicer.py`. Its output is the full set of hidden states (no token sampling) plus the mask and position IDs. The vision tower comes in phase 6.
4. **Video worker** (`podtorrent/video/worker_torch.py`): a diffusers pipeline driven directly from our embeddings. It skips the pipeline's own text encoder, uses the precomputed AdaLN cache, quantized weights, CPU offload and VAE tiling.
5. **Roles in routing** (`route.py`): peers advertise *roles* (`h3-encoder:[lo,hi)`, `h3-video`, `h3-vae`) plus capabilities (GPU memory, system RAM, backend). A video route is the encoder chain, then a video machine, then a VAE machine.
6. **UI** (`app/ui/js/views/video.js`): a Video view with a prompt box, job queue, progress through each stage, the player and the history. Swarm shows the roles.

## Phases

Each phase ends in something we can demonstrate. Don't start a phase until the previous one's exit check passes.

### Phase 0: Feasibility spike (no PodTorrent code)

Prove the Windows PC can render H3 at all, and settle the unknowns.

- [ ] Accept the licence on Hugging Face and set an `HF_TOKEN` on all machines.
- [ ] On Windows, standalone diffusers script: text to video at 480p, 4 s. Pick the best community quantized version that fits (FP8 first, then 4-bit), with `enable_model_cpu_offload` and the AdaLN cache.
- [ ] Measure peak GPU memory, peak system RAM, seconds per step and total time. Repeat at 720p.
- [ ] Find out whether **text-to-video and image-to-video (FL2VA) use the same transformer checkpoint**. If they don't, plan for swapping weights or keeping two copies on disk.
- [ ] Record H3's internal width, its token counts at each resolution and the encoder output shape. Use these to replace the estimates in this doc.
- [ ] Confirm the encoder output can be computed separately and passed in (`prompt_embeds`, or the equivalent argument).

**Exit:** a clip renders on Windows in under about 15 minutes, with recorded numbers. **If this fails, stop.** Options then are smaller resolutions, a smaller video model, or waiting for better quantized versions.

### Phase 1: Encoder chain on the Macs

- [ ] Add Qwen3-VL's language model to `shard.py` and `shard_torch.py` (checking how it differs from `qwen3_moe`).
- [ ] An encoder-mode forward pass: one full pass over the prompt with no token sampling, returning the hidden states from the layers H3 reads.
- [ ] Parity test (`tests/parity_h3_encoder.py`): split across 2 processes vs. the reference transformers encoder, with a maximum-difference threshold.
- [ ] Peak memory per half on a 16 GB Mac.

**Exit:** two processes on one Mac produce embeddings identical to the reference, within tolerance.

### Phase 2: Job protocol and blob transfer

- [ ] `pipeline.proto`: messages `VideoJob`, `JobEvent`, `BlobChunk`, `BlobAck`. Regenerate `pipeline_pb2.py`.
- [ ] `net/blob.py`: chunked transfer, back-pressure, resume after a dropped connection, and a SHA-256 check at the end.
- [ ] Job state machine and events on the local API (`/v1/video/jobs`, WebSocket `video.*` events).
- [ ] A fake video worker that returns a placeholder MP4, for end-to-end tests without a GPU.

**Exit:** a request on Mac A goes through a fake encoder and fake video worker on other machines, and an MP4 comes back across networks.

### Phase 3: Video worker on Windows

- [ ] `worker_torch.py`: load the transformer and VAEs once and keep them loaded. Accept embeddings and run the steps, with progress events every step.
- [ ] Settings for quantization and offload, set automatically from the machine's GPU memory and system RAM.
- [ ] Cancellation between steps. Out-of-memory errors fail the job cleanly.
- [ ] Downloading the model through the existing catalog, without range downloads (whole files are fine for a single machine).
- [ ] The Windows installer includes diffusers and its dependencies. Click and run still works.

**Exit:** the full v1 path works. Text on any peer goes through the Mac encoder chain to the Windows PC, and a real MP4 comes back.

### Phase 4: Routing, roles and UI

- [ ] `route.py`: role-based video routes, skipping machines that lack the capability (for example, `h3-video` needs at least 12 GB of GPU memory). Unit tests in `tests/test_route.py`.
- [ ] Peer config: `serve h3-encoder:0:32`, `serve h3-video` from the CLI and the Models view.
- [ ] Video view: prompt box, resolution and length presets, queue, progress by stage, player, save.
- [ ] Swarm: show roles and the video job flowing through them.
- [ ] Copy says "machine" / "peer".

**Exit:** a non-technical user can start the nodes, type a prompt in the app and watch the clip play.

### Phase 5: Better use of the Macs and throughput

- [ ] **Decoding on the Macs:** send the compressed video output (a few MB) to a Mac for the frame and audio decoding. Needs the VAEs in MLX or PyTorch on Apple's GPU. This frees the Windows GPU for the next job.
- [ ] Pipeline jobs: the encoder works on job N+1 while Windows generates job N.
- [ ] Optional post-processing on the Macs: frame interpolation or upscaling, or prompt rewriting with a small LLM.
- [ ] Failover: if the video machine drops mid-job, restart from the last saved step if a second video machine exists. Otherwise fail clearly.

**Exit:** with 2 jobs queued, total time is clearly below 2× a single job.

### Phase 6: Image to video

- [ ] Port Qwen3-VL's vision tower and its image preprocessing to the encoder (MLX and PyTorch), with a parity test.
- [ ] Image parts in `VideoJob.inputs`, sent by blob transfer.
- [ ] The VAE encoder half on the video machine turns the image into the starting frame (FL2VA).
- [ ] Load the image-to-video checkpoint, or swap to it, depending on what phase 0 found.
- [ ] UI: drop an image onto the prompt box.

**Exit:** an image plus a prompt produces a clip that starts from that image.

### Phase 7 (optional): Splitting the two passes per step

Only once a peer has enough memory for a second copy of the video model. That peer runs the without-prompt pass and swaps a few MB per step with the main video machine. Not useful with 16 GB Macs.

## Risks and open items

| Risk | Mitigation |
|---|---|
| H3 doesn't fit the 5070 even quantized, or is far too slow | The phase 0 go/no-go. Fallbacks: lower resolutions, fewer steps, a smaller video model. |
| Community quantized versions are poor quality | Compare two or three versions on a fixed seed in phase 0 and pick the best. Quantize ourselves only as a last resort. |
| Disk: about 40 GB of video model plus about 18 GB of encoder | Show sizes before download. The Windows PC needs about 100 GB free. |
| The Windows installer grows a lot with diffusers and CUDA | Install the video parts on demand, the first time a peer enables `h3-video`. |
| Only one video-capable peer | No failover for video in v1. The UI says so plainly. |
| Upload speed for the MP4 and images | Small files (tens of MB). Blob resume covers dropped connections. |

## Not doing

- Splitting the video transformer across machines by layer (the network cost rules it out).
- Porting the video transformer to MLX.
- 2K output in v1.
