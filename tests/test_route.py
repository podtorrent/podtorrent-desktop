from podtorrent.route import Hop, Offer, gaps, plan


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
