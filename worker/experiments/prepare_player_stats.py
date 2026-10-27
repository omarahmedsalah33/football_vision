"""Prepare a bounded three-minute, clothing-only reference-video experiment."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw


KIT = [
    "Blue goalkeeper vest/top over pale sleeves, dark shorts, light footwear; seen in left goal at reference time.",
    "Blue top with pale/yellow trim, dark shorts, light shoes; left side near goal in reference.",
    "Blue long-sleeved top, dark shorts, pink/red shoes; deeper left/central area in reference.",
    "Red shirt, dark shorts, light shoes; deeper left/central area in reference.",
    "Bright blue short-sleeved shirt, black shorts, orange boots; foreground in reference.",
    "Blue shirt with red/maroon sleeves, dark shorts, light shoes.",
    "White/light grey shirt, black shorts, dark/light shoes; do not confuse with maroon-shorts number 17.",
    "Black shirt, dark shorts with pale trim, bright blue shoes.",
    "White jersey with visible number 17, maroon/burgundy shorts, pink/orange shoes.",
    "Blue/purple shirt, dark/olive shorts, light shoes; right side in reference.",
    "Blue shirt, white/light shorts, dark lower socks/shoes.",
    "Red shirt, black shorts, light shoes; right end in reference. Do not confuse with other red shirt.",
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(source, root):
    root.mkdir(parents=True, exist_ok=True)
    (root / "clips").mkdir(exist_ok=True)
    (root / "references").mkdir(exist_ok=True)
    original = Path("generated-artifacts/player-images")
    provenance = json.loads((original / "crop-provenance.json").read_text())
    if [p["label"] for p in provenance] != [f"Unknown{i}" for i in range(1, 13)]:
        raise ValueError("The twelve reference labels must match the delivered PDF")
    catalog, anchors = [], {}
    for index, p in enumerate(provenance):
        path = original / f'{p["label"]}.jpg'
        image = Image.open(path).convert("RGB")
        # References deliberately obscure the head; assignment must use kit and motion.
        ImageDraw.Draw(image).rectangle((0, 0, image.width, round(image.height * .18)), fill="black")
        reference = root / "references" / path.name
        image.save(reference, quality=95)
        catalog.append({"id": p["label"], "kit": KIT[index], "file": str(reference.relative_to(root)),
                        "sha256": digest(reference), "original_crop_sha256": digest(path)})
        frame = p["source_frame"]
        if frame not in anchors:
            anchors[frame] = Image.open(frame).convert("RGB")
        draw = ImageDraw.Draw(anchors[frame])
        x1, y1, x2, y2 = p["crop_xyxy"]
        draw.rectangle((x1, y1, x2, y1 + round((y2-y1)*.18)), fill="black")
        draw.rectangle((x1, y1, x2, y2), outline="yellow", width=2)
        draw.text((x1, max(0, y1-13)), p["label"], fill="yellow", stroke_width=1, stroke_fill="black")
    anchor_files = []
    for index, (frame, image) in enumerate(anchors.items(), 1):
        path = root / "references" / f"pitch-anchor-{index}.jpg"
        image.save(path, quality=93)
        source_time = 24 if "f017" in frame else 22
        anchor_files.append({"file": str(path.relative_to(root)), "sha256": digest(path),
                             "source_time_s": source_time})
    clips = []
    for index, start in enumerate(range(0, 180, 20), 1):
        duration = min(22, 180-start)
        file = root / "clips" / f"clip-{index}.mp4"
        if not file.exists():
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                            "-ss", str(start), "-i", str(source), "-t", str(duration),
                            "-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "fast",
                            "-crf", "23", "-threads", "2", "-movflags", "+faststart", str(file)],
                           check=True, timeout=180)
        if file.stat().st_size > 5_500_000:
            raise ValueError("Clip too large for bounded inline video request")
        clips.append({"id": f"clip-{index}", "file": str(file.relative_to(root)),
                      "start_s": start, "duration_s": duration, "owned_end_s": min(start+20, 180),
                      "sha256": digest(file)})
        print(f"Prepared {index}/9: {start}–{start+duration}s", flush=True)
    manifest = {"source_file": str(source), "source_range_s": [0, 180], "catalog": catalog,
                "anchors": anchor_files, "clips": clips,
                "reference_pdf_sha256": digest(original / "unknown-players.pdf"),
                "identity_method": "clothing_numbers_footwear_continuous_motion_no_faces"}
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    a = parser.parse_args()
    prepare(a.source, a.output)
