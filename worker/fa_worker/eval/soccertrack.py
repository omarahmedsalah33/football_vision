"""Evaluate Football Vision on SoccerTrack v2 (CC BY 4.0, cite arXiv 2508.01802).

    python -m fa_worker.eval.soccertrack --root D:/soccertrack-v2 --match 117093 --half 1st \\
        --start-min 10 --minutes 3 --out ../docs/evaluation

Dataset facts this loader relies on (from the dataset's own docs, which warn that the shipped GSR
files differ from the documented schema):
- GSR files are SoccerNet-COCO objects of ~2.7 GB per half, so they are streamed, never loaded whole;
- `image_id` is a string: a sequence prefix plus a 1-indexed, 6-digit frame number; video is 25 fps;
- pitch positions are in `bbox_pitch.x_bottom_middle / y_bottom_middle`, centre-origin metres with
  x towards the right goal and y towards the far touchline; `bbox_image` is in true pixels.

Calibration modes:
- `oracle`: a homography fitted to thousands of ground-truth (foot pixel → pitch) pairs. It isolates
  detection and tracking accuracy from calibration error (a best case for a pure homography).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

from .scoring import GtPerson, PredPerson, evaluate

FPS = 25
L, W = 105.0, 68.0


def to_ours(x_centre: float, y_centre: float) -> tuple[float, float]:
    """Centre-origin (x right, y towards far side) → ours (x from left goal line, y from far touchline)."""
    return x_centre + L / 2, W / 2 - y_centre


def frame_of(image_id: str | int) -> int:
    """0-based frame index from the shipped string id ("3000001" → 0)."""
    return int(str(image_id)[-6:]) - 1


def stream_gt(path: Path, first_frame: int, last_frame: int):
    """Yields (frame, GtPerson, foot_pixel) for person records in [first_frame, last_frame]."""
    import ijson

    with path.open("rb") as fh:
        for rec in ijson.items(fh, "annotations.item", use_float=True):
            if rec.get("supercategory") != "object":
                continue
            f = frame_of(rec["image_id"])
            if f < first_frame or f > last_frame:
                continue
            attrs = rec.get("attributes") or {}
            bp = rec.get("bbox_pitch") or {}
            if "x_bottom_middle" not in bp:
                continue
            x, y = to_ours(float(bp["x_bottom_middle"]), float(bp["y_bottom_middle"]))
            bi = rec.get("bbox_image") or {}
            foot = (float(bi["x_center"]), float(bi["y"]) + float(bi["h"])) if bi else None
            yield f, GtPerson(int(rec["track_id"]), attrs.get("role", "player"), attrs.get("team"), x, y), foot


def fit_homography(pixels: np.ndarray, pitch: np.ndarray) -> np.ndarray:
    """Normalised DLT, then one robust refit without points worse than 2 m."""

    def dlt(p, q):
        def norm(a):
            c = a.mean(axis=0)
            s = np.sqrt(2) / np.mean(np.linalg.norm(a - c, axis=1))
            return np.array([[s, 0, -s * c[0]], [0, s, -s * c[1]], [0, 0, 1]])

        Tp, Tq = norm(p), norm(q)
        ph = (np.hstack([p, np.ones((len(p), 1))]) @ Tp.T)[:, :2]
        qh = (np.hstack([q, np.ones((len(q), 1))]) @ Tq.T)[:, :2]
        rows = []
        for (x, y), (u, v) in zip(ph, qh):
            rows += [[-x, -y, -1, 0, 0, 0, u * x, u * y, u], [0, 0, 0, -x, -y, -1, v * x, v * y, v]]
        h = np.linalg.svd(np.array(rows))[2][-1].reshape(3, 3)
        H = np.linalg.inv(Tq) @ h @ Tp
        return H / H[2, 2]

    def residual(H):
        proj = np.hstack([pixels, np.ones((len(pixels), 1))]) @ H.T
        return np.linalg.norm(proj[:, :2] / proj[:, 2:3] - pitch, axis=1)

    H = dlt(pixels, pitch)
    keep = residual(H) <= 2.0
    if keep.sum() >= 8:
        H = dlt(pixels[keep], pitch[keep])
    return H


def run(args) -> dict:
    from ..analysis.run import analyse

    root = Path(args.root)
    video = root / "videos" / args.match / f"{args.match}_panorama_{args.half}_half.mp4"
    gsr = root / "gsr" / args.match / f"{args.match}_{args.half}.json"
    start_s, end_s = args.start_min * 60.0, (args.start_min + args.minutes) * 60.0
    first, last = int(start_s * FPS), int(end_s * FPS)

    print(f"Streaming ground truth from {gsr.name} (frames {first}-{last})…", flush=True)
    gt_by_frame: dict[int, list[GtPerson]] = defaultdict(list)
    corr_px, corr_pitch = [], []
    for f, person, foot in stream_gt(gsr, first, last):
        gt_by_frame[f].append(person)
        if foot and person.role in ("player", "goalkeeper") and f % 25 == 0:
            corr_px.append(foot)
            corr_pitch.append((person.x, person.y))
    if not gt_by_frame:
        raise SystemExit("No ground truth in that window.")

    H = fit_homography(np.array(corr_px), np.array(corr_pitch))
    resid = np.linalg.norm(
        (lambda p: p[:, :2] / p[:, 2:3])(np.hstack([np.array(corr_px), np.ones((len(corr_px), 1))]) @ H.T) - np.array(corr_pitch), axis=1
    )
    calibration = {
        "id": None,
        "homography": {"matrix": H.flatten().tolist(), "pitch": {"length": L, "width": W}},
        "rmsErrorM": float(np.sqrt(np.mean(resid**2))),
        "looErrorM": None,
    }
    out_dir = Path(args.out) / f"{args.match}_{args.half}_{args.start_min}m_{args.minutes}m"
    out_dir.mkdir(parents=True, exist_ok=True)
    cfg = {
        "pipelineVersion": "eval",
        "sampleFps": args.sample_fps,
        "detector": {"kind": "rfdetr", "size": args.detector_size},
        "calibration": calibration,
        "startSeconds": start_s,
        "endSeconds": end_s,
    }
    print("Running analysis…", flush=True)
    result = analyse(video, cfg, out_dir)

    import gzip

    pred_frames: dict[float, list[PredPerson]] = {}
    with gzip.open(out_dir / "tracks.jsonl.gz", "rt") as fh:
        for line in fh:
            row = json.loads(line)
            pred_frames[round(row["t"] * FPS) / FPS] = [PredPerson(p[0], p[1], p[2], p[3]) for p in row["p"]]
    gt_frames = {f / FPS: v for f, v in gt_by_frame.items()}
    scores = evaluate(gt_frames, pred_frames, radius=2.0, pred_windows=result["summary"]["teamShape"])

    report = {
        "dataset": "SoccerTrack v2 (CC BY 4.0, arXiv 2508.01802)",
        "match": args.match,
        "half": args.half,
        "window": {"startMinute": args.start_min, "minutes": args.minutes},
        "calibration": {"mode": "oracle", "rmsErrorM": calibration["rmsErrorM"], "correspondences": len(corr_px)},
        "models": result["summary"]["models"],
        "settings": result["summary"]["settings"],
        "processingSeconds": result["summary"]["quality"]["processingSeconds"],
        "scores": scores,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report["scores"], indent=2))
    return report


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", required=True, help="dataset root containing videos/, gsr/, raw/")
    p.add_argument("--match", required=True)
    p.add_argument("--half", choices=["1st", "2nd"], default="1st")
    p.add_argument("--start-min", type=float, default=10)
    p.add_argument("--minutes", type=float, default=3)
    p.add_argument("--sample-fps", type=float, default=4)
    p.add_argument("--detector-size", default="medium")
    p.add_argument("--out", default="evaluation")
    run(p.parse_args())


if __name__ == "__main__":
    main()
