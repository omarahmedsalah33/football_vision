"""Stage 1: decide whether an uploaded file is a video we can analyse.

Decoding untrusted media is the riskiest thing this system does (FFmpeg has a long CVE history),
so the probe runs in a separate, time-limited child process. A crash or hang in the decoder kills
only that child; the job then fails with a safe message.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from ..errors import JobFailure

# Containers PyAV/FFmpeg report for the formats we accept at upload time.
ALLOWED_FORMATS = {"mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"}
MIN_DURATION_S = 10.0
MIN_WIDTH, MIN_HEIGHT = 640, 360  # below this, distant players cover only a few pixels
MAX_WIDTH, MAX_HEIGHT = 4096, 2304
MIN_FPS, MAX_FPS = 10.0, 120.0
SAMPLE_POINTS = (0.0, 0.5, 0.9)  # decode a frame near the start, middle and end
MEMORY_LIMIT_BYTES = 2 * 1024**3


@dataclass(frozen=True)
class VideoInfo:
    container: str
    video_codec: str
    duration_seconds: float
    width: int
    height: int
    fps: float


def probe_file(path: str) -> dict:
    """Runs inside the child process. Returns raw facts or {'error': code}."""
    import av  # imported here so the parent process never loads FFmpeg for untrusted input

    try:
        with av.open(path, mode="r", options={"probesize": "50000000"}) as container:
            fmt = container.format.name
            streams = [s for s in container.streams if s.type == "video"]
            if not streams:
                return {"error": "no_video_stream", "container": fmt}
            stream = streams[0]
            stream.thread_type = "AUTO"
            ctx = stream.codec_context
            fps = float(stream.average_rate) if stream.average_rate else 0.0
            if stream.duration is not None and stream.time_base:
                duration = float(stream.duration * stream.time_base)
            elif container.duration is not None:
                duration = container.duration / 1_000_000
            else:
                duration = 0.0

            decoded = 0
            for point in SAMPLE_POINTS:
                if point > 0 and duration > 0 and stream.time_base:
                    container.seek(int(duration * point / stream.time_base), stream=stream, backward=True)
                for frame in container.decode(stream):
                    if frame.width and frame.height:
                        decoded += 1
                    break
            return {
                "container": fmt,
                "video_codec": ctx.name,
                "duration_seconds": duration,
                "width": ctx.width,
                "height": ctx.height,
                "fps": fps,
                "decoded_samples": decoded,
            }
    except av.error.InvalidDataError:
        return {"error": "undecodable"}
    except av.error.FFmpegError:
        return {"error": "undecodable"}


def _limit_resources() -> None:  # pragma: no cover - POSIX only
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))


def run_probe(path: Path, timeout_seconds: int) -> dict:
    cmd = [sys.executable, "-I", "-m", "fa_worker.stages.validate", str(path)]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout_seconds,
            cwd=Path(__file__).resolve().parents[2],
            preexec_fn=_limit_resources if sys.platform != "win32" else None,
        )
    except subprocess.TimeoutExpired as exc:
        raise JobFailure("probe_timeout", "The video took too long to read. It may be damaged.", reject_video=True) from exc
    if proc.returncode != 0:
        raise JobFailure("undecodable", "The video file could not be decoded. It may be damaged.", reject_video=True)
    try:
        return json.loads(proc.stdout.decode("utf-8").strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise JobFailure("undecodable", "The video file could not be decoded. It may be damaged.", reject_video=True) from exc


def check(facts: dict, max_duration_seconds: float) -> VideoInfo:
    """Applies product rules to probe facts. Pure, so every rule is unit-testable."""
    error = facts.get("error")
    if error == "no_video_stream":
        raise JobFailure("no_video_stream", "The file contains no video track.", reject_video=True)
    if error:
        raise JobFailure("undecodable", "The video file could not be decoded. It may be damaged.", reject_video=True)
    if facts["container"] not in ALLOWED_FORMATS:
        raise JobFailure("unsupported_container", "This video format is not supported.", reject_video=True)
    if facts.get("decoded_samples", 0) < len(SAMPLE_POINTS):
        raise JobFailure("undecodable", "Parts of the video could not be decoded. It may be damaged.", reject_video=True)

    duration = float(facts["duration_seconds"])
    if duration < MIN_DURATION_S:
        raise JobFailure("too_short", "The video is shorter than 10 seconds.", reject_video=True)
    if duration > max_duration_seconds:
        minutes = int(max_duration_seconds // 60)
        raise JobFailure("too_long", f"The video is longer than your plan allows ({minutes} minutes).", reject_video=True)

    width, height, fps = int(facts["width"]), int(facts["height"]), float(facts["fps"])
    if width < MIN_WIDTH or height < MIN_HEIGHT:
        raise JobFailure(
            "resolution_too_low",
            f"The video resolution ({width}×{height}) is too low; at least {MIN_WIDTH}×{MIN_HEIGHT} is required.",
            reject_video=True,
        )
    if width > MAX_WIDTH or height > MAX_HEIGHT:
        raise JobFailure("resolution_too_high", "Videos above 4K resolution are not supported.", reject_video=True)
    if not (MIN_FPS <= fps <= MAX_FPS):
        raise JobFailure("unsupported_frame_rate", "The video frame rate is not supported.", reject_video=True)

    return VideoInfo(
        container=facts["container"],
        video_codec=str(facts["video_codec"]),
        duration_seconds=duration,
        width=width,
        height=height,
        fps=fps,
    )


def validate(path: Path, max_duration_seconds: float, timeout_seconds: int) -> VideoInfo:
    return check(run_probe(path, timeout_seconds), max_duration_seconds)


if __name__ == "__main__":  # child-process entry point
    print(json.dumps(probe_file(sys.argv[1])))

