# PodTorrent video: MiniMax-H3 implementation plan

Status: building release 1 (Windows video, local only) · branch `video-gen-h3` · updated 2026-10-15

## Goal

Generate short videos with sound using [MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) across the swarm. The video model alone is too large to use comfortably on any single machine we have. The target swarm is 2 Macs (16 GB each) and 1 Windows PC (RTX 5070 12 GB, 64 GB RAM, 16 cores), all on different networks.

Version 1 is **text to video**. **Image to video** comes later. Version 1 is shaped so that adding images doesn't change the job format, the protocol or the UI layout.

## Decisions (agreed)

| Topic | Decision |
|---|---|
| Split | **Split by component, not by layer.** The video transformer stays whole on one machine. The two cost rows below explain why. |
| Mac role | The **prompt encoder** (Qwen3-VL-32B, 4-bit, about 18 GB) runs as a layer chain across the Macs, the way the Qwen3 chain works today. Later phases add video decoding and post-processing on the Macs. |
| Windows role | The **video transformer** (about 20B weights once the precomputable part is removed), 8-bit, with ComfyUI offloading to system RAM. It also holds the video and audio decoders. |
| Network cost of a layer split | Splitting the video transformer by layer sends about 300 MB per split point per step, and about 15 GB per clip (one pass per step, 50 steps). That's still hours over home upload speeds, so it's rejected. |
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

## Revision (2026-10-16): community results change the order

Community reports show H3 already runs on 12 GB NVIDIA cards (see [performance guide](https://github.com/wildminder/awesome-minimax-H3/blob/main/guides/minimax-h3-performance.md)): an RTX 3060 12 GB with 64 GB RAM makes a 5 s 480p clip in 3–5 minutes with a Turbo LoRA, and a 4070 12 GB peaks at about 10.6 GB of GPU memory. So:

- **Phase 0 is folded into release 1.** The standalone spike in `spikes/h3_phase0/` stays as a fallback. Release 1 is the real feature in the Windows app, and each job writes the same measurements (`report.json`) that phase 0 wanted.
- **Runtime: headless ComfyUI, not plain diffusers.** Every proven 12 GB setup uses ComfyUI's built-in H3 nodes (`comfy_extras/nodes_minimax_h3.py`). The engine installs a pinned ComfyUI (v0.41.0) in its own venv under `~/.podtorrent/video/`, starts it on `127.0.0.1:8188`, and sends it the official *Image to Video (MiniMax H3)* blueprint graph in text-to-video mode.
- **Weights (from `Comfy-Org/MiniMax-H3`, public, about 44 GB):** `minimax_h3_fl2va_pruned_int8_convrot` (21.0 GB), text encoder `qwen3vl_32b_minimax_h3_nvfp4_awq` (15.7 GB), `minimax_h3_fl2v_turbo_8step_v1.0` LoRA (2.0 GB), video VAE fp16 (5.2 GB), audio VAE fp32 (0.6 GB). No Hugging Face account or token needed.
- **Macs can render whole clips too.** MLX and Metal engines ([h3.c](https://github.com/antirez/h3.c), [minimax-h3-mac](https://github.com/Argus-AiTeam/minimax-h3-mac)) stream the video model from the SSD, cutting its memory to about 2 GB. A 16 GB M5 Air reportedly makes a 3.75 s clip in about 15 minutes; an M1 will be much slower (estimate: an hour or more). This becomes a throughput mode in phase 5: each Mac renders its own clips in the background. It doesn't change the decision against layer splitting.

### Release order

| Release | Contents |
|---|---|
| 1 | Video view + headless ComfyUI worker on any NVIDIA machine (≥ 12 GB GPU memory). Local only. Diagnostics per job. |
| 2 | Phases 1–2: encoder chain on the Macs, job protocol, blob transfer. |
| 3 | Phase 4: roles, routing, Swarm view. Then phase 5 (Mac whole-clip mode, decoding on Macs) and phase 6 (images). |

## Glossary

- **Encoder:** the model that turns the prompt (and later images) into embeddings, the numbers the video model reads.
- **Video transformer:** the 33B model in H3 that generates the video. It runs 30–50 steps per clip, starting from noise.
- **VAE:** the decoder that turns the video transformer's compressed output into real frames (H3-VisualVAE) and audio (H3-AudioVAE). Its encoder half turns an image into a starting frame.
- **Two-pass steps:** many video models run each step twice, once with the prompt and once without. H3's released checkpoints are *CFG-distilled*, so they run each step once.

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

### Phase 0: Feasibility spike (folded into release 1; see Revision)

Prove the Windows PC can render H3 at all, and settle the unknowns.

- [ ] Accept the licence on Hugging Face and set an `HF_TOKEN` on all machines.
- [ ] On Windows, run `spikes/h3_phase0/run_matrix.bat` (standalone diffusers script: text to video at 480p, 4 s. Pick the best community quantized version that fits (FP8 first, then 4-bit), with `enable_model_cpu_offload` and the AdaLN cache). It writes `report.json` per run.
- [ ] Measure peak GPU memory, peak system RAM, seconds per step and total time. Repeat at 720p.
- [x] ~~Find out whether text-to-video and image-to-video share a checkpoint.~~ **They do:** the model card says text-to-video and first/last-frame-to-video both run through `FL2VA/`. Only reference-image video (`Ref2VA/`) is a separate checkpoint.
- [ ] Record H3's internal width, its token counts at each resolution and the encoder output shape. Use these to replace the estimates in this doc.
- [ ] Confirm the encoder output can be computed separately and passed in (`prompt_embeds`, or the equivalent argument).

**Exit:** a clip renders on Windows in under about 15 minutes, with recorded numbers. **If this fails, stop.** Options then are smaller resolutions, a smaller video model, or waiting for better quantized versions.

### Phase 1: Encoder chain on the Macs

H3 reads Qwen3-VL-32B truncated to **50 of 64 layers**: raw prompt tokens (no chat template, no padding, no mask), and the conditioning is the un-normalized hidden state after layer 50 (ComfyUI `comfy/text_encoders/minimax.py`). Needed weights: 14.2 GB at 4-bit, not the repo's 19.6 GB.

- [x] Qwen3-VL's language model as encoder slices: `video/encoder_mlx.py` (MLX) and `video/encoder_torch.py` (reuses `shard_torch`'s dense layer; it now also loads unquantized weights).
- [x] Encoder-mode pass: one causal pass, no KV cache, no sampling, `[1, T, 5120]` out of the last slice.
- [x] Parity test (`tests/parity_h3_encoder.py`). Real 32B, 2 processes on one Mac, `--no-whole --no-reference`: MLX→torch vs MLX→MLX cos 1.000000, rel ≤ 0.09% on 3 prompts. Not yet checked against ComfyUI's encoder (phase 3, on Windows); the fp32 transformers reference doesn't fit any of our machines at 32B.
- [x] Peak memory per half on a 16 GB Mac: layers 0–24 + embedding 7.36 GB, layers 25–49 6.92 GB.
- [x] Per-machine slice download (`slicer.py` handles Qwen3-VL key names and stale repo indexes) and an Encoder card in the Video view to pick, download, test and remove this machine's layers.
- [ ] Check fp16 wire headroom on long prompts (activations reach the thousands).

**Exit:** two processes on one Mac produce embeddings identical to the reference, within tolerance.

### Phase 2: Job protocol and blob transfer

- [x] `pipeline.proto`: `VideoJob`, `JobEvent`, `BlobRef`, `InputPart`, `BlobChunk`, `BlobAck`, RPCs `VideoStage` (M_VIDEO) and `Blob` (M_BLOB), and `NodeInfo.roles` (`h3-encoder:LO:HI`, `h3-video`).
- [x] `net/blob.py`: blobs named by SHA-256, pulled in 1 MB chunks with an 8 MB ack window, resumed from the `.part` file after a drop, SHA-256 checked before use (`tests/test_blob.py`).
- [x] `video/swarm.py`: the requester plans encoder hops plus a video peer from the peers' roles and runs each stage with `VideoStage`; hidden states (float32, so no fp16 overflow) move peer to peer, the MP4 comes back to the requester. Jobs share the local job list and `video_job` WebSocket events; API `GET /api/video/swarm`, `POST /api/video/swarm/jobs`, cancel through the existing `/api/video/jobs/{id}/cancel`.
- [x] Fake roles (`PODTORRENT_VIDEO_FAKE_ROLES=h3-encoder:0:25,h3-video`): random hidden states and a placeholder MP4, for tests without weights or a GPU. A real encoder slice on disk runs for real.
- [ ] Not yet in the UI: the Video view still submits local jobs only (phase 4).

**Exit:** a request on Mac A goes through a fake encoder and fake video worker on other machines, and an MP4 comes back across networks.
`tests/video_swarm.py` passes with three peers on one Mac through the public rendezvous (A requests, B encodes 0–24, C encodes 25–49 and renders; cancel mid-render works). Still to run across real networks on separate machines.

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
- [ ] No checkpoint swap needed for first-frame video (same `FL2VA/` weights). Reference-image video (`Ref2VA/`) would need a second checkpoint; out of scope for now.
- [ ] UI: drop an image onto the prompt box.

**Exit:** an image plus a prompt produces a clip that starts from that image.

### Phase 7: dropped

The two-pass split was the one way to share the video model's steps between machines. H3 runs one pass per step (CFG-distilled), so there's nothing to split.

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
