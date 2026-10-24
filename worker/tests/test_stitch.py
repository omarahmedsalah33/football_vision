import numpy as np

from fa_worker.analysis.metrics import physical_profile
from fa_worker.analysis.stitch import stitch


def run(x0, y, t0, t1, vx=3.0, dt=0.25):
    return [(t, x0 + vx * (t - t0), y) for t in np.arange(t0, t1, dt)]


def test_a_player_hidden_for_a_moment_is_joined_back_together():
    tracks = {1: run(10, 30, 0, 10), 2: run(10 + 3 * 12, 30, 12, 20)}  # 2 s behind someone, same pace
    assert stitch(tracks, {1: "a", 2: "a"}) == [[1, 2]]


def test_fragments_are_not_joined_across_teams_or_impossible_distances():
    tracks = {1: run(10, 30, 0, 10), 2: run(40, 30, 12, 20), 3: run(90, 30, 11, 20)}
    assert sorted(stitch(tracks, {1: "a", 2: "b", 3: "a"})) == [[1], [2], [3]], "other team, or 50 m in 1 s"


def test_ambiguous_continuations_are_left_apart():
    # Two team-mates reappear side by side where one disappeared: either could be him.
    tracks = {1: run(10, 30, 0, 10), 2: run(46, 30.5, 12, 20), 3: run(46, 29.5, 12, 20)}
    chains = stitch(tracks, {1: "a", 2: "a", 3: "a"})
    assert [1] in chains and len(chains) == 3


def test_officials_are_never_joined():
    tracks = {1: run(10, 30, 0, 10), 2: run(46, 30, 12, 20)}
    assert stitch(tracks, {1: "other", 2: "other"}) == [[1], [2]]


def test_running_profile_recovers_known_speeds():
    dt, rng = 0.25, np.random.default_rng(0)
    t, x, samples = 0.0, 10.0, []
    for v, dur in [(3.0, 20), (8.0, 3), (1.5, 20)]:  # jog, sprint, walk
        for _ in range(int(dur / dt)):
            samples.append((t, x + rng.normal(0, 0.15), 30 + rng.normal(0, 0.15)))
            x, t = x + v * dt, t + dt
    p = physical_profile(samples, dt)
    assert abs(p["distance_m"] - 114) < 4
    assert abs(p["top_speed_ms"] - 8.0) < 0.5
    assert p["sprints"] == 1
    assert 18 < p["hi_distance_m"] < 30  # the 24 m sprint, minus smoothing at its ends
    assert p["late_vs_early"] is None, "too short to judge stamina"


def test_stamina_compares_the_last_third_with_the_first():
    dt = 0.25
    samples, t, x = [], 0.0, 0.0
    for v in (3.0, 2.0, 1.5):  # 4 minutes each: slowing down
        for _ in range(int(240 / dt)):
            samples.append((t, 50 + 20 * np.sin(x / 20), 34 + 20 * np.cos(x / 20)))
            x, t = x + v * dt, t + dt
    p = physical_profile(samples, dt)
    assert p["minutes"] > 11
    assert abs(p["late_vs_early"] - 0.5) < 0.08
