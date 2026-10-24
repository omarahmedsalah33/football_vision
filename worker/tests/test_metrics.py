import numpy as np
import pytest

from fa_worker.analysis.geometry import foot_points, on_pitch, project
from fa_worker.analysis.metrics import expected_people, frame_shape, min_team_players, team_shape_windows, track_summary
from fa_worker.analysis.teams import SightingBank, _rgb_to_lab, assign_teams, shirt_colour, sighting_quality, track_colour

L, W = 105.0, 68.0


def test_distance_of_a_steady_run_is_measured_correctly():
    # 2 m/s along x for 10 s, sampled at 4 fps.
    samples = [(i * 0.25, 10 + 2 * i * 0.25, 30.0) for i in range(41)]
    s = track_summary(samples, 0.25, L, W)
    assert s["distance_m"] == pytest.approx(20.0, abs=0.3)
    assert s["coverage"] == pytest.approx(1.0)
    assert s["distance_time_share"] == pytest.approx(1.0)


def test_impossible_jumps_are_excluded_not_counted():
    # Same run, but an identity switch teleports the track 40 m for one frame.
    samples = [(i * 0.25, 10 + 2 * i * 0.25, 30.0) for i in range(41)]
    samples[20] = (5.0, 60.0, 30.0)
    s = track_summary(samples, 0.25, L, W)
    assert s["distance_m"] < 21.0, "the teleport must not add ~80 m of fake running"
    assert s["distance_time_share"] < 1.0, "the excluded time is reported"


def test_gaps_lower_coverage_and_heatmap_counts_cells():
    samples = [(0.0, 2.0, 2.0), (0.25, 2.5, 2.5), (5.0, 52.0, 34.0)]
    s = track_summary(samples, 0.25, L, W)
    assert s["coverage"] < 0.2
    grid = np.array(s["heatmap"])
    assert grid.shape == (14, 21)
    assert grid[0, 0] == 2 and grid[6, 10] == 1 and grid.sum() == 3


def formation(defends_left: bool) -> np.ndarray:
    """A 1-4-3-3 with a goalkeeper, in pitch metres."""
    gk = [(5, 34)]
    defs = [(20, 10), (18, 26), (18, 42), (20, 58)]
    mids = [(38, 20), (35, 34), (38, 48)]
    fwds = [(55, 14), (58, 34), (55, 54)]
    pts = np.array(gk + defs + mids + fwds, dtype=float)
    if not defends_left:
        pts[:, 0] = L - pts[:, 0]
    return pts


def test_team_shape_excludes_the_goalkeeper_and_measures_lines():
    s = frame_shape(formation(True), defends_left=True, length=L)
    assert s["width"] == pytest.approx(58 - 10)
    assert s["depth"] == pytest.approx(58 - 18)  # deepest outfield (18) to highest (58), keeper excluded
    assert s["line_height"] == pytest.approx((18 + 18 + 20) / 3)
    assert s["players"] == 11
    mirrored = frame_shape(formation(False), defends_left=False, length=L)
    assert mirrored["line_height"] == pytest.approx(s["line_height"]), "same shape from the other end"


def test_windows_need_enough_players_otherwise_insufficient():
    full = {"a": formation(True), "b": formation(False)}
    thin = {"a": formation(True)[:5], "b": formation(False)}
    frames = [(t * 0.25, full) for t in range(40)] + [(10 + t * 0.25, thin) for t in range(40)]
    windows = team_shape_windows(frames, L, window_s=10)
    assert len(windows) == 2
    assert windows[0]["a"]["width"] == pytest.approx(48)
    assert windows[0]["b"] is not None
    assert windows[1]["a"] is None, "5 visible players is not evidence of a team shape"
    assert windows[1]["b"] is not None


def test_projection_and_pitch_filter():
    H = np.array([[0.05, 0, 0], [0, 0.05, 0], [0, 0, 1.0]])
    feet = foot_points(np.array([[100, 100, 140, 400], [2000, 0, 2040, 1800]], dtype=float))
    pts = project(H, feet)
    assert pts[0] == pytest.approx([6.0, 20.0])
    assert list(on_pitch(pts, L, W)) == [True, False]


def lab(rgb):
    return _rgb_to_lab(np.array([rgb], dtype=float))[0]


def kit(rgb, rng, shade=1.0):
    """One clear sighting: (clarity, torso colour) of a kit with noise, on grass."""
    img = np.zeros((100, 60, 3), dtype=np.uint8)
    img[:, :] = [40, 140, 50]
    colour = np.clip(np.array(rgb) * shade + rng.normal(0, 10, (35, 20, 3)), 0, 255)
    img[15:50, 20:40] = colour.astype(np.uint8)
    return (80.0, shirt_colour(img, np.array([10, 0, 50, 100])))


def match_samples(rng, extra=None):
    """Ten red and ten blue players, red ones in sun or shade, plus extra tracks; all on screen together."""
    samples, seen = {}, {}
    times = [i * 0.25 for i in range(40)]
    for i in range(10):
        samples[i] = [kit([200, 30, 30], rng, 1.0 if i < 5 else 0.7) for _ in range(5)]
        samples[100 + i] = [kit([30, 50, 200], rng) for _ in range(5)]
        seen[i] = seen[100 + i] = times
    for tid, rgb in (extra or {}).items():
        samples[tid] = [kit(rgb, rng) for _ in range(5)]
        seen[tid] = times
    return samples, seen


def test_teams_split_by_shirt_colour_and_officials_are_other():
    rng = np.random.default_rng(1)
    samples, seen = match_samples(rng, {999: [240, 230, 40], 998: [250, 120, 20]})  # referee, goalkeeper
    teams, quality = assign_teams(samples, seen)
    reds = {teams[i] for i in range(10)}
    blues = {teams[100 + i] for i in range(10)}
    assert len(reds) == 1 and len(blues) == 1 and reds != blues and None not in reds | blues, "shade doesn't split a team"
    assert teams[999] is None and teams[998] is None, "a referee or goalkeeper is never forced into a team"
    assert quality["separation"] > 40


def test_the_most_different_colours_dont_hijack_the_teams():
    # The old method started from the two most different colours (referee vs goalkeeper) and lost the teams.
    rng = np.random.default_rng(2)
    samples, seen = match_samples(rng, {997: [255, 255, 0], 996: [255, 100, 0], 995: [10, 10, 10]})
    teams, _ = assign_teams(samples, seen)
    assigned = [teams[i] for i in [*range(10), *range(100, 110)]]
    assert None not in assigned and len(set(assigned)) == 2


def test_officials_seen_alone_are_left_out_even_in_a_team_like_colour():
    # A referee in dark blue, close to one team's colour but never more than one on screen.
    rng = np.random.default_rng(3)
    samples, seen = match_samples(rng)
    for j in range(3):  # three referees' tracks over the match, one at a time
        samples[900 + j] = [kit([20, 20, 90], rng) for _ in range(5)]
        seen[900 + j] = [100 + j * 20 + i * 0.25 for i in range(40)]
    teams, quality = assign_teams(samples, seen)
    assert all(teams[900 + j] is None for j in range(3))
    assert quality["officialGroups"] >= 1


def test_the_largest_sighting_decides_a_players_colour():
    bank = SightingBank(keep=3)
    red, blur = np.array([45.0, 60, 40]), np.array([60.0, 0, 0])
    for size in (20, 25, 30, 35):  # distant, blurry sightings, recorded first
        bank.add(1, size, blur)
    assert bank.wants(1, 90) and not bank.wants(1, 10)
    bank.add(1, 90, red)
    assert np.allclose(track_colour(bank.samples([1])[1]), red)


def test_overlapped_or_cut_off_sightings_only_count_as_a_fallback():
    shape = (720, 1280, 3)
    box = np.array([100, 100, 140, 200])
    assert sighting_quality(box, np.array([box]), shape) == 100
    merged = np.array([100, 100, 160, 230])  # bigger, but someone overlaps it
    assert sighting_quality(merged, np.array([merged, [130, 110, 170, 210]]), shape) < 2
    assert sighting_quality(np.array([0, 100, 40, 200]), np.array([]), shape) == 1, "cut off by the frame edge"


def test_too_few_samples_means_no_team():
    teams, _ = assign_teams({1: [(80.0, lab([200, 0, 0]))], 2: [(80.0, lab([0, 0, 200]))]})
    assert teams == {1: None, 2: None}


def test_shirt_colour_ignores_grass():
    img = np.zeros((100, 60, 3), dtype=np.uint8)
    img[:, :] = [40, 140, 50]  # grass
    img[15:50, 20:40] = [200, 30, 30]  # red shirt on the torso
    c = shirt_colour(img, np.array([10, 0, 50, 100]))
    assert np.linalg.norm(c - lab([200, 30, 30])) < 5


def test_player_thresholds_follow_the_pitch_format():
    assert min_team_players(11) == 8, "unchanged for full-size football"
    assert min_team_players(7) == 5
    assert min_team_players(5) == 4
    assert expected_people(11) == 25
    assert expected_people(5) == 11


def test_small_sided_team_shape_is_measured_with_five_players():
    # 5-a-side on a 40 × 20 m pitch: keeper plus a 2-2 outfield.
    team = np.array([(2, 10), (10, 4), (10, 16), (22, 6), (22, 14)], dtype=float)
    s = frame_shape(team, defends_left=True, length=40, players_per_side=5)
    assert s is not None
    assert s["width"] == pytest.approx(12)  # 4 → 16, keeper excluded
    assert s["depth"] == pytest.approx(12)  # 10 → 22
    assert frame_shape(team, defends_left=True, length=40) is None, "with 11-a-side rules, 5 players are too few"
    assert frame_shape(team[:3], defends_left=True, length=40, players_per_side=5) is None, "3 of 5 is not a team shape"

    frames = [(t * 0.25, {"a": team, "b": team.copy()}) for t in range(40)]
    windows = team_shape_windows(frames, 40, window_s=10, players_per_side=5)
    assert windows[0]["a"] is not None and windows[0]["b"] is not None
