"""End-to-end analysis on a synthetic match with known ground truth.

The video is rendered from a raised camera on the halfway line: green pitch, 10 red players defending
the left goal, 10 blue players defending the right, one yellow referee, all moving on known paths.
Only the detector is replaced (it replays the true boxes); tracking, team clustering, projection and
metrics are the real implementations, so their answers can be checked against the truth.
"""

from __future__ import annotations

import gzip
import json
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
import pytest

pytest.importorskip("trackers", reason="computer-vision extra not installed (pip install -e '.[cv]')")

from fa_worker import queue  # noqa: E402
from fa_worker.analysis.metrics import frame_shape  # noqa: E402
from fa_worker.analysis.run import analyse  # noqa: E402
from fa_worker.pipeline import process  # noqa: E402

from .conftest import job_row, make_job, usage  # noqa: E402

L, W = 105.0, 68.0
IMG_W, IMG_H = 1280, 720
FPS = 8
SECONDS = 30
RED, BLUE, YELLOW = (205, 30, 35), (30, 60, 210), (240, 225, 30)


def homography(src: list, dst: list) -> np.ndarray:
    """Exact 4-point homography src → dst (8×8 linear solve, h33 = 1)."""
    a, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    h = np.linalg.solve(np.array(a, float), np.array(b, float))
    return np.append(h, 1).reshape(3, 3)


PITCH_CORNERS = [(0, 0), (L, 0), (L, W), (0, W)]
IMAGE_CORNERS = [(260, 110), (1020, 110), (1255, 700), (25, 700)]
P2I = homography(PITCH_CORNERS, IMAGE_CORNERS)
I2P = np.linalg.inv(P2I)


def to_image(x, y):
    p = P2I @ np.array([x, y, 1.0])
    return p[0] / p[2], p[1] / p[2]


# 1-4-3-2 formations (keeper first), mirrored for the blue team.
BASE = [(5, 34), (22, 10), (20, 26), (20, 42), (22, 58), (38, 18), (36, 34), (38, 50), (50, 26), (50, 42)]


def position(team: str, i: int, t: float) -> tuple[float, float]:
    bx, by = BASE[i]
    dx = 4 * np.sin(0.2 * t + i)  # gentle, realistic movement (< 1 m/s)
    dy = 3 * np.cos(0.15 * t + 2 * i)
    if team == "red":
        return bx + dx, by + dy
    if team == "blue":
        return L - bx - dx, by + dy
    return 52.5 + 8 * np.sin(0.1 * t), 34 + 6 * np.cos(0.1 * t)  # referee


PEOPLE = [("red", i) for i in range(10)] + [("blue", i) for i in range(10)] + [("ref", 0)]
HIDDEN, HIDDEN_FROM, HIDDEN_TO = ("red", 6), 12.0, 15.0  # longer than the tracker can bridge


def box_at(x, y):
    fx, fy = to_image(x, y)
    h = 26 + 40 * (fy / IMG_H)  # nearer to the camera = taller
    w = 0.4 * h
    return [fx - w / 2, fy - h, fx + w / 2, fy]


@pytest.fixture(scope="module")
def synthetic_match(tmp_path_factory):
    out = tmp_path_factory.mktemp("synthetic")
    video = out / "match.mp4"
    boxes: dict[str, list] = {}
    with av.open(str(video), "w", format="mp4") as c:
        s = c.add_stream("mpeg4", rate=Fraction(FPS, 1))
        s.width, s.height, s.pix_fmt = IMG_W, IMG_H, "yuv420p"
        s.bit_rate = 6_000_000
        for f in range(SECONDS * FPS):
            t = f / FPS
            img = np.zeros((IMG_H, IMG_W, 3), np.uint8)
            img[:] = (40, 130, 55)
            frame_boxes = []
            for team, i in PEOPLE:
                x, y = position(team, i, t)
                x1, y1, x2, y2 = box_at(x, y)
                colour = {"red": RED, "blue": BLUE, "ref": YELLOW}[team]
                yi1, yi2, xi1, xi2 = int(y1), int(y2), int(x1), int(x2)
                img[yi1 : yi1 + (yi2 - yi1) // 2, xi1:xi2] = colour  # shirt
                img[yi1 + (yi2 - yi1) // 2 : yi2, xi1:xi2] = (20, 20, 20)  # shorts and legs
                if (team, i) == HIDDEN and HIDDEN_FROM <= t < HIDDEN_TO:
                    continue  # missed by the detector (e.g. behind another player): the track breaks
                frame_boxes.append([x1, y1, x2, y2, 0.9])
            boxes[f"{round(t, 2)}"] = frame_boxes
            for p in s.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
                c.mux(p)
        for p in s.encode():
            c.mux(p)
    boxes_file = out / "boxes.json"
    boxes_file.write_text(json.dumps(boxes))
    cfg = {
        "pipelineVersion": "test",
        "sampleFps": 4,
        "detector": {"kind": "synthetic", "boxes_file": str(boxes_file)},
        "calibration": {
            "id": None,
            "homography": {"matrix": I2P.flatten().tolist(), "pitch": {"length": L, "width": W}},
            "imageWidth": IMG_W,
            "imageHeight": IMG_H,
            "rmsErrorM": 0.2,
            "looErrorM": 0.3,
        },
    }
    result_dir = out / "result"
    result_dir.mkdir()
    result = analyse(video, cfg, result_dir)
    return {"video": video, "cfg": cfg, "result": result, "dir": result_dir}


def test_one_track_per_person_and_teams_split_by_colour(synthetic_match):
    tracks = synthetic_match["result"]["tracks"]
    assert 21 <= len(tracks) <= 23, "clean detections should give (almost) one track per person"
    counts = {k: sum(t["team"] == k for t in tracks) for k in ("a", "b", "other")}
    assert counts["a"] == 10 and counts["b"] == 10
    assert counts["other"] >= 1, "the referee is not forced into a team"


def test_team_a_is_the_team_defending_the_left_goal(synthetic_match):
    a = [t for t in synthetic_match["result"]["tracks"] if t["team"] == "a"]
    assert np.mean([t["avg_x"] for t in a]) < L / 2


def test_average_positions_match_the_truth(synthetic_match):
    # The red keeper's true average position over the clip.
    ts = np.arange(0, SECONDS, 0.25)
    true = np.mean([position("red", 0, t) for t in ts], axis=0)
    keeper = min((t for t in synthetic_match["result"]["tracks"] if t["team"] == "a"), key=lambda t: t["avg_x"])
    assert abs(keeper["avg_x"] - true[0]) < 0.75 and abs(keeper["avg_y"] - true[1]) < 0.75


def test_team_width_matches_the_truth(synthetic_match):
    windows = synthetic_match["result"]["summary"]["teamShape"]
    w = windows[1]  # 10–20 s
    assert w["a"] is not None and w["b"] is not None
    ts = np.arange(w["start"], w["end"], 0.25)
    true_widths = [frame_shape(np.array([position("red", i, t) for i in range(10)]), True, L)["width"] for t in ts]
    assert w["a"]["width"] == pytest.approx(float(np.median(true_widths)), abs=1.0)


def test_distance_covered_is_close_to_the_true_path_length(synthetic_match):
    ts = np.arange(0, SECONDS, 0.01)
    path = np.array([position("red", 5, t) for t in ts])
    true_len = float(np.sum(np.linalg.norm(np.diff(path, axis=0), axis=1)))
    tracks = [t for t in synthetic_match["result"]["tracks"] if t["team"] == "a"]
    target = np.mean([position("red", 5, t) for t in np.arange(0, SECONDS, 0.25)], axis=0)
    t5 = min(tracks, key=lambda t: np.hypot(t["avg_x"] - target[0], t["avg_y"] - target[1]))
    assert t5["distance_m"] == pytest.approx(true_len, rel=0.15)


def test_summary_records_provenance_quality_and_models(synthetic_match):
    s = synthetic_match["result"]["summary"]
    assert s["provenance"]["team_width"] == "measured"  # calibration error 0.3 m
    assert s["provenance"]["distance_covered"] == "estimated"
    assert s["provenance"]["xg"] == "not_available"
    assert s["models"]["detector"] == "synthetic-ground-truth"
    assert s["models"]["tracker"].startswith("bytetrack(trackers")
    assert s["quality"]["detection"]["framesAnalysed"] == SECONDS * 4
    lines = gzip.open(synthetic_match["dir"] / "tracks.jsonl.gz", "rt").read().splitlines()
    assert len(lines) == SECONDS * 4


class FileStorage:
    def __init__(self, source: Path):
        self.source = source
        self.uploaded: dict[str, int] = {}

    def download(self, key, dest, expected_size):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(self.source.read_bytes())
        return dest

    def put_file(self, key, path, content_type):
        self.uploaded[key] = Path(path).stat().st_size


def test_full_analyze_job_persists_results_and_consumes_allowance(conn, settings, synthetic_match):
    video = synthetic_match["video"]
    job = make_job(
        conn,
        kind="analyze",
        video_status="validated",
        size_bytes=video.stat().st_size,
        config={k: v for k, v in synthetic_match["cfg"].items()},
    )
    storage = FileStorage(video)
    claimed = None
    while (j := queue.claim(conn, settings.worker_id, settings.lease_seconds)) is not None:
        if j.id == str(job["id"]):
            claimed = j
            break
    assert claimed and claimed.kind == "analyze"
    assert process(conn, storage, settings, claimed) == "succeeded"

    row = job_row(conn, job["id"])
    assert row["status"] == "succeeded" and row["model_versions"]["detector"] == "synthetic-ground-truth"
    res = conn.execute("select summary, tracks_key from analysis_results where job_id = %s", (job["id"],)).fetchone()
    assert res["tracks_key"].endswith(f"/analysis/{job['id']}/tracks.jsonl.gz") and res["tracks_key"] in storage.uploaded
    n = conn.execute("select count(*) as n from analysis_tracks where job_id = %s", (job["id"],)).fetchone()["n"]
    assert n >= 21
    rows = conn.execute("select metrics, crop_key from analysis_tracks where job_id = %s and team in ('a', 'b')", (job["id"],)).fetchall()
    assert all(r["metrics"]["minutes"] > 0 for r in rows), "running profiles are stored"
    assert all(r["crop_key"] and r["crop_key"] in storage.uploaded and "/players/" in r["crop_key"] for r in rows)
    assert usage(conn, job["org_id"]) == (1, 0), "a successful analysis uses one unit of the allowance"


def test_a_player_missed_for_three_seconds_is_still_one_player(synthetic_match):
    target = np.mean([position(*HIDDEN, t) for t in np.arange(0, SECONDS, 0.25)], axis=0)
    a = [t for t in synthetic_match["result"]["tracks"] if t["team"] == "a"]
    him = min(a, key=lambda t: np.hypot(t["avg_x"] - target[0], t["avg_y"] - target[1]))
    assert him["fragments"] == 2, "the two fragments were joined"
    assert him["last_seconds"] - him["first_seconds"] > SECONDS - 2
    assert len(a) == 10, "still exactly ten red players"


def test_every_player_has_a_running_profile_and_a_photo(synthetic_match):
    players = [t for t in synthetic_match["result"]["tracks"] if t["team"] in ("a", "b")]
    for p in players:
        prof = p["profile"]
        assert 0.3 < prof["minutes"] <= SECONDS / 60 + 0.01
        assert prof["top_speed_ms"] < 3.0, "these synthetic players never run fast"
        assert prof["sprints"] == 0
        assert p["crop_file"], "a photo for staff to recognise the player"
        assert (synthetic_match["dir"] / "crops" / p["crop_file"]).stat().st_size > 500

