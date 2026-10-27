import numpy as np
import pytest

from fa_worker.analysis.events import EventAnalyzer, project
from fa_worker.analysis.event_features import CameraMotion, kit_group


def record(i, x, *, kits=("blue", "blue"), motion=True, moving=False):
    shift = i * 6 if moving else 0
    return {
        "t": round(i / 10, 3), "motion": np.eye(3).tolist() if motion else None,
        "people": [[20 + shift, 140, 40 + shift, 180, 0.95], [130, 140, 150, 180, 0.95]],
        "kits": list(kits),
        "balls": [[x - 2, 178, x + 2, 182, 0.95]] if x is not None else [],
    }


def pass_sequence(**kwargs):
    xs = [30] * 8 + [50, 70, 90, 110] + [140] * 8
    return [record(i, x, **kwargs) for i, x in enumerate(xs)]


def test_pass_requires_travel_and_two_stable_same_kit_control_estimates():
    analyzer = EventAnalyzer(640, 360)
    for r in pass_sequence():
        analyzer.observe(r)
    passes = [e for e in analyzer.events if e["type"] == "completed_pass_candidate"]
    assert len(passes) == 1
    assert passes[0]["from_tracklet"] != passes[0]["to_tracklet"]
    assert passes[0]["start_s"] < passes[0]["end_s"]
    assert passes[0]["review_status"] == "pending"
    assert all(value is None for value in analyzer.report()["statistics"].values())


def test_opponent_control_does_not_become_an_incomplete_pass():
    analyzer = EventAnalyzer(640, 360)
    for r in pass_sequence(kits=("blue", "light")):
        analyzer.observe(r)
    assert [e["type"] for e in analyzer.events] == ["control_transfer_candidate"]
    assert analyzer.report()["statistics"]["passes_attempted"] is None


def test_missing_ball_does_not_create_an_inferred_pass():
    analyzer = EventAnalyzer(640, 360)
    for i, r in enumerate(pass_sequence()):
        if 8 <= i <= 12:
            r["balls"] = []
        analyzer.observe(r)
    assert not analyzer.events


def test_unknown_kits_do_not_become_confirmed_teammates():
    analyzer = EventAnalyzer(640, 360)
    for r in pass_sequence(kits=("unknown", "unknown")):
        analyzer.observe(r)
    assert not any(e["type"] == "completed_pass_candidate" for e in analyzer.events)


def test_camera_cut_resets_identity_control_and_goal_anchors():
    analyzer = EventAnalyzer(640, 360, goal_boxes=[(500, 140, 530, 190)])
    for i, r in enumerate(pass_sequence()):
        if i == 9:
            r["motion"] = None
        analyzer.observe(r)
    assert not analyzer.events and not analyzer.goals
    assert analyzer.report()["coverage"]["tracking_discontinuities"] == 1
    assert len(analyzer.report()["tracklets"]) >= 4


def test_camera_pan_does_not_count_as_player_carry_distance():
    analyzer = EventAnalyzer(640, 360)
    for i in range(35):
        r = record(i, 30 + i * 6, moving=True)
        r["people"][1] = [500 + i * 6, 140, 520 + i * 6, 180, 0.95]
        if i:
            r["motion"] = [[1, 0, 6], [0, 1, 0], [0, 0, 1]]
        analyzer.observe(r)
    assert not analyzer.events


def test_carry_is_not_misreported_as_a_successful_dribble():
    analyzer = EventAnalyzer(640, 360)
    for i in range(40):
        r = record(i, 30 + i * 6, moving=True)
        r["people"] = r["people"][:1]
        r["kits"] = ["blue"]
        analyzer.observe(r)
    assert any(e["type"] == "carry_candidate" for e in analyzer.events)
    assert analyzer.report()["statistics"]["successful_dribbles"] is None


def test_sporadic_or_ambiguous_ball_candidates_are_not_control():
    analyzer = EventAnalyzer(640, 360)
    for i in range(20):
        r = record(i, 30)
        r["balls"].append([53, 178, 57, 182, 0.95])
        analyzer.observe(r)
    assert analyzer.report()["coverage"]["coherent_ball_frames"] == 0
    assert not analyzer.events


def test_no_observations_produce_null_statistics_not_zeros():
    report = EventAnalyzer(640, 360).report()
    assert all(v is None for v in report["statistics"].values())
    assert report["coverage"]["coherent_ball_fraction"] == 0


@pytest.mark.parametrize("timestamp", [float("nan"), float("inf"), -1])
def test_invalid_or_reversed_timestamps_fail_explicitly(timestamp):
    analyzer = EventAnalyzer(640, 360)
    analyzer.observe(record(0, 30))
    r = record(1, 30)
    r["t"] = timestamp
    with pytest.raises(ValueError):
        analyzer.observe(r)


def test_kit_appearance_is_not_guessed_from_grass():
    image = np.zeros((100, 100, 3), dtype=np.uint8)
    image[:] = (30, 140, 30)
    assert kit_group(image, [10, 10, 50, 90]) == "unknown"
    image[:] = (200, 50, 20)
    assert kit_group(image, [10, 10, 50, 90]) == "blue"


def test_camera_motion_has_no_homography_when_features_are_missing():
    camera = CameraMotion()
    image = np.zeros((360, 640, 3), dtype=np.uint8)
    assert camera.update(image, []) is None
    assert camera.update(image, []) is None


def test_degenerate_homography_is_rejected():
    with pytest.raises(ValueError):
        project([[2, 3]], np.zeros((3, 3)))


def test_video_report_exports_only_candidates_and_shows_tested_interval(tmp_path):
    import gzip
    import json
    from experiments.report_events import build
    from .conftest import write_video

    video = write_video(tmp_path / "match.mp4", seconds=2)
    output = tmp_path / "results"
    output.mkdir()
    metadata = {"probe": False, "width": 640, "height": 368, "video_duration_s": 3054.53,
                "analysis_fps": 10, "model": "synthetic-test-not-a-detector"}
    (output / "inference.json").write_text(json.dumps(metadata))
    with gzip.open(output / "detections.jsonl.gz", "wt") as target:
        for r in pass_sequence():
            target.write(json.dumps(r) + "\n")
    report = build(output, video)
    page = (output / "report.html").read_text()
    assert "Analyzed source interval: 00:00.00–00:01.90" in page
    assert "not automatically to the entire recording" in page
    assert "Not established" in page and "data:image/jpeg;base64," in page
    assert all(v is None for v in report["statistics"].values())
    assert report["candidate_counts"]["completed_pass_candidate"] == 1
    assert "completed_pass_candidate" in (output / "event-candidates.csv").read_text()
    assert "unverified_tracklet_not_a_unique_player" in (output / "tracklets.csv").read_text()
    assert report["tracklets"][0]["pass_candidates_made"] == 1


def test_sparse_probe_cannot_produce_temporal_statistics(tmp_path):
    import json
    from experiments.report_events import build
    (tmp_path / "inference.json").write_text(json.dumps({"probe": True}))
    with pytest.raises(ValueError, match="Sparse probe"):
        build(tmp_path, tmp_path / "unused.mp4")


def test_goalward_movement_is_not_misreported_as_a_shot_on_target():
    analyzer = EventAnalyzer(640, 360, goal_boxes=[(400, 170, 420, 190)])
    for r in pass_sequence():
        analyzer.observe(r)
    assert any(e["type"] == "goalward_movement_candidate" for e in analyzer.events)
    assert analyzer.report()["statistics"]["shots"] is None
    assert analyzer.report()["statistics"]["shots_on_target"] is None
    assert analyzer.report()["statistics"]["goals"] is None
