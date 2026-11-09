# iOS

The iPhone/iPad peer (decisions in docs/PODS_PLAN.md and spikes/ios_quic/README.md). So far:

- `PodTorrentKit/`: the pod and rendezvous core, a Swift package with no dependencies beyond CryptoKit and
  Foundation. Canonical JSON (`canonical`), roster checks (`verify`, `newer`), invite codes and proofs,
  the room handshake (`roomAuth`), joining a private pod with a code (`joinPod`) and waiting in the
  public lobby for a public pod (`waitForPublicPod`). A port of `podtorrent/pod.py` and
  `podtorrent/net/rendezvous.py`; `tests/pod_vectors.json` settles any disagreement.

Tests (the vectors always; the room tests only against a running rendezvous):

```sh
cd ios/PodTorrentKit && ./test.sh
cd rendezvous && npx wrangler dev   # then, in another shell:
cd ios/PodTorrentKit && PODTORRENT_RENDEZVOUS=ws://localhost:8787 ./test.sh
```

`test.sh` is `swift test` plus the framework paths the Command Line Tools need for Swift Testing; with
Xcode, plain `swift test` works.
