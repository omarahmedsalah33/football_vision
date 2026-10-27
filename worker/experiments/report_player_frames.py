"""Export Astra's scene-local player-reference timestamps and original full frames."""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import zipfile
from pathlib import Path

from experiments.report_astra import csv_cell, esc


def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    minutes, remainder = divmod(milliseconds, 60000)
    whole, fraction = divmod(remainder, 1000)
    return f"{minutes:02d}:{whole:02d}.{fraction:03d}"


def build(root):
    manifest = json.loads((root / "manifest.json").read_text())
    result = json.loads((root / "astra-player-frames.json").read_text())
    if manifest["gemini_results_sha256"] != result["gemini_results_sha256"]:
        raise ValueError("Selection and source manifest differ")
    frames = {f["id"]: f for w in manifest["windows"] for f in w["frames"]}
    rows, selected, comments, limitations = [], {}, [], []
    for w in result["results"]:
        response = w["player_frames"]
        if not response["model_returned"].startswith("gpt-6-astra"):
            raise ValueError("Unexpected returned model")
        comments.append(f'<h3>{esc(w["window_id"])}</h3><p>{esc(response["result"]["summary"])}</p>')
        limitations.extend(response["result"]["limitations"])
        for index, appearance in enumerate(response["result"]["appearances"], 1):
            frame = frames[appearance["frame_id"]]
            if frame["crop_xyxy"]:
                raise ValueError("Only full-source reference frames are permitted")
            selected[frame["id"]] = frame
            rows.append({
                **appearance, "model_appearance_id": appearance["appearance_id"],
                "appearance_id": f'{w["window_id"]}-Unknown{index}', "window_id": w["window_id"],
                "source_time_s": frame["source_time_s"], "timestamp": timestamp(frame["source_time_s"]),
                "reference_scope": "scene_local_appearance_not_verified_identity",
            })
    fields = ["appearance_id", "model_appearance_id", "window_id", "timestamp", "source_time_s", "frame_id",
              "clothing_and_screen_position", "visible_jersey_number", "why_selected",
              "limitations", "reference_scope"]
    with (root / "player-frame-timestamps.csv").open("w", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fields)
        writer.writeheader()
        writer.writerows({k: csv_cell(v) for k, v in row.items()} for row in rows)
    (root / "player-frame-timestamps.json").write_text(json.dumps({
        "status": "reference_frame_selection_not_identification",
        "source_range_s": manifest["source_range_s"], "appearances": rows,
        "distinct_player_count": None,
    }, indent=2))
    table = "".join(
        f'<tr><td>{esc(r["appearance_id"])}</td><td><a href="#{esc(r["frame_id"])}">{esc(r["timestamp"])}</a></td>'
        f'<td>{esc(r["clothing_and_screen_position"])}<br><strong>Jersey:</strong> '
        f'{esc(r["visible_jersey_number"] or "Not legible")}</td>'
        f'<td>{esc(r["why_selected"])}<br><em>Limits:</em> {esc(r["limitations"])}</td></tr>' for r in rows)
    gallery = []
    for frame in sorted(selected.values(), key=lambda f: (f["source_time_s"], f["id"])):
        data = (root / frame["file"]).read_bytes()
        if hashlib.sha256(data).hexdigest() != frame["sha256"]:
            raise ValueError("Source-frame checksum mismatch")
        encoded = base64.b64encode(data).decode()
        labels = ", ".join(r["appearance_id"] for r in rows if r["frame_id"] == frame["id"])
        gallery.append(f'<figure id="{esc(frame["id"])}"><figcaption><strong>{timestamp(frame["source_time_s"])}</strong>'
                       f' · {esc(frame["id"])}<br>{esc(labels)}</figcaption>'
                       f'<img loading="lazy" alt="Full source frame at {timestamp(frame["source_time_s"])}" '
                       f'src="data:image/jpeg;base64,{encoded}"></figure>')
    html = f"""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>Clearest player-reference timestamps</title>
<style>body{{font:16px/1.6 system-ui;max-width:1150px;margin:36px auto;padding:0 20px;background:#101e18;color:#eef6ef}}
a{{color:#c8ed85}}td,th{{padding:12px;text-align:left;border-bottom:1px solid #456052;vertical-align:top}}
table{{width:100%;border-collapse:collapse}}img{{width:100%;height:auto}}figure{{margin:35px 0}}
.notice{{padding:20px;background:#35412a}}h2{{margin-top:40px}}@media(max-width:700px){{table{{font-size:13px}}td,th{{padding:6px}}}}</style>
<h1>Clearest player-reference frames</h1><p>GPT-6 Astra · sampled first minute · source timestamps in mm:ss.mmm</p>
<div class="notice">This selects full-player reference images, <strong>not faces or identities</strong>.
Labels refer to scene-local appearances, not verified unique people. A player may appear in several rows.
No face matching, face crops or automatic name assignment was performed.</div>
<p>Astra selected {len(rows)} local appearance references across {len(result["results"])} windows,
using {len(selected)} full-source frames. This is not a player count.
“Clearest” means best among the supplied samples—not guaranteed best anywhere in the full video.
Unknown labels are display references; original model labels are retained in CSV/JSON.</p>
<h2>Selected timestamps</h2><p>Click a timestamp to see the exact source frame.
Clothing and screen position describe which player to look at. Jersey numbers are model readings requiring review.</p>
<div style="overflow:auto"><table><tr><th>Scene-local label</th><th>Source timestamp</th>
<th>Player reference</th><th>Astra's selection reason and limitations</th></tr>{table}</table></div>
<h2>Astra's window comments</h2>{"".join(comments)}
<h2>Full-source evidence</h2>{"".join(gallery)}
<h2>Additional limits</h2><ul>{"".join(f"<li>{esc(s)}</li>" for s in dict.fromkeys(limitations))}</ul>
<p>No confirmed identities or match statistics were created. The timestamp CSV and JSON preserve the individual selections.</p></html>"""
    (root / "clearest-player-frames.html").write_text(html)
    with zipfile.ZipFile(root / "clearest-player-frames.zip", "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in ["clearest-player-frames.html", "player-frame-timestamps.csv",
                     "player-frame-timestamps.json", "astra-player-frames.json", "manifest.json"]:
            bundle.write(root / name, arcname=name)
        for frame in selected.values():
            bundle.write(root / frame["file"], arcname=frame["file"])
    print(json.dumps({"local_appearance_references": len(rows), "selected_source_frames": len(selected),
                      "distinct_player_count": None, "report": str(root / "clearest-player-frames.html")}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    build(parser.parse_args().input)
