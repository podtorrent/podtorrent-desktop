from podtorrent.route import Hop, Offer, coverage, gaps, plan


def spans(hops):
    return [(h.peer_id, h.lo, h.hi) for h in hops]


def test_single_peer_covers_all():
    hops, g = plan(48, [Offer("a", "A", 0, 48, 10)])
    assert spans(hops) == [("a", 0, 48)] and g == []


def test_three_disjoint():
    offers = [Offer("a", "A", 0, 16, 5), Offer("b", "B", 16, 32, 5), Offer("c", "C", 32, 48, 5)]
    assert spans(plan(48, offers)[0]) == [("a", 0, 16), ("b", 16, 32), ("c", 32, 48)]


def test_gap_reported():
    hops, g = plan(48, [Offer("a", "A", 0, 16), Offer("c", "C", 32, 48)])
    assert hops == [] and g == [(16, 32)]


def test_overlap_prefers_fewer_hops():
    offers = [Offer("a", "A", 0, 24, 5), Offer("b", "B", 8, 48, 5), Offer("c", "C", 24, 48, 5)]
    hops, _ = plan(48, offers)
    assert len(hops) == 2 and hops[0].peer_id == "a"


def test_overlap_prefers_low_rtt():
    offers = [Offer("a", "A", 0, 24, 0), Offer("far", "F", 16, 48, 200), Offer("near", "N", 24, 48, 10)]
    assert spans(plan(48, offers)[0]) == [("a", 0, 24), ("near", 24, 48)]


def test_sub_range_handoff():
    # c only serves [8, 48): a covers the head, and the cheap hand-off is at c's start.
    offers = [Offer("a", "A", 0, 24, 0), Offer("c", "C", 8, 48, 10)]
    assert spans(plan(48, offers)[0]) == [("a", 0, 8), ("c", 8, 48)]


def test_equal_cost_prefers_fewer_hops():
    offers = [Offer("a", "A", 0, 24, 0), Offer("b", "B", 0, 48, 30)]
    assert spans(plan(48, offers)[0]) == [("b", 0, 48)]


def test_one_far_peer_beats_two_hops_when_cheaper():
    offers = [Offer("a", "A", 0, 24, 40), Offer("b", "B", 24, 48, 40), Offer("c", "C", 0, 48, 50)]
    assert spans(plan(48, offers)[0]) == [("c", 0, 48)]


def test_exclude_reroutes():
    offers = [Offer("a", "A", 0, 16, 5), Offer("b", "B", 16, 48, 5), Offer("b2", "B2", 16, 48, 20)]
    assert spans(plan(48, offers)[0])[1][0] == "b"
    assert spans(plan(48, offers, exclude={"b"})[0])[1][0] == "b2"
    assert plan(48, offers, exclude={"b", "b2"}) == ([], [(16, 48)])


def test_ties_deterministic():
    offers = [Offer("y", "Y", 0, 48, 10), Offer("x", "X", 0, 48, 10)]
    assert spans(plan(48, offers)[0]) == [("x", 0, 48)]
    assert spans(plan(48, list(reversed(offers)))[0]) == [("x", 0, 48)]


def test_offers_beyond_model_clamped():
    assert spans(plan(16, [Offer("a", "A", 0, 48)])[0]) == [("a", 0, 16)]


def test_gaps_helper():
    assert gaps(10, []) == [(0, 10)]
    assert gaps(10, [Offer("a", "A", 2, 4), Offer("b", "B", 6, 10)]) == [(0, 2), (4, 6)]


def test_coverage_counts_distinct_peers():
    offers = [Offer("a", "A", 0, 4), Offer("a", "A", 2, 6), Offer("b", "B", 4, 8)]
    assert coverage(8, offers) == [1, 1, 1, 1, 2, 2, 1, 1]
    assert coverage(4, [Offer("a", "A", 2, 99)]) == [0, 0, 1, 1]


# ---------- video routes ----------
import pytest  # noqa: E402

from podtorrent.route import VideoOffer, can_render, parse_role, plan_video  # noqa: E402


def V(pid, *roles, rtt=10):
    return VideoOffer(pid, pid.upper(), tuple(roles), rtt)


def test_video_two_halves_and_renderer():
    offers = [V("me"), V("b", "h3-encoder:0:25"), V("c", "h3-encoder:25:50", "h3-video:11.9:64")]
    hops, video = plan_video(50, offers, "me")
    assert spans(hops) == [("b", 0, 25), ("c", 25, 50)] and video == "c"


def test_video_prefers_whole_slice_and_this_machine():
    offers = [V("me", "h3-encoder:0:50"), V("b", "h3-encoder:0:25"), V("c", "h3-encoder:25:50", "h3-video")]
    hops, _ = plan_video(50, offers, "me")
    assert spans(hops) == [("me", 0, 50)]
    offers = [V("me", "h3-encoder:0:25"), V("b", "h3-encoder:0:25", rtt=1), V("c", "h3-encoder:25:50", "h3-video")]
    assert spans(plan_video(50, offers, "me")[0])[0] == ("me", 0, 25)


def test_video_slices_must_chain_end_to_start():
    # 0:30 then 25:50 don't chain (a slice runs whole); 0:25 + 25:50 do, through a farther peer
    offers = [V("a", "h3-encoder:0:30", rtt=1), V("b", "h3-encoder:25:50", rtt=1),
              V("far", "h3-encoder:0:25", rtt=300), V("r", "h3-video")]
    assert spans(plan_video(50, offers, "me")[0]) == [("far", 0, 25), ("b", 25, 50)]


def test_video_prefers_closer_hops():
    offers = [V("near", "h3-encoder:0:25", rtt=20), V("far", "h3-encoder:0:25", rtt=200),
              V("c", "h3-encoder:25:50", "h3-video")]
    assert plan_video(50, offers, "me")[0][0].peer_id == "near"


def test_video_gap_named():
    with pytest.raises(ValueError, match="starting at 25"):
        plan_video(50, [V("b", "h3-encoder:0:25"), V("c", "h3-encoder:30:50", "h3-video")], "me")


def test_video_skips_small_gpu():
    offers = [V("b", "h3-encoder:0:50"), V("small", "h3-video:8:64", rtt=1), V("big", "h3-video:11.9:64", rtt=90)]
    assert plan_video(50, offers, "me")[1] == "big"
    with pytest.raises(ValueError, match="SMALL has 8 GB"):
        plan_video(50, offers[:2], "me")
    assert can_render(V("x", "h3-video:16:16")).startswith("has 16 GB of RAM")


def test_video_renderer_prefers_me_then_rtt():
    offers = [V("me", "h3-video"), V("b", "h3-encoder:0:50", "h3-video", rtt=1)]
    assert plan_video(50, offers, "me")[1] == "me"
    offers = [V("b", "h3-encoder:0:50", "h3-video", rtt=40), V("c", "h3-video", rtt=5)]
    assert plan_video(50, offers, "me")[1] == "c"


def test_video_exclude_and_parse():
    offers = [V("b", "h3-encoder:0:50", "h3-video"), V("c", "h3-encoder:0:50")]
    assert spans(plan_video(50, offers, "me", exclude={"c"})[0]) == [("b", 0, 50)]
    assert parse_role("h3-encoder:5:3") is None and parse_role("h3-video:x:y") is None
    assert parse_role("h3-video") == ("video", None, None)
