# Contributing to PodTorrent

Thanks for helping. Issues and pull requests are welcome, especially for the Windows, Linux, AMD and
iOS ports. By sending a pull request you agree that your contribution is licensed under Apache-2.0,
like the rest of the project (LICENSE, section 5).

## Development setup

See the README for running a peer and the desktop app. Tests: `uv run --with pytest pytest -q`
(add `--with torch` for the PyTorch parity tests), `npm test` in `rendezvous/`, `./test.sh` in
`ios/PodTorrentKit`.

## Your own servers

The repository has no server addresses or keys in it. The official builds' servers are for the official
builds only, so a fork or a source checkout runs its own:

1. **Rendezvous** (required for a swarm). A Cloudflare Worker with Durable Objects in `rendezvous/`.
   ```bash
   cd rendezvous && npm ci && npx wrangler login
   # Edit wrangler.jsonc: set "routes" to a domain on your own Cloudflare account, or remove them to use workers.dev.
   seed="$(openssl rand -hex 32)"
   printf '%s' "$seed" | npx wrangler secret put MATCHMAKER_SEED
   npx wrangler deploy
   # The matchmaker's public key, for endpoints.json:
   uv run python -c "import sys; from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as K; print(K.from_private_bytes(bytes.fromhex(sys.argv[1])).public_key().public_bytes_raw().hex())" "$seed"
   ```
   Keep the seed secret: whoever has it can sign public pods.
2. **endpoints.json.** `cp endpoints.example.json podtorrent/endpoints.json`, then set `rendezvous` to your
   Worker's `wss://` URL and `matchmakers` to the public key above. Leave `networks` out unless you run a
   PodTorrent-network API for [podtorrent-agent](https://github.com/podtorrent/podtorrent-agent).
   The file is gitignored; `app/scripts/bundle-backend.js` copies it into app and headless builds.
3. **Downloads site** (optional). `downloads/` serves builds from an R2 bucket. Set its `routes` and
   `bucket_name` in `wrangler.jsonc` to your own. The installers it serves download from whatever origin
   served them.
4. **CI.** In your fork's repository secrets, set `PODTORRENT_ENDPOINTS` (the contents of your
   endpoints.json), and `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` if you publish to R2. Without
   `PODTORRENT_ENDPOINTS`, branch builds work but have no servers; release tags (`v*`) fail.

For local work, `npx wrangler dev` in `rendezvous/` and `PODTORRENT_RENDEZVOUS=ws://localhost:8787` is
enough. Ship your builds under your own name and app identifier (NOTICE).

## Pull requests

- Keep changes focused, with tests where the code has them.
- Wire formats (rosters, invites, the QUIC identity) are shared by every port: change them in
  `podtorrent/` first and keep `tests/pod_vectors.json` passing everywhere.
- Never commit `podtorrent/endpoints.json`, tokens, keys or seeds.
