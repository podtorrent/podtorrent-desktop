# Screenshot Guide

Demo Mode drives every view from a simulated swarm, using the same event shapes as the engine. It's always badged **Demo** (a pill in the sidebar and a banner).

**Turn it on:** press `⌥⌘D`, or go to Settings → Developer → Demo Mode, or use ⌘K → "Demo preset: …".

**Browser preview (no app):** run `python3 app/scripts/serve-ui.py` and open http://localhost:27184. Health tiles and raw logs show "available in the app".

## Presets

| Preset | Best for |
| --- | --- |
| **Two Macs** | Honest hero shot: matches today's engine (host 0–23, worker 24–47) |
| **Studio swarm** | The wow shot: 6 Macs, overlapping ranges (2 bands of redundancy), 3 models, one with a glowing gap |
| **Fresh pair** | Recording the load flow: Models → Load model shows both downloads, then "Ready to run" |
| **Degraded** | States: a dropped worker (gap), a slow relay link (amber), the offline edge |

## Shots

1. **Swarm graph:** Studio swarm, Graph view, window about 1440×900, dark mode. Wait for ambient traffic (every ~9 s) so pulses are mid-flight. Hover a peer for the glass popover.
2. **Model Strip:** Studio swarm → Models. The Llama card's red gap explains "Can't run" at a glance.
3. **Token Trace:** Two Macs → Playground. Use the suggestion "Write a Python function…" (it has a highlighted code block), then expand **Token trace** and switch between First token and Typical token.
4. **My Node:** any preset. The radial gauge, tokens today, and history bars (labeled "Demo data").
5. **⌘K palette:** type "peer" or "demo".
6. **Light mode:** Settings → Theme → Light. Every view is designed for both themes.

Turn on Reduce Motion or **Reduce visual effects** to get still frames without glow.

Turn **Ambient traffic** off (Settings → Developer) for calm, idle shots.
