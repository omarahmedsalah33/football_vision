"""End-to-end analysis of a synthetic match filmed by a camera that pans and zooms to follow play.

The camera follower, pitch-plane tracking, team clustering and metrics are the real implementations;
only the detector replays the true boxes. Every reported position is checked against the truth.
"""

from __future__ import annotations

import gzip
import json
from fractions import Fraction

import av
import numpy as np
import pytest

pytest.importorskip("trackers", reason="computer-vision extra not installed (pip install -e '.[cv]')")
pytest.importorskip("cv2")

from fa_worker.analysis.run import UserFixable, analyse  # noqa: E402

from . import synthetic_camera as sc  # noqa: E402

FPS = 10  # the upload check accepts 10 fps and up
SECONDS = 24.0
RED, BLUE, YELLOW = (205, 30, 35), (30, 60, 210), (240, 225, 30)
BASE = [(5, 34), (22, 10), (20, 26), (20, 42), (22, 58), (38, 18), (36, 34), (38, 50), (50, 26), (50, 42)]
PEOPLE = [("red", i) for i in range(10)] + [("blue", i) for i in range(10)] + [("ref", 0)]


def position(team: str, i: int, t: float) -> tuple[float, float]:
    bx, by = BASE[i]
    dx, dy = 4 * np.sin(0.2 * t + i), 3 * np.cos(0.15 * t + 2 * i)
    if team == "red":
        return bx + dx, by + dy
    if team == "blue":
        return sc.L - bx - dx, by + dy
    return 52.5 + 8 * np.sin(0.1 * t), 34 + 6 * np.cos(0.1 * t)


@pytest.fixture(scope="module")
def moving_match(tmp_path_factory):
    out = tmp_path_factory.mktemp("moving")
    video = out / "match.mp4"
    tex = sc.world_texture()
    boxes: dict[str, list] = {}
    with av.open(str(video), "w", format="mp4") as c:
        s = c.add_stream("mpeg4", rate=Fraction(FPS, 1))
        s.width, s.height, s.pix_fmt = sc.IMG_W, sc.IMG_H, "yuv420p"
        s.bit_rate = 8_000_000
        for f in range(int(SECONDS * FPS)):
            t = f / FPS
            target, focal = sc.pan_path(t, SECONDS)
            img = sc.render(tex, target, focal)
            frame_boxes = []
            for team, i in PEOPLE:
                x, y = position(team, i, t)
                fx, fy = sc.project3d(target, focal, (x, y, 0.0))
                _, hy = sc.project3d(target, focal, (x, y, 1.8))
                h = fy - hy
                w = 0.4 * h
                x1, y1, x2, y2 = fx - w / 2, fy - h, fx + w / 2, fy
                if x2 < 0 or x1 >= sc.IMG_W or y2 < 0 or y1 >= sc.IMG_H:
                    continue  # out of view
                xi1, yi1, xi2, yi2 = max(0, int(x1)), max(0, int(y1)), min(sc.IMG_W, int(x2)), min(sc.IMG_H, int(y2))
                mid = int(y1 + h / 2)
                colour = {"red": RED, "blue": BLUE, "ref": YELLOW}[team]
                img[yi1 : max(yi1, mid), xi1:xi2] = colour
                img[max(yi1, mid) : yi2, xi1:xi2] = (20, 20, 20)
                if 0 <= fx < sc.IMG_W and 0 <= fy < sc.IMG_H:
                    frame_boxes.append([x1, y1, x2, y2, 0.9])
            boxes[f"{round(t, 2)}"] = frame_boxes
            for p in s.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
                c.mux(p)
        for p in s.encode():
            c.mux(p)
    boxes_file = out / "boxes.json"
    boxes_file.write_text(json.dumps(boxes))
    target, focal = sc.pan_path(0, SECONDS)
    cfg = {
        "pipelineVersion": "test",
        "sampleFps": 4,
        "cameraMotion": "moving",
        "detector": {"kind": "synthetic", "boxes_file": str(boxes_file)},
        "calibration": {
            "id": None,
            "frameTimeSeconds": 0.0,
            "homography": {"matrix": np.linalg.inv(sc.pitch_to_image(target, focal)).flatten().tolist(), "pitch": {"length": sc.L, "width": sc.W}},
            "imageWidth": sc.IMG_W,
            "imageHeight": sc.IMG_H,
            "rmsErrorM": 0.1,
            "looErrorM": 0.2,
        },
    }
    result_dir = out / "result"
    result_dir.mkdir()
    return {"video": video, "cfg": cfg, "result": analyse(video, cfg, result_dir), "dir": result_dir}


def test_camera_is_followed_through_the_whole_clip(moving_match):
    cam = moving_match["result"]["summary"]["quality"]["camera"]
    assert cam["mode"] == "moving"
    assert cam["followedShare"] >= 0.95
    assert moving_match["result"]["summary"]["models"]["camera"].startswith("orb-keyframes")


def test_every_reported_position_matches_a_real_person(moving_match):
    errors = []
    for line in gzip.open(moving_match["dir"] / "tracks.jsonl.gz", "rt"):
        row = json.loads(line)
        truth = np.array([position(team, i, row["t"]) for team, i in PEOPLE])
        for _, _, x, y, _ in row["p"]:
            errors.append(float(np.min(np.linalg.norm(truth - [x, y], axis=1))))
    assert len(errors) > 500
    assert np.median(errors) < 0.5, "median position error in metres"
    assert np.percentile(errors, 95) < 1.5


def test_teams_are_separated_and_positions_are_labelled_estimated(moving_match):
    tracks = moving_match["result"]["tracks"]
    a = [t for t in tracks if t["team"] == "a"]
    b = [t for t in tracks if t["team"] == "b"]
    assert a and b
    assert np.mean([t["avg_x"] for t in a]) < sc.L / 2 < np.mean([t["avg_x"] for t in b])
    prov = moving_match["result"]["summary"]["provenance"]
    assert prov["average_position"] == "estimated", "a moving camera's positions are never 'measured'"
    assert prov["team_width"] == "estimated"


def test_moving_camera_without_a_single_calibration_frame_asks_to_recalibrate(moving_match, tmp_path):
    cfg = json.loads(json.dumps(moving_match["cfg"]))
    del cfg["calibration"]["frameTimeSeconds"]
    with pytest.raises(UserFixable) as exc:
        analyse(moving_match["video"], cfg, tmp_path)
    assert exc.value.code == "recalibrate_moving_camera"


def test_upload_check_labels_the_camera(moving_match, tmp_path):
    from fa_worker.stages.validate import validate_and_extract


    info, frames, motion = validate_and_extract(moving_match["video"], tmp_path / "frames", 7800, 120)
    assert motion == "moving"
    assert len(frames) == 8, "eight frames to choose from when calibrating"
    assert info.width == sc.IMG_W


def test_upload_check_labels_a_still_camera_fixed(tmp_path):
    from fa_worker.stages.validate import validate_and_extract

    tex = sc.world_texture()
    target, focal = sc.pan_path(0, SECONDS)
    still = sc.render(tex, target, focal)
    video = tmp_path / "still.mp4"
    rng = np.random.default_rng(5)
    with av.open(str(video), "w", format="mp4") as c:
        s = c.add_stream("mpeg4", rate=Fraction(FPS, 1))
        s.width, s.height, s.pix_fmt = sc.IMG_W, sc.IMG_H, "yuv420p"
        s.bit_rate = 8_000_000
        for _ in range(12 * FPS):
            img = still.copy()
            for _ in range(15):  # players moving around in front of a still camera
                x, y = int(rng.integers(0, sc.IMG_W - 20)), int(rng.integers(250, sc.IMG_H - 40))
                img[y : y + 36, x : x + 14] = rng.integers(0, 255, 3)
            for p in s.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
                c.mux(p)
        for p in s.encode():
            c.mux(p)
    _, _, motion = validate_and_extract(video, tmp_path / "frames", 7800, 120)
    assert motion == "fixed"


def test_analyze_job_with_an_old_style_calibration_fails_with_a_clear_message(conn, settings, moving_match):
    from fa_worker import queue
    from fa_worker.pipeline import process

    from .conftest import job_row, make_job
    from .test_analysis import FileStorage

    cfg = json.loads(json.dumps(moving_match["cfg"]))
    del cfg["calibration"]["frameTimeSeconds"]
    video = moving_match["video"]
    job = make_job(conn, kind="analyze", video_status="validated", size_bytes=video.stat().st_size, config=cfg)
    claimed = None
    while (j := queue.claim(conn, settings.worker_id, settings.lease_seconds)) is not None:
        if j.id == str(job["id"]):
            claimed = j
            break
    assert claimed
    assert process(conn, FileStorage(video), settings, claimed) == "failed"
    row = job_row(conn, job["id"])
    assert row["error_code"] == "recalibrate_moving_camera"
    assert "mark all the points on one frame" in row["error_message"]
    assert row["attempts"] == 1, "not retried: only the user can fix it"
