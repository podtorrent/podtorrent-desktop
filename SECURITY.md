# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this
repository. Don't open a public issue. We aim to reply within a week.

## What to know

- The swarm is open: any PodTorrent peer can send work to yours. A peer can return wrong activations
  or flood you with requests. Reports of ways to crash, exhaust or take over a peer are in scope.
- Every machine on a route sees that request's intermediate state (activations). Don't send prompts
  through public pods that you wouldn't show their members.
- QUIC is encrypted and both ends prove their peer IDs. The local API binds to 127.0.0.1 only.
- Your node token (PodTorrent network) lives in the data folder, readable by your user only.

In scope: the peer (`podtorrent/`), the desktop app (`app/`), the headless build, the installers, and
the rendezvous and downloads Workers. Third-party models and dependencies: report those upstream.
