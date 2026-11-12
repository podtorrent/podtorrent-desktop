# PodTorrent for Linux AMD (headless)

PodTorrent lets this machine serve part of a large language model, together with other machines.
This build is for an AMD Ryzen AI Max machine (Strix Halo: Radeon 8050S / 8060S / 8065S, gfx1151) that
you reach over SSH. It needs no desktop or display.

## Before you start

- **Linux kernel 6.14 or newer**, with the `amdgpu` driver (`uname -r` shows the version).
- **Your user in the `video` and `render` groups**: `sudo usermod -aG video,render $USER`, then log out
  and back in.
- **About 25 GB of free disk** for PyTorch (ROCm), plus room for the model layers you serve
  (usually 10–60 GB).
- A **node id and token** from PodTorrent, if you'll serve the PodTorrent network.

`setup` checks all of this first and prints the exact fix for anything that's missing.

## Install and set up

```bash
curl -L -o podtorrent.tar.gz https://podtorrent.com/download/linux-amd-cli
tar xzf podtorrent.tar.gz && cd podtorrent-headless-*
./podtorrent setup
```

`setup` takes you through it step by step:

1. **Checks the machine:** kernel, GPU driver, permissions, disk.
2. **Installs PyTorch for your GPU and tests the GPU.** The first time, this downloads several GB and
   can take 10–30 minutes. It's slow, not stuck. If the GPU test fails, setup stops rather than run
   slowly on the CPU.
3. **Asks for a name** that other machines will see.
4. **Starts PodTorrent as a background service**, so it keeps running after you log out.
5. **Suggests a model and the layers this machine should serve:** the ones the network is missing,
   sized to your free GPU memory. Press Enter to accept, or type your own range.
6. **Downloads those layers** with a progress bar.
7. **Offers to join the PodTorrent network.** Enter your node id and token when asked (the token
   isn't shown as you type).

You can run `./podtorrent setup` again any time, for example to serve more layers.

To keep PodTorrent running after you log out and start it at boot, run this once:

```bash
sudo loginctl enable-linger $USER
```

## Day to day

| Command | What it does |
|---|---|
| `./podtorrent top` | Live view: what this machine serves, tokens per second, the models and every machine in the network (Ctrl-C to quit) |
| `./podtorrent status` | The same, once (`--json` for scripts) |
| `journalctl --user -u podtorrent -f` | Follow the logs |
| `systemctl --user restart podtorrent` | Restart it |
| `./podtorrent join` / `./podtorrent leave` | Join or leave the PodTorrent network |

To see the web dashboard, forward the port from your own computer and open http://127.0.0.1:27183:

```bash
ssh -L 27183:127.0.0.1:27183 you@this-machine
```

## If something goes wrong

Run:

```bash
./podtorrent doctor
```

It checks everything, prints what's OK and what isn't, and writes one file
(`podtorrent-doctor-….tar.gz`). **Please send us that file.** It contains logs and system details,
with your node token and any keys removed.

## Stop or uninstall

```bash
./podtorrent uninstall-service     # stop PodTorrent and remove the background service
rm -rf ~/.podtorrent               # also delete downloaded models, PyTorch and settings
```

Then delete this folder.
