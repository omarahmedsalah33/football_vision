"""Create a labels-and-images-only PDF from manually located on-pitch appearances.

Boxes are reviewed source-image locations, not facial recognition or cross-frame
biometric identity matches. Two nearby views avoid occlusions; continuity is based
on clothing and pitch position. This is not an automatic match-wide detector.
"""
import argparse
import base64
import json
import shutil
import subprocess
from pathlib import Path

from PIL import Image


# Coordinates in a 1024x576 reference view of source time 00:24.
# Every box refers to a different, simultaneously visible on-pitch appearance.
BOXES = [
    (129, 238, 161, 283),
    (71, 250, 104, 328),
    (374, 248, 399, 301),
    (396, 242, 419, 282),
    (492, 304, 536, 409),
    (542, 267, 578, 340),
    (598, 265, 633, 319),
    (659, 287, 700, 364),
    (693, 285, 728, 353),
    (787, 272, 824, 339),
]


def export(frame_path, nearby_frame_path, output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    selections = [(frame_path, box) for box in BOXES]
    # At 00:22 these appearances are separated from foreground players.
    selections[5] = (nearby_frame_path, (376, 269, 416, 330))
    selections.extend([
        (nearby_frame_path, (315, 269, 347, 326)),
        (nearby_frame_path, (951, 291, 986, 358)),
    ])
    cards, audit = [], []
    for index, (source_path, box) in enumerate(selections, 1):
        source = Image.open(source_path).convert("RGB")
        width, height = source.size
        native = tuple(round(v * (width / 1024 if i % 2 == 0 else height / 576))
                       for i, v in enumerate(box))
        crop = source.crop(native)
        name = f"Unknown{index}"
        path = output_dir / f"{name}.jpg"
        crop.save(path, quality=96)
        encoded = base64.b64encode(path.read_bytes()).decode()
        cards.append(f'<div class="card"><div class="label">{name}</div>'
                     f'<img src="data:image/jpeg;base64,{encoded}"></div>')
        audit.append({"label": name, "source_frame": str(source_path),
                      "crop_xyxy": native, "method": "manual_spatial_crop_clothing_and_position_only"})
    (output_dir / "crop-provenance.json").write_text(json.dumps(audit, indent=2))
    html = """<!doctype html><html><head><meta charset="utf-8"><title></title>
<style>@page{size:A4;margin:12mm}*{box-sizing:border-box}
body{margin:0;font-family:Arial,sans-serif;color:#111;background:white}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm}
.card{height:62mm;display:flex;flex-direction:column;align-items:center;break-inside:avoid}
.label{font-size:17pt;margin-bottom:3mm}
img{height:49mm;max-width:48mm;object-fit:contain}
</style></head><body><div class="grid">""" + "".join(cards) + "</div></body></html>"
    page = output_dir / "player-images-print.html"
    page.write_text(html)
    pdf = (output_dir / "unknown-players.pdf").resolve()
    chromium = shutil.which("chromium")
    if not chromium:
        raise RuntimeError("Chromium is required")
    subprocess.run([chromium, "--headless", "--no-sandbox", "--disable-gpu",
                    "--no-pdf-header-footer", f"--print-to-pdf={pdf}", page.resolve().as_uri()],
                   check=True, timeout=90, capture_output=True)
    print(f"Created {pdf} with {len(cards)} labels and full-player crops")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frame", type=Path, required=True)
    parser.add_argument("--nearby-frame", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    export(args.frame, args.nearby_frame, args.output)
