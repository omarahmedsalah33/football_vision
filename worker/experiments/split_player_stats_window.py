"""Bounded shorter-video fallback for the one slow 80–102 second window."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def split(root):
    path = root / "manifest.json"
    manifest = json.loads(path.read_text())
    parent = manifest["clips"][4]
    if parent["start_s"] != 80 or parent["owned_end_s"] != 100:
        raise ValueError("Unexpected fallback window")
    children = []
    for index, start in enumerate((80, 90), 1):
        file = root / "clips" / f"clip-5-part-{index}.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-ss", str(start), "-i", manifest["source_file"], "-t", "12",
                        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                        "-threads", "2", "-movflags", "+faststart", str(file)],
                       check=True, timeout=120)
        children.append({"id": f"clip-5-part-{index}", "start_s": start, "duration_s": 12,
                         "owned_end_s": start+10, "file": str(file.relative_to(root)),
                         "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "short_fallback": True})
    parent["alternative_clips"] = children
    path.write_text(json.dumps(manifest, indent=2))
    print("Prepared two shorter video windows for 80–100s ownership", flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", type=Path, required=True)
    split(p.parse_args().input)
