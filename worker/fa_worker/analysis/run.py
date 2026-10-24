"""Analysis child process: `python -I -m fa_worker.analysis.run <video> <config.json> <out_dir>`.

Runs in its own process so a decoder or GPU crash can't take down the worker, and so the parent
can stop it on cancellation. Progress goes to stdout as `PROGRESS <stage> <fraction>` lines; results
go to <out_dir>/result.json and <out_dir>/tracks.jsonl.gz. A problem the user can fix is reported as
one `FAILURE <code> <message>` line before exiting with status 3.

Two camera modes:
- fixed: one calibration applies to every frame; players are tracked in image space.
- moving (pan/tilt/zoom from one spot): each frame is placed on the pitch by the camera follower
  (see camera.py); frames it can't place are skipped, and players are tracked on the pitch plane so
  camera movement doesn't break their identities.
"""

from __future__ import annotations

import gzip
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from .camera import CameraFollower, classify_motion
from .detector import build_detector
from .geometry import foot_points, on_pitch, project, to_matrix
from .metrics import WINDOW_S, expected_people, min_team_players, team_shape_windows, track_summary
from .teams import assign_teams
from .tracker import ByteTrackTracker

COLOUR_SAMPLES_PER_TRACK = 20
MIN_TRACK_SECONDS = 2.0  # shorter tracks are noise: false detections, fragments
CANVAS_PX_PER_M = 10.0  # moving camera: players are tracked on a top-down canvas of the pitch
CANVAS_BOX_M = 2.5  # box size on that canvas: big enough to overlap between samples while running


class UserFixable(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def progress(stage: str, fraction: float) -> None:
    print(f"PROGRESS {stage} {fraction:.4f}", flush=True)


def provenance(calibration: dict, moving: bool = False) -> dict:
    """How each metric family is labelled, given the calibration quality. With a moving camera every
    frame's position on the pitch is itself estimated, so positions are never labelled "measured"."""
    error = calibration.get("looErrorM") if calibration.get("looErrorM") is not None else calibration.get("rmsErrorM", 99)
    positional = "measured" if error is not None and error <= 1.0 and not moving else "estimated"
    return {
        "team_width": positional,
        "team_depth": positional,
        "line_height": positional,
        "team_area": positional,
        "average_position": positional,
        "distance_covered": "estimated",
        "heatmap": "estimated",
        "formation": "not_available",
        "passes": "not_available",
        "shots": "not_available",
        "xg": "not_available",
    }


def _frames_at(video: Path, times: list[float]) -> list[np.ndarray]:
    """Decodes the first frame at or after each time (seconds)."""
    import av

    out = []
    with av.open(str(video)) as container:
        stream = container.streams.video[0]
        for t in times:
            container.seek(int(max(0.0, t - 1.0) / stream.time_base), stream=stream, backward=True)
            for frame in container.decode(stream):
                if float(frame.time or 0.0) + 1e-3 >= t:
                    out.append(frame.to_ndarray(format="rgb24"))
                    break
    return out


def _duration(video: Path) -> float:
    import av

    with av.open(str(video)) as container:
        stream = container.streams.video[0]
        if stream.duration and stream.time_base:
            return float(stream.duration * stream.time_base)
        return (container.duration or 0) / 1e6


def camera_mode(video: Path, cfg: dict) -> str:
    """'fixed' or 'moving', from the prepare stage or, for videos checked before it recorded this,
    by comparing frames from across the video. Undecidable videos keep the fixed-camera behaviour."""
    mode = cfg.get("cameraMotion")
    if mode in ("fixed", "moving"):
        return mode
    d = _duration(video)
    frames = _frames_at(video, [d * p for p in (0.1, 0.3, 0.5, 0.7, 0.9)]) if d > 0 else []
    return "moving" if classify_motion(frames) == "moving" else "fixed"


def canvas_boxes(pitch_xy: np.ndarray, scores: np.ndarray) -> np.ndarray:
    half = CANVAS_BOX_M / 2
    c = pitch_xy * CANVAS_PX_PER_M
    h = half * CANVAS_PX_PER_M
    return np.hstack([c - h, c + h, scores[:, None]]) if len(c) else np.zeros((0, 5))


def analyse(video: Path, cfg: dict, out_dir: Path) -> dict:
    import av

    started = time.monotonic()
    calibration = cfg["calibration"]
    H = to_matrix(calibration["homography"]["matrix"])
    pitch = calibration["homography"].get("pitch", {"length": 105, "width": 68})
    length, width = float(pitch["length"]), float(pitch["width"])
    players_per_side = int(pitch.get("playersPerSide", 11))
    sample_fps = float(cfg.get("sampleFps", 4))
    # Optional window (seconds) for evaluation runs; production analyses the whole video.
    start_s = float(cfg.get("startSeconds", 0.0))
    end_s = float(cfg["endSeconds"]) if cfg.get("endSeconds") is not None else None
    detector = build_detector(cfg.get("detector", {}))
    tracker = ByteTrackTracker(frame_rate=sample_fps)
    mode = camera_mode(video, cfg)
    moving = mode == "moving"
    follower: CameraFollower | None = None
    followed_frames = 0

    observations: dict[int, list[tuple[float, float, float]]] = defaultdict(list)
    colours: dict[int, list[np.ndarray]] = defaultdict(list)
    per_frame: list[tuple[float, list[tuple[int, float, float, list[float]]]]] = []
    people_per_frame: list[int] = []

    from .teams import shirt_colour

    with av.open(str(video)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        duration = float(stream.duration * stream.time_base) if stream.duration and stream.time_base else (container.duration or 0) / 1e6
        src_w, src_h = stream.codec_context.width, stream.codec_context.height
        # The homography was fitted in calibration-image pixels; rescale if the video differs.
        scale = np.array([calibration.get("imageWidth", src_w) / src_w, calibration.get("imageHeight", src_h) / src_h])
        if moving:
            anchor_t = calibration.get("frameTimeSeconds")
            if anchor_t is None:
                raise UserFixable(
                    "recalibrate_moving_camera",
                    "This video was filmed with a moving camera. Open the pitch calibration again and mark all the points on one frame.",
                )
            anchor = _frames_at(video, [float(anchor_t)])
            if not anchor:
                raise UserFixable("recalibrate_moving_camera", "The calibrated frame could not be read. Calibrate the pitch again.")
            H_video = H @ np.diag([scale[0], scale[1], 1.0])
            try:
                follower = CameraFollower(anchor[0], H_video, length, width, players_per_side, float(anchor_t), detector.detect(anchor[0], float(anchor_t)))
            except ValueError as exc:
                raise UserFixable("camera_not_followable", "The calibrated frame shows too little detail to follow the camera. Calibrate on a wider frame.") from exc
        next_t = start_s
        frame_index = 0
        if start_s > 1 and stream.time_base:
            container.seek(int((start_s - 1) / stream.time_base), stream=stream, backward=True)
        for frame in container.decode(stream):
            t = float(frame.time or 0.0)
            if end_s is not None and t > end_s:
                break
            if t + 1e-6 < next_t:
                continue
            next_t = t + 1.0 / sample_fps
            image = frame.to_ndarray(format="rgb24")
            boxes = detector.detect(image, t)
            people_per_frame.append(len(boxes))
            if follower is not None:
                Hf = follower.update(image, t, boxes)
                if Hf is None:
                    # Not placed on the pitch (cut, replay, close-up, or lines disagree): no positions.
                    per_frame.append((t, []))
                    frame_index += 1
                    continue
                followed_frames += 1
                det_xy = project(Hf, foot_points(boxes)) if len(boxes) else np.zeros((0, 2))
                inside = on_pitch(det_xy, length, width) if len(boxes) else np.zeros(0, dtype=bool)
                boxes, det_xy = boxes[inside], det_xy[inside]
                canvas = canvas_boxes(det_xy, boxes[:, 4] if len(boxes) else np.zeros(0))
                tracked_canvas, ids = tracker.update(canvas)
                # Back from canvas boxes to the detections they came from.
                idx = [int(np.argmin(np.abs(canvas[:, :4] - b).sum(axis=1))) for b in tracked_canvas] if len(ids) else []
                tracked_xyxy = boxes[idx, :4] if idx else np.zeros((0, 4))
                pitch_xy = det_xy[idx] if idx else np.zeros((0, 2))
                keep = np.ones(len(idx), dtype=bool)
            else:
                tracked_xyxy, ids = tracker.update(boxes)
                pitch_xy = project(H, foot_points(tracked_xyxy) * scale) if len(ids) else np.zeros((0, 2))
                keep = on_pitch(pitch_xy, length, width) if len(ids) else np.zeros(0, dtype=bool)
            frame_players = []
            for box, tid, xy, ok in zip(tracked_xyxy, ids, pitch_xy, keep):
                if not ok:
                    continue
                observations[int(tid)].append((t, float(xy[0]), float(xy[1])))
                frame_players.append((int(tid), float(xy[0]), float(xy[1]), [round(float(v), 1) for v in box]))
                if len(colours[int(tid)]) < COLOUR_SAMPLES_PER_TRACK and frame_index % 2 == 0:
                    c = shirt_colour(image, box)
                    if c is not None:
                        colours[int(tid)].append(c)
            per_frame.append((t, frame_players))
            frame_index += 1
            if frame_index % 10 == 0 and duration > 0:
                span = (end_s or duration) - start_s
                progress("detect", min(0.85, 0.05 + 0.8 * (t - start_s) / max(span, 1e-6)))

    progress("teams", 0.87)
    dt = 1.0 / sample_fps
    long_tracks = {tid for tid, obs in observations.items() if obs[-1][0] - obs[0][0] >= MIN_TRACK_SECONDS}
    raw_teams, team_quality = assign_teams({tid: colours.get(tid, []) for tid in long_tracks})

    # Name clusters by side: team "a" is the one defending the left goal in the first minutes.
    early = defaultdict(list)
    for tid in long_tracks:
        if raw_teams.get(tid) is not None:
            early[raw_teams[tid]].extend(x for (tt, x, _) in observations[tid] if tt <= observations[tid][0][0] + 120)
    left_cluster = min(early, key=lambda k: np.mean(early[k])) if len(early) == 2 else 0
    team_of = {tid: ("other" if raw_teams.get(tid) is None else ("a" if raw_teams[tid] == left_cluster else "b")) for tid in long_tracks}

    progress("metrics", 0.9)
    tracks = []
    for no, tid in enumerate(sorted(long_tracks, key=lambda k: observations[k][0][0]), start=1):
        s = track_summary(observations[tid], dt, length, width)
        tracks.append({"track_no": no, "source_id": tid, "team": team_of[tid], **s})
    renumber = {t["source_id"]: t["track_no"] for t in tracks}

    shape_frames = []
    for t, players in per_frame:
        groups = {"a": [], "b": []}
        for tid, x, y, _ in players:
            team = team_of.get(tid)
            if team in groups:
                groups[team].append((x, y))
        shape_frames.append((t, {k: np.array(v).reshape(-1, 2) for k, v in groups.items()}))
    windows = team_shape_windows(shape_frames, length, WINDOW_S, players_per_side)

    with gzip.open(out_dir / "tracks.jsonl.gz", "wt", encoding="utf-8") as fh:
        for t, players in per_frame:
            fh.write(json.dumps({"t": round(t, 3), "p": [[renumber[tid], team_of[tid], round(x, 2), round(y, 2), box] for tid, x, y, box in players if tid in renumber]}) + "\n")

    counts = {k: sum(1 for t in tracks if t["team"] == k) for k in ("a", "b", "other")}
    ppf = np.array(people_per_frame) if people_per_frame else np.zeros(1)
    valid_windows = [w for w in windows if w["a"] and w["b"]]
    summary = {
        "pipeline": cfg.get("pipelineVersion"),
        "models": {
            "detector": detector.version,
            "tracker": tracker.version + (":pitch-canvas" if moving else ""),
            "teams": "lab-median-2means-v1",
            **({"camera": follower.version} if follower is not None else {}),
        },
        "settings": {"sampleFps": sample_fps, "windowSeconds": WINDOW_S},
        "pitch": {"length": length, "width": width, "playersPerSide": players_per_side},
        "provenance": provenance(calibration, moving),
        "quality": {
            "calibration": {"rmsErrorM": calibration.get("rmsErrorM"), "looErrorM": calibration.get("looErrorM")},
            "detection": {
                "framesAnalysed": len(per_frame),
                "meanPeoplePerFrame": float(ppf.mean()),
                # "Fewer people than two team shapes need": 16 on a full pitch, 8 in 5-a-side.
                "minPeople": 2 * min_team_players(players_per_side),
                "shareFramesUnderMinPeople": float((ppf < 2 * min_team_players(players_per_side)).mean()),
            },
            "tracking": {
                "tracks": len(tracks),
                "medianTrackSeconds": float(np.median([t["last_seconds"] - t["first_seconds"] for t in tracks])) if tracks else 0.0,
                "meanCoverage": float(np.mean([t["coverage"] for t in tracks])) if tracks else 0.0,
                # One track per player and official is perfect (25 on a full pitch); far more means identities break up.
                "tracksPerExpectedPerson": len(tracks) / expected_people(players_per_side),
            },
            "teams": {**team_quality, **counts},
            "teamShape": {"windows": len(windows), "windowsWithBothTeams": len(valid_windows)},
            "camera": follower.summary() if follower is not None else {"mode": "fixed"},
            "processingSeconds": round(time.monotonic() - started, 1),
        },
        "teamShape": windows,
        "durationSeconds": duration,
    }
    result = {"summary": summary, "tracks": tracks}
    (out_dir / "result.json").write_text(json.dumps(result))
    progress("finalize", 0.95)
    return result


if __name__ == "__main__":
    video_path, cfg_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    try:
        analyse(Path(video_path), json.loads(Path(cfg_path).read_text()), Path(out))
    except UserFixable as exc:
        print(f"FAILURE {exc.code} {exc.message}", flush=True)
        sys.exit(3)
    print("DONE", flush=True)
