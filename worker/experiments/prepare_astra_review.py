"""Extract labelled source frames for a bounded Astra challenge of Gemini proposals."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np


def prepare(gemini_dir: Path, output: Path):
    source_manifest = json.loads((gemini_dir / "manifest.json").read_text())
    source = Path(source_manifest["source_file"])
    if not source.is_file():
        raise ValueError("Original source video is unavailable")
    gemini_bytes = (gemini_dir / "gemini-results.json").read_bytes()
    gemini = json.loads(gemini_bytes)
    if gemini["source_range_s"] != [0, 60]:
        raise ValueError("This review is bounded to the existing first-minute experiment")
    output.mkdir(parents=True, exist_ok=True)
    (output / "frames").mkdir(exist_ok=True)
    cap = cv2.VideoCapture(str(source))
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not cap.isOpened() or not np.isfinite(fps) or fps <= 0:
        raise ValueError("Cannot decode source video")
    specifications = [
        ("window-1", [[16, 27, 0.5]], ["clip-1-1", "clip-1-2", "clip-2-1", "clip-2-2", "clip-2-3"]),
        ("window-2", [[26, 33, 0.5]], ["clip-2-4", "clip-2-5", "clip-2-6"]),
        ("window-3", [[40, 51, 0.75]], ["clip-3-1", "clip-3-2"]),
        ("window-4", [[51, 60, 0.5]], ["clip-3-3", "clip-3-4"]),
        ("window-5", [[0, 16, 2], [33, 40, 1.5]], []),
    ]
    windows = []
    for window_id, ranges, claim_ids in specifications:
        samples = []
        for start, end, step in ranges:
            samples.extend((float(t), None) for t in np.arange(start, end + 0.0001, step))
        if window_id == "window-2":
            samples.extend((t, [0, 240, 650, 540]) for t in [28.5, 28.65, 28.8, 28.95, 29.1, 29.25])
        frames = []
        for i, (time_s, crop) in enumerate(sorted(samples, key=lambda s: (s[0], bool(s[1]))), 1):
            index = round(time_s * fps)
            cap.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, frame = cap.read()
            if not ok:
                raise ValueError(f"Cannot decode source frame {index}")
            if crop:
                x1, y1, x2, y2 = crop
                frame = frame[y1:y2, x1:x2]
            frame_id = f"{window_id}-f{i:03d}"
            path = output / "frames" / f"{frame_id}.jpg"
            ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
            if not ok:
                raise ValueError("Cannot encode evidence frame")
            path.write_bytes(encoded.tobytes())
            frames.append({
                "id": frame_id, "file": str(path.relative_to(output)),
                "source_time_s": round(index / fps, 6), "source_frame_index": index,
                "crop_xyxy": crop, "width": frame.shape[1], "height": frame.shape[0],
                "sha256": hashlib.sha256(encoded.tobytes()).hexdigest(),
            })
        windows.append({
            "id": window_id, "sampled_ranges": ranges, "frames": frames,
            "claims": [e for e in gemini["events"] if e["id"] in claim_ids],
        })
    cap.release()
    assigned = [e["id"] for w in windows for e in w["claims"]]
    if sorted(assigned) != sorted(e["id"] for e in gemini["events"]):
        raise ValueError("Not all Gemini proposals are assigned exactly once")
    manifest = {
        "source_file": str(source), "source_fps": fps,
        "gemini_results_sha256": hashlib.sha256(gemini_bytes).hexdigest(),
        "source_range_s": [0, 60], "windows": windows,
        "scope": "All twelve Gemini proposal records, including one overlap proposal; two no-proposal intervals sampled as controls.",
        "limitations": "Window selection is based on Gemini proposal times; blind first-pass prompts do not contain those proposals. Frames are sparse evidence, not native video or human ground truth.",
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (output / "gemini-source-results.json").write_bytes(gemini_bytes)
    print(json.dumps({"windows": len(windows), "frames": sum(len(w["frames"]) for w in windows),
                      "claims": len(assigned)}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gemini-input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.gemini_input, args.output)
