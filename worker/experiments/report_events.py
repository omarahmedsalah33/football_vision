"""Build a reproducible experimental report from timestamped detection records."""
from __future__ import annotations

import argparse
import base64
import csv
import gzip
import html
import json
from pathlib import Path

import cv2

from fa_worker.analysis.events import EventAnalyzer


def timestamp(t):
    return f"{int(t) // 60:02d}:{t % 60:05.2f}"


def frame_jpeg(video, t, observation=None):
    video.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, frame = video.read()
    if not ok:
        return None
    if observation:
        for player in observation["players"]:
            x1, y1, x2, y2 = map(round, player["box"])
            color = (255, 150, 50) if player["kit"] == "blue" else (180, 180, 180)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 1)
            cv2.putText(frame, f"T{player['id']}", (x1, max(12, y1 - 3)), 0, 0.3, color, 1)
        if observation["ball"]:
            p = tuple(map(round, observation["ball"]))
            cv2.circle(frame, p, 8, (0, 230, 255), 1)
    cv2.putText(frame, timestamp(t) + " EXPERIMENTAL - UNVERIFIED", (8, 20), 0, 0.45, (0, 230, 255), 1)
    return cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()


def build(input_dir, video_path, *, goals=()):
    metadata = json.loads((input_dir / "inference.json").read_text())
    if metadata["probe"]:
        raise ValueError("Sparse probe detections cannot be used for temporal event analysis")
    analyzer = EventAnalyzer(metadata["width"], metadata["height"], goal_boxes=goals)
    observations = []
    with gzip.open(input_dir / "detections.jsonl.gz", "rt") as source, gzip.open(input_dir / "observations.jsonl.gz", "wt") as out:
        for line in source:
            observation = analyzer.observe(json.loads(line))
            observations.append(observation)
            out.write(json.dumps(observation, separators=(",", ":")) + "\n")
    report = analyzer.report()
    report["input"] = {"file": video_path.name, **metadata}
    report["analyzed_range_s"] = [observations[0]["t"], observations[-1]["t"]] if observations else None
    report["goal_regions_manually_supplied"] = bool(goals)
    (input_dir / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False))
    fields = ["id", "type", "start_s", "end_s", "review_status", "confidence", "visible_ball_fraction", "kit_group", "from_tracklet", "to_tracklet", "tracklet", "reason"]
    with (input_dir / "event-candidates.csv").open("w", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(report["events"])
    with (input_dir / "tracklets.csv").open("w", newline="") as target:
        keys = ["id", "start_s", "last_s", "observations", "visible_s", "kit_group", "controlled_samples",
                "pass_candidates_made", "pass_candidates_received", "carry_candidates", "identity"]
        writer = csv.DictWriter(target, fieldnames=keys)
        writer.writeheader()
        writer.writerows(report["tracklets"])
    cap = cv2.VideoCapture(str(video_path))
    examples = sorted(report["events"], key=lambda e: (e["type"] != "completed_pass_candidate", e["start_s"]))[:6]
    if not examples and observations:
        examples = [{"id": "diagnostic", "type": "No validated event sequence", "start_s": observations[0]["t"],
                     "end_s": observations[min(len(observations) - 1, int(metadata["analysis_fps"] * 10))]["t"]}]
    sections = []
    for example in examples:
        pictures = []
        for t in [example["start_s"], (example["start_s"] + example["end_s"]) / 2, example["end_s"]]:
            obs = min(observations, key=lambda o: abs(o["t"] - t))
            image = frame_jpeg(cap, obs["t"], obs)
            if image:
                pictures.append(f'<figure><img src="data:image/jpeg;base64,{base64.b64encode(image).decode()}"><figcaption>{timestamp(obs["t"])}</figcaption></figure>')
        sections.append(f'<section><h3>{html.escape(example["id"] + " · " + example["type"])}</h3><div class="frames">{"".join(pictures)}</div></section>')
    cap.release()
    counts = report["candidate_counts"]
    count_rows = "".join(f"<tr><td>{html.escape(k.replace('_', ' '))}</td><td>{v}</td></tr>" for k, v in counts.items())
    metric_rows = "".join(f"<tr><td>{html.escape(k.replace('_', ' '))}</td><td>Not established</td></tr>" for k in report["statistics"])
    limits = "".join(f"<li>{html.escape(s)}</li>" for s in report["limitations"])
    coverage = report["coverage"]
    analyzed = report["analyzed_range_s"]
    analyzed_text = f"{timestamp(analyzed[0])}–{timestamp(analyzed[1])}" if analyzed else "No frames"
    player_rows = "".join(
        f'<tr><td>T{tr["id"]}</td><td>{html.escape(tr["kit_group"])}</td><td>{tr["visible_s"]:.1f}s</td>'
        f'<td>{tr["pass_candidates_made"]}</td><td>{tr["pass_candidates_received"]}</td><td>{tr["carry_candidates"]}</td></tr>'
        for tr in sorted(report["tracklets"], key=lambda tr: tr["visible_s"], reverse=True)[:20])
    page = f"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Football Vision — experimental video test</title><style>
body{{font:16px/1.6 system-ui;background:#0b1915;color:#eaf3ed;max-width:1150px;margin:32px auto;padding:0 24px}}
h1,h2,h3{{line-height:1.2}}h1{{font-size:38px}}h2{{margin-top:36px}}.notice{{background:#493b15;border-left:4px solid #ffd969;padding:20px}}
table{{border-collapse:collapse;width:100%;max-width:750px}}td,th{{text-align:left;border-bottom:1px solid #34483e;padding:10px}}
.frames{{display:flex;gap:12px}}figure{{margin:0;flex:1;min-width:0}}img{{width:100%}}section{{margin:30px 0;padding:18px;background:#14281f}}
.muted{{color:#b6c8be}}code{{overflow-wrap:anywhere}}@media(max-width:700px){{.frames{{display:block}}figure{{margin-bottom:12px}}h1{{font-size:28px}}}}
</style><h1>Football Vision<br>Experimental match analysis</h1>
<p class="muted">Source: {html.escape(video_path.name)} · {metadata["width"]}×{metadata["height"]} · {timestamp(metadata["video_duration_s"])} · {metadata["analysis_fps"]} sampled frames/second</p>
<div class="notice"><strong>This is an algorithm test, not an official match report.</strong>
Event proposals and tracklet IDs are unverified. A missing statistic means “not established,” not zero.
No labelled ground-truth comparison has been performed.</div>
<h2>What was processed</h2><p><strong>Analyzed source interval: {analyzed_text}.</strong> Statistics apply only to this tested interval, not automatically to the entire recording.</p><ul><li>{coverage["frames"]:,} sampled frames.</li>
<li>Coherent ball detections on {coverage["coherent_ball_fraction"]:.1%} of sampled frames. This measures continuity, not accuracy.</li>
<li>Sustained control estimated on {coverage["controlled_ball_fraction"]:.1%} of sampled frames, not full-match possession.</li>
<li>{len(report["tracklets"]):,} short-lived tracklets with at least 3 observations — not {len(report["tracklets"]):,} unique players.</li>
<li>{coverage.get("tracking_discontinuities",0):,} camera/visibility discontinuities reset tracking.</li></ul>
<h2>Unverified event candidates</h2><table><tr><th>Proposal type</th><th>Count</th></tr>{count_rows or '<tr><td>No qualifying event candidates</td><td>0</td></tr>'}</table>
<h2>Requested match statistics</h2><p>These require reliable event evidence, confirmed identities and/or pitch calibration. Candidate totals must not be substituted.</p><table>{metric_rows}</table>
<h2>Temporary player-tracklet data</h2><p>The 20 longest visible tracklets. Passes and carries below are unreviewed proposals, not player performance totals. The complete table is in tracklets.csv.</p>
<table><tr><th>Tracklet</th><th>Kit appearance</th><th>Visible time</th><th>Pass candidates made</th><th>Received</th><th>Carry candidates</th></tr>{player_rows}</table>
<h2>Timestamped visual evidence</h2><p>Yellow rings indicate the proposed coherent ball position. T-numbers are temporary tracklets. Still frames are diagnostic evidence, not confirmation of a pass or shot.</p>
{"".join(sections)}
<h2>Method and limitations</h2><p>{html.escape(metadata["model"])}. Camera motion is estimated with optical flow and RANSAC; player association uses geometry and kit appearance. Control requires repeated unambiguous proximity; passes require sustained reception and visible ball travel. Carries do not imply successful dribbles.</p>
<ul>{limits}</ul><p>Goal-region anchors supplied: {bool(goals)}. No shot/goal outcome is classified by this prototype.</p>
<h2>Next validation step</h2><p>Label representative night-footage clips with real ball locations and pass/shot outcomes; compare precision and recall on held-out clips. Establish actual pitch dimensions and manually verify player/team assignments before reporting per-player accuracy or km/h.</p>
</html>"""
    (input_dir / "report.html").write_text(page)
    print(json.dumps({"coverage": coverage, "candidate_counts": counts, "tracklets": len(report["tracklets"])}, indent=2))
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--video", type=Path, required=True)
    p.add_argument("--goal", type=float, nargs=4, action="append", default=[])
    args = p.parse_args()
    build(args.input, args.video, goals=args.goal)
