# Pods: who serves with whom

Status: phases 1–5 built (roster core, peer enforcement, private pods end to end, matchmaker and census, the iOS core; Worker deployed 2026-11-09), phase 6 not started · 2026-11-09

## Problem

Today every PodTorrent machine registers in one global rendezvous room (`Swarm`, `idFromName("global")`),
dials every other machine it sees, and routes through any reachable peer's slices. Connecting
automatically to strangers is a core feature (most people don't own enough machines to cover a model),
but nothing gives that swarm structure:

- **No way to keep a group private.** If you want machines A and B to serve model X at 50% each, and C is
  online serving X's layers too, `plan()` can pick C. You can't say "only my machines".
- **No exclusive chains in the public swarm either.** Any machine can route through any slice, so one
  slice ends up in many chains at once without anyone deciding it.
- **Anyone can use your machine.** `M_FORWARD` and `M_LOAD` are served to any authenticated peer, and
  `pick_helper` pushes leftover layers onto whichever direct peer has free memory.
- **The network sees duplicate capacity.** Each machine that clicks Join publishes every model the swarm
  covers with `slots: 1`. Three heads on one chain of slices look like 3× capacity, and each head sets
  its own price for the same hardware.
- **The rendezvous trusts `peer_id` from the URL.** A socket can claim any `peer_id` and replace that
  peer's registration (QUIC itself is authenticated, so it can't impersonate on the data path).

## Goal

Keep automatic matching with strangers, and make the **pod** the one unit everything works in. A pod is
a set of machines that together cover a model, with a fixed layer split and one head. There are two
kinds, built from the same parts:

| | **Private pod** | **Public pod** |
|---|---|---|
| Who's in it | machines the owner invited | machines the matchmaker put together |
| Formed by | invite codes | the rendezvous, from machines that opted into public serving |
| Roster signed by | the owner machine | the matchmaker's key |
| Layer split | the owner's plan (e.g. 50/50) | the matchmaker's plan, by free memory |
| Strangers | never, unless "fill gaps from the public swarm" is on | that's the point |

A machine is in **at most one pod at a time**, so a slice belongs to exactly one chain. A machine's mode
is one of:

- **Public** (default, today's behaviour, now structured): available to the matchmaker.
- **Private pod**: serves only with its pod's members.
- **Alone**: a pod of one. It holds every layer of the model itself and links to no other machine, but it
  can still join the PodTorrent network and serve the whole model as its own node, as its own head. In
  the census it's a head with no satellites.

```
private pod "logesh-home"   mac-studio [0,24)  win-desktop [24,48)        head mac-studio
public pod  "pub-7f3a"      stranger-1 [0,16)  stranger-2 [16,40)  stranger-3 [40,48)  head stranger-2
```

Every pod, private or public, follows the same rules: only members connect and serve each other, a
route uses only members' slices, and the network sees one node per pod with real capacity.

## Design

### 1. Roster: the signed source of truth

```json
{ "pod_id": "…", "salt": "<16 bytes hex>", "kind": "private", "name": "logesh-home", "version": 7, "signer": "<pubkey hex>",
  "members": [{ "peer_id": "…", "pubkey": "…", "name": "mac-studio" }],
  "plans":   [{ "model": "mlx-community/Qwen3-30B-A3B-4bit", "layers": 48, "head": "<peer_id>",
                "hops": [{ "peer": "<peer_id>", "lo": 0, "hi": 24 }, { "peer": "<peer_id>", "lo": 24, "hi": 48 }] }],
  "expires": 0, "sig": "<ed25519 over the canonical JSON without sig>" }
```

- **Signer**: for a private pod, the owner machine's identity key (`pod_id` = `sha256(owner_pubkey || salt)[:32]`).
  For a public pod, the matchmaker's key, whose public half ships in every client.
- **Valid** when `sig` verifies against `signer`, the signer is allowed for that `kind`, and the roster
  hasn't expired. A higher `version` wins. A member that sees a newer roster replaces its own copy and
  drops links to anyone no longer listed.
- Every port validates the same roster with the same canonical JSON (sorted keys, no whitespace,
  UTF-8, `/` not escaped, no floats). The signature covers `"podtorrent-roster|"` followed by that
  encoding of the roster without `sig`. Ports: Python on Mac and Windows, Swift on iOS.
  `tests/pod_vectors.json` (built by `tests/pod_vectors.py`) holds fixed keys, encodings, and rosters with
  the expected error code, and every port must agree with it.
- A plan's hops cover `[0, layers)` exactly once, in order. The head and every hop are members. A
  public machine filling a private pod's gaps is a member with `"public": true`.

### 2. Private pods: invites

1. The owner clicks **Invite machine** and gets a single-use code `pod1-<pod_id>-<base32(secret)>`,
   valid 24 h. The owner keeps the secret (in a file only it can read) until it's used or expires.
2. The other machine pastes the code and sends `join_request { peer_id, pubkey, name,
   proof: HMAC-SHA256(secret, "podtorrent-invite|" + pod_id|peer_id|pubkey) }` through the pod's rendezvous room. The proof is bound to that
   machine's key, so a request can't be replayed for another machine.
3. The owner (online) checks the proof, signs a roster with the new member, and publishes it. A valid code
   is accepted at once, and the owner gets a toast.
4. **Remove machine** / **Leave pod**: the owner signs a roster without that member.
5. **Fill gaps from the public swarm** (off by default): if the pod's machines don't cover a model, the
   owner can ask the matchmaker for public machines for the missing layers. They join as members marked
   `public`, under a roster the owner signs, and leave when the owner's machines cover the model again.

### 3. Public pods: the matchmaker

The matchmaker runs in the rendezvous (a `Matchmaker` Durable Object) and replaces "everyone dials
everyone":

- **Supply**: a public machine announces `{ models it has or will download, free memory, NAT/reachability
  facts, current slices }`. Machines that already hold layers are preferred, so nobody downloads for no reason.
- **Demand**: a model is wanted when a public machine asks to chat with it, or a node on the network
  serves it. The first version can be "the models public machines already hold".
- **Forming a pod**: greedy cover of `[0, n_layers)` by free memory. Machines already holding layers are
  preferred, then reachability (machines that already hole-punched each other, low RTT), then fewest
  hops. The matchmaker signs a roster with `kind: "public"` and `expires` about 10 min out, renewed
  while the pod is healthy.
- **Head**: the member with a node token if any (for the network, see 6), otherwise the member holding
  layer 0.
- **Repair**: when a member drops, the matchmaker re-signs a roster that replaces only the missing range
  with another public machine, if one is available. Otherwise the pod dissolves when the roster expires.
- **Stable**: the matchmaker never moves layers between healthy members just to rebalance. Downloads and
  reloads are expensive.
- **Chatting without serving**: a public machine that serves nothing can still chat. The matchmaker gives
  it a route through a public pod, as a client of that pod's head. The head runs the request, as a
  network request does. The client doesn't connect to every hop.

### 4. Rendezvous rooms

- `/v1/pod/<pod_id>`: one Durable Object per pod, for members' records and hole punching. A room accepts
  only roster members, plus `join_request`s relayed to the owner.
- `/v1/public`: the matchmaker's lobby, where public machines announce supply and receive their pod
  assignment.
- **Authenticated sockets**: the room sends `challenge {nonce}`. The peer answers `auth {pubkey, sig,
  roster?}`, where `sig` signs `"podtorrent-room|" + pod_id + "|" + nonce`, and the room derives `peer_id`
  from the key. The welcome says whether the peer is a member and carries the stored roster.
- **Room messages**: members send `hello`/`update`/`punch` as in the public room. Anyone may send
  `roster` (stored only if valid, newer and for this pod). A non-member may send `join_request {name,
  proof}`, which goes to the owner, or comes back as `join_failed {offline}` if the owner isn't there (the
  joiner retries for about 12 s). A member may send `leave`, which goes to the owner as `leave_request`,
  and the owner may send `join_failed {to, reason}`. A non-member is closed after 60 s.
- The rooms verify rosters with WebCrypto Ed25519, store the latest one, and broadcast a newer one to
  every member, so removals propagate within seconds. The rendezvous is a filter and a convenience. QUIC
  is the security boundary.

### 5. QUIC: members only

- `PeerNet` dials only members of this machine's current roster.
- After the existing mutual auth, both sides check `conn.peer_id ∈ roster`, else close with `not-a-member`.
- `M_FORWARD` checks membership per call. `M_LOAD` comes only from the roster signer's decision: each
  member loads its own hop from the plan, and nobody pushes layers onto another machine.
  `pick_helper` is replaced by the plan.
- **Relay**: when hole punching between two members times out (a symmetric NAT on one side), the dialing
  side runs QUIC over the pod room instead: each packet goes as `relay {to, data}` and arrives as
  `relay {from, data}`. The room forwards only between members; QUIC's encryption and certificate
  checks are unchanged. The link shows as relayed in the Pod tab. Only pod rooms relay, not the lobby.
- `route()` plans over members' offers only. The wire `protocol` goes to 3 with the per-pod rooms (phase 3):
  until then, members still find each other in the global room.

### 6. Joining the PodTorrent network

- A pod is one network node. Only the plan's head runs the agent and writes `network-manifest.json`, and
  only while every hop is connected. `slots: 1` per model is then real capacity.
- **Private pod**: the owner sets the head, and the node token and price live on that machine.
- **Alone**: the machine is its own head. It joins with its own token once it holds every layer of the model.
- **Public pod**: a machine's node token makes it eligible to be head. The matchmaker picks one head per
  public pod, which keeps the "three heads on one chain" problem from coming back.
- Other members' Join Network button says "Served on the network through <head>".
- Splitting earnings between members by layers and compute is up to the network's gateway, and stays
  open for this repo. The head can report the roster in the manifest so the gateway can do it.

### 7. App and UI

- A **Pod** sidebar tab. It sets the mode (Public / Private pod / Alone) and, for a private pod: create,
  invite code, join with code, the member list, the plan editor (split slider, head picker), fill gaps
  from public, and leave. For a public pod it shows the assigned pod: members, this machine's layers, head.
- The Network page follows the pod: token and price appear on the head only.
- Wording: "machine", not "Mac".

### 8. Swarm view: pods as a head with satellites

A pod is one node to the network's gateway, but the swarm view still shows every machine, so you can see
the whole supply and usage of PodTorrent.

- **Census feed**: the rendezvous serves a read-only `/v1/census` stream that replaces the lobby's read of
  the global room (`app/ui/js/lobby.js`). Each pod room and the matchmaker report a summary:

  ```json
  { "pod_id": "…", "kind": "public", "models": ["…"], "on_network": true,
    "head":       { "chip": "M2 Ultra", "mem_gb": 192, "layers": [[0, 16]], "busy": true, "tok_s": 41 },
    "satellites": [{ "chip": "RTX 4090", "mem_gb": 24, "layers": [[16, 40]], "busy": true, "rtt_ms": 38 }] }
  ```

  The census is built from rosters plus members' published records, not from new connections, so it
  doesn't add any links between machines. Unpodded public machines waiting for the matchmaker are listed
  as `idle` supply.
- **Graph**: `viz/graph.js` draws each pod as a cluster: the head as the large node, its members as
  satellites around it, each with an edge labelled with its layer range. A route lights up the edges in
  hop order. Pods link to the network when `on_network` is set. Your own pod is highlighted, and its
  machines show their names.
- **Stat strip**: machines online, pods, pods on the network, total memory serving, layers loaded,
  live tokens/s and requests. These are the marketing numbers, counted per machine, not per pod.
- **Privacy**: machine names appear only to members of the same pod. Everyone else sees chip, memory,
  layers and activity. A private pod is listed in the census by default and can turn listing off in
  the Pod tab.

## Phases

1. **Roster core** (built): `podtorrent/pod.py` (canonical JSON, sign and verify, revisions, invite code
   and proof, `~/.podtorrent/pod.json`), `tests/pod_vectors.json`, `tests/test_pod.py`. No behaviour change.
2. **Peer enforcement on a roster** (built): `PeerNet.allowed` gates dialing, punch replies, auth and
   every stream. `prune()` drops removed members. The peer reloads `pod.json` every 2 s, plans and
   offers routes over members only, loads its own plan hops (and the head) itself, and in a pod
   accepts `M_LOAD` only from the owner. With no `pod.json`, nothing changes: the global room is the
   implicit public pod. `podtorrent pod show|new|add|remove|plan|export|import|leave` edits the roster by
   hand. Rosters move between machines as files until invites exist. Tests: `tests/test_pod_peer.py`,
   plus membership tests in `tests/test_quic.py`.
3. **Private pods end to end** (built and deployed): the `Pod` Durable Object (`rendezvous/src/index.ts`,
   roster check in `rendezvous/src/roster.ts`, tested against the vectors by `npm test`). The peer moves
   between the public room and its pod's room as its pod changes, adopts newer rosters, and goes back
   to public when removed. As owner it admits valid invites (`~/.podtorrent/pod-invites.json`) and
   signs out members that leave, and disbanding sends every member back to public. `/api/pod*` endpoints
   and the **Pod** tab (create, invite, join, members, remove, split by memory or by hand, head, leave or
   disband). Only plan heads write models into the network manifest, and the Network page hides Join on
   other members. Tested locally with `wrangler dev` and three peers (two in a pod, one public). Not yet:
   the wire `protocol` bump, and unloading layers a new plan no longer gives this machine.
4. **Matchmaker** (built and deployed): the `Matchmaker` Durable Object (`/v1/public` lobby and
   `/v1/census`, `rendezvous/src/index.ts`); its decisions are pure functions in `rendezvous/src/match.ts`,
   tested by `test/match.test.ts`. A machine in no pod proves its key in the lobby (`podtorrent-room|public|<nonce>`)
   and sends `supply` (models complete on disk with their size and the layers it already serves, free
   memory, whether it has a node token). The matchmaker covers each model greedily (holders of a layer
   first, then most room), picks the head (a tokened member, else layer 0's), signs a public roster that
   expires in 10 min, installs it in the pod's room (Durable Object RPC) and sends `assign` to the members,
   who move there. Pod rooms report members online and a census summary on every change and sweep; the
   matchmaker renews healthy rosters at half-life, replaces a member missing for 60 s from the lobby's idle
   machines, and otherwise dissolves the pod (`dissolved` sends members back to the lobby). The census
   lists pods (chips, memory, layers, `on_network`, never names or keys) and idle machines; the app's
   lobby and swarm graph draw it as heads with satellites. The key's seed is the Worker secret
   `MATCHMAKER_SEED`; its public half is `MATCHMAKERS` in `pod.py` and `roster.ts`. Peers fall back to the
   global room when the rendezvous has no lobby (before the deploy); the `Swarm` class stays for machines
   from 0.1.24 and earlier. Not yet: reachability and RTT in pod formation, chatting through a public pod without
   serving, models wanted but not on disk yet, the census stat strip, hiding a private pod from the census,
   and video machines (the video swarm used the global room, so unpodded machines no longer link).
5. **iOS** (built): `ios/PodTorrentKit`, a Swift package (CryptoKit Ed25519, no other dependencies) with
   canonical JSON, roster checks, invites, the room handshake, joining with a code and waiting in the
   public lobby. It passes every shared vector, and its room tests pass against `wrangler dev` (two Swift
   machines get one public pod and enter its room). Not yet: an app that uses it, and the QUIC side
   (membership checks on links), which comes with the iOS peer itself.
6. **Test on different networks**: a private A+B pod at 50/50, with C and D online in public mode serving
   the same model. A and B never route through C or D. C and D get their own public pod. The network sees
   one node per pod.

## Decisions to make

- **Default mode for a new install**: Public (proposed, today's behaviour) or Alone until the user picks?
- **Private pods in the census**: listed by default without machine names (proposed), or hidden by default?
- **Invite approval**: accept a valid code automatically (proposed), or also require an Approve click?
- **Owner loss**: v1 ties a private pod to the owner machine's key. If that machine is wiped, recreate the
  pod. An exportable pod key or a second admin can come later.
