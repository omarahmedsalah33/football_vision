"""Render a short diagnostic clip; labels remain explicitly experimental."""
import argparse
import gzip
import json
from pathlib import Path
import subprocess

import cv2
import numpy as np

from experiments.report_events import frame_jpeg


def render(video_path, input_dir, output_path, start=0.0, duration=15.0):
    if not 0 < duration <= 30 or start < 0:
        raise ValueError("Diagnostic duration must be 0–30 seconds; start must be nonnegative")
    with gzip.open(input_dir / "observations.jsonl.gz", "rt") as source:
        observations = [json.loads(line) for line in source]
    selected = [o for o in observations if start <= o["t"] < start + duration]
    if len(selected) < 2:
        raise ValueError("No continuous observations in the requested diagnostic interval")
    metadata = json.loads((input_dir / "inference.json").read_text())
    fps = metadata["analysis_fps"]
    if any(b["t"] - a["t"] > 1.5 / fps for a, b in zip(selected, selected[1:])):
        raise ValueError("Diagnostic frames must be continuous at the recorded sample rate")
    cap = cv2.VideoCapture(str(video_path))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    process = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
         "-pixel_format", "bgr24", "-video_size", f'{metadata["width"]}x{metadata["height"]}',
         "-framerate", str(fps), "-i", "-", "-an", "-c:v", "libx264", "-preset", "fast",
         "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path)],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        for observation in selected:
            jpeg = frame_jpeg(cap, observation["t"], observation)
            if jpeg is None:
                raise ValueError("Source frame could not be decoded")
            image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
            process.stdin.write(image.tobytes())
        process.stdin.close()
        code = process.wait(timeout=120)
        error = process.stderr.read().decode(errors="replace")
        if code:
            raise RuntimeError(f"Diagnostic encoding failed: {error[-2000:]}")
    finally:
        cap.release()
        if process.poll() is None:
            process.kill()
            process.wait()
        if not process.stdin.closed:
            process.stdin.close()
        process.stderr.close()
    return output_path


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--video", type=Path, required=True)
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--start", type=float, default=0)
    p.add_argument("--duration", type=float, default=15)
    a = p.parse_args()
    render(a.video, a.input, a.output, a.start, a.duration)
