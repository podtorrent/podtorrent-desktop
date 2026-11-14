"""The servers this build talks to: the rendezvous, the matchmaker keys it signs public rosters with,
and the PodTorrent network the agent joins.

None of them are in the repository. Official builds get `podtorrent/endpoints.json` written by CI;
a fork or a source checkout copies `endpoints.example.json` to `podtorrent/endpoints.json` and points it at
servers it deployed itself (CONTRIBUTING.md). Without one the peer still runs, alone, with no swarm.

Lookup order: the file named by PODTORRENT_ENDPOINTS, then `endpoints.json` next to this module.
PODTORRENT_RENDEZVOUS overrides the rendezvous, e.g. ws://localhost:8787 for `wrangler dev`.

`python -m podtorrent.endpoints network NAME` prints that network's agent URL (the headless script uses it)."""
import json
import os
import sys
from functools import cache
from pathlib import Path

FILE = Path(__file__).with_name("endpoints.json")


@cache
def load() -> dict:
    path = Path(os.environ["PODTORRENT_ENDPOINTS"]) if os.environ.get("PODTORRENT_ENDPOINTS") else FILE
    try:
        cfg = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    if not isinstance(cfg, dict):
        raise TypeError(f"{path}: expected a JSON object")
    return cfg


def rendezvous() -> str:
    """The rendezvous base URL, or "" when this build has none."""
    return (os.environ.get("PODTORRENT_RENDEZVOUS") or load().get("rendezvous") or "").rstrip("/")


def matchmakers() -> tuple[str, ...]:
    """Public keys (hex) allowed to sign public rosters: the rendezvous Worker's MATCHMAKER_SEED."""
    return tuple(load().get("matchmakers") or ())


def network(name: str) -> dict | None:
    """{"connect": wss URL for the agent, "dashboard": https URL} of a network, or None."""
    n = (load().get("networks") or {}).get(name)
    return n if isinstance(n, dict) and n.get("connect") else None


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "network" and (n := network(sys.argv[2])):
        print(n["connect"])
        sys.exit(0)
    sys.exit(1)
