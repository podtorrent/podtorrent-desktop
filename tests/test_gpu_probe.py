"""Finding a GPU's real memory limit by probing, and remembering it."""

from podtorrent import gpu_probe


def test_finds_limit_between_reported_and_ceiling():
    limit = 40.0
    got = gpu_probe.find_limit(lambda gb: gb <= limit, known_ok_gb=4.0, ceiling_gb=100.0)
    assert limit - gpu_probe.TOLERANCE_GB <= got <= limit


def test_ceiling_fits():
    assert gpu_probe.find_limit(lambda gb: True, 4.0, 54.0) == 54.0


def test_nothing_above_reported_fits():
    # A discrete card: the driver's number is the real one.
    assert gpu_probe.find_limit(lambda gb: gb <= 16.0, 16.0, 54.0) == 16.0


def test_no_probe_when_reported_is_already_near_ceiling():
    def boom(gb):
        raise AssertionError("should not allocate")
    assert gpu_probe.find_limit(boom, 50.0, 50.5) == 50.0


def test_cache_reused_and_keyed(tmp_path, monkeypatch):
    monkeypatch.setenv("PODTORRENT_HOME", str(tmp_path))
    calls = []

    def probe():
        calls.append(1)
        return 42.0

    assert gpu_probe.probe_cached("gfx1151|2.9|64", probe) == 42.0
    assert gpu_probe.probe_cached("gfx1151|2.9|64", probe) == 42.0
    assert len(calls) == 1
    gpu_probe.probe_cached("gfx1151|2.9|192", probe)  # RAM changed: probe again
    assert len(calls) == 2


def test_corrupt_cache_is_ignored(tmp_path, monkeypatch):
    monkeypatch.setenv("PODTORRENT_HOME", str(tmp_path))
    (tmp_path / "gpu-probe.json").write_text("{nope")
    assert gpu_probe.probe_cached("k", lambda: 7.0) == 7.0
