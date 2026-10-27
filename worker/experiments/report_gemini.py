"""Render an evidence-first report; never promote model proposals to match statistics."""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import html
import json
from collections import Counter
from pathlib import Path


def escape(value):
    return html.escape(str(value))


def csv_cell(value):
    """Prevent model-generated text from being interpreted as spreadsheet formulas."""
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def build(root: Path):
    model = json.loads((root / "gemini-results.json").read_text())
    baseline = json.loads((root / "detector-baseline/report.json").read_text())
    events = model["events"]
    primary = [e for e in events if e["in_primary_window"]]
    counts = dict(Counter(e["type"] for e in primary))
    usage = {
        key: sum(c["usage"].get(key, 0) for c in model["clips"])
        for key in ("promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount")
    }
    usage["video_input_tokens"] = sum(
        p["tokenCount"] for c in model["clips"]
        for p in c["usage"].get("promptTokensDetails", []) if p["modality"] == "VIDEO"
    )
    audit_data = {}
    if (root / "visual-audit.json").exists():
        audit_data = json.loads((root / "visual-audit.json").read_text())
        digest = hashlib.sha256((root / "gemini-results.json").read_bytes()).hexdigest()
        if audit_data["model_results_sha256"] != digest:
            raise ValueError("Visual audit belongs to different model results")
    findings = audit_data.get("findings", [])
    comparison = {
        "status": "experimental_not_accuracy_benchmark", "source_range_s": [0, 60],
        "model": model["model"], "returned_models": [c["returned_model"] for c in model["clips"]],
        "native_video_input": True, "requested_video_fps": model["requested_video_fps"],
        "unique_source_seconds": 60, "video_seconds_submitted_with_overlap": 64,
        "detector_coverage": baseline["coverage"],
        "detector_event_candidates": baseline["candidate_counts"],
        "detector_shot_classifier": "not_implemented",
        "gemini_primary_window_proposals": counts,
        "all_proposals_including_overlap": len(events),
        "primary_window_proposals": len(primary),
        "confirmed_statistics": baseline["statistics"],
        "precision": None, "recall": None, "false_positive_rate": None,
        "human_labelled_ground_truth": False,
        "partial_visual_audit_only": bool(findings), "audit_findings": findings,
        "successful_main_call_usage": usage,
        "caveats": [
            "Proposals are not match totals. A goal candidate can refer to the same action as a shot; do not sum them as independent attacks.",
            "Fixed ownership windows remove one overlap proposal; possible duplicates are still preserved and flagged, not asserted resolved.",
            "Qualitative model confidence/evidence labels are self-reports, not measured correctness.",
            "No continuous cross-clip player identity, pitch calibration, speed, distance or dribble-success accuracy was established.",
            "This is one recording and 60 seconds of unique source coverage, not a full-match or general-model accuracy result.",
            "Video clips were re-encoded at 720p for inline transport; the detector baseline used the original source. Input preprocessing differs.",
            "A request using optional high-resolution and schema settings was rejected; the failing setting was not isolated. Successful requests omit both and use default media resolution, native MP4, JSON-mode output and requested 10 fps.",
            "A separate text control, 2-second native-video control and failed diagnostics are not included in the successful-main-call token totals.",
        ],
    }
    (root / "comparison.json").write_text(json.dumps(comparison, indent=2))
    with (root / "event-proposals.csv").open("w", newline="") as target:
        fields = ["id", "source_start_s", "source_end_s", "type", "actor", "receiver", "outcome",
                  "evidence_level", "confidence", "evidence", "in_primary_window",
                  "possible_duplicate_ids", "review_status", "statistics_eligible"]
        writer = csv.DictWriter(target, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows({k: csv_cell(v) for k, v in e.items()} for e in events)
    rows = "".join(
        f'<tr><td>{escape(e["id"])}</td><td>{e["source_start_s"]:.1f}–{e["source_end_s"]:.1f}s</td>'
        f'<td>{escape(e["type"])}</td><td>{escape(e["actor"])}</td>'
        f'<td>{escape(e["outcome"])}</td><td>{escape(e["confidence"])}</td>'
        f'<td>{escape(e["evidence"])}</td></tr>' for e in primary
    )
    count_rows = "".join(f"<tr><td>{escape(k)}</td><td>{v}</td></tr>" for k, v in counts.items())
    limitations = "".join(f"<li>{escape(x)}</li>" for x in comparison["caveats"])
    audit = "".join(f'<li><strong>{f["range_s"][0]}–{f["range_s"][1]}s:</strong> {escape(f["note"])}</li>' for f in findings)
    figures = []
    for picture in audit_data.get("pictures", []):
        filename, caption = picture["file"], picture["caption"]
        if Path(filename).name != filename or Path(filename).suffix not in (".jpg", ".jpeg"):
            raise ValueError("Audit pictures must be local JPEG basenames")
        path = root / filename
        if path.exists():
            data = base64.b64encode(path.read_bytes()).decode()
            figures.append(f'<figure><img src="data:image/jpeg;base64,{data}" alt="{escape(caption)}"><figcaption>{escape(caption)}</figcaption></figure>')
    page = f"""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>Gemini 3.8 video comparison</title>
<style>body{{font:16px/1.6 system-ui;background:#0b1915;color:#edf4ee;max-width:1150px;margin:32px auto;padding:0 22px}}
h1,h2{{line-height:1.2}}h1{{font-size:38px}}h2{{margin-top:36px}}.notice{{padding:20px;background:#493b15;border-left:4px solid #ffd969}}
table{{border-collapse:collapse;width:100%}}th,td{{text-align:left;padding:10px;border-bottom:1px solid #34483e;vertical-align:top}}
.scroll{{overflow-x:auto}}figure{{margin:24px 0;padding:16px;background:#14281f}}img{{width:100%;height:auto}}.muted{{color:#b6c8be}}
code{{overflow-wrap:anywhere}}</style>
<h1>Gemini 3.8 Flash<br>Native-video comparison</h1>
<p class="muted">Same 720p recording · source 00:00–01:00 · three overlapping MP4 inputs · requested 10 fps</p>
<div class="notice"><strong>Candidate generation, not confirmed match statistics.</strong>
No complete human-labelled reference exists. Precision, recall and official pass/shot/goal totals are unknown.
The model's “high confidence” is not an accuracy score.</div>
<h2>What actually ran</h2><ul>
<li>Requested model: <code>{escape(model["model"])}</code>. All three responses identify the same model.</li>
<li>Native video input, not still images or a text-only video description. 64 seconds submitted with overlap; 60 unique source seconds.</li>
<li>{usage["video_input_tokens"]:,} reported video-input tokens, consistent with 640 sampled frames × 66 video tokens under this request. Sampling was requested at 10 fps.</li>
<li>The successful run used default media resolution and JSON mode after optional API settings were rejected.</li></ul>
<h2>Same-interval comparison</h2><table>
<tr><th>Output</th><th>Detector/rules baseline</th><th>Gemini</th></tr>
<tr><td>Pass proposals</td><td>0 qualifying candidates</td><td>{counts.get("pass_attempt", 0)} unverified proposals</td></tr>
<tr><td>Shot proposals</td><td>Not classified by this prototype</td><td>{counts.get("shot_attempt", 0)} unverified proposals</td></tr>
<tr><td>Goal outcome</td><td>Not classified</td><td>{counts.get("goal_candidate", 0)} unverified claim(s), associated with a shot</td></tr>
<tr><td>Player identity</td><td>{len(baseline["tracklets"])} temporary fragments</td><td>Kit/location descriptions; no continuous player IDs</td></tr>
<tr><td>Confirmed match totals / speed / accuracy</td><td>Not established</td><td>Not established</td></tr>
</table>
<h2>What this does—and does not—show</h2><p>Gemini produces reviewable semantic event proposals where the current detector/rules pipeline abstained.
That is useful for a review workflow, but does not establish that its counts are correct or that it outperforms the baseline on measured accuracy.</p>
<h2>Unverified proposal counts</h2><table>{count_rows}</table><p>These are {len(primary)} primary-window records, not {len(primary)} confirmed independent actions.
A goal record can describe the same action as a shot. {len(events) - len(primary)} overlapping proposal(s) excluded from these counts are retained in JSON/CSV with duplicate flags.</p>
<h2>Partial visual audit</h2><ul>{audit}</ul><p>This is a limited AI-assisted source-frame inspection, not an independent human-labelled benchmark. Every event still requires human review.</p>
{"".join(figures)}
<h2>Timestamped proposals</h2><p>All claims in this table are Gemini's predictions, including outcomes and confidence. They are not endorsed as facts.</p>
<div class="scroll"><table><tr><th>ID</th><th>Source time</th><th>Type</th><th>Actor description</th><th>Model outcome</th><th>Model confidence</th><th>Model evidence claim</th></tr>{rows}</table></div>
<h2>Limits and reproducibility</h2><ul>{limitations}</ul>
<p>Full prompts, response text, token usage, source offsets and video hashes are in the accompanying JSON.
All requested confirmed statistics remain null. No production database records or match results were updated.</p>
<h2>Recommended next step</h2><p>Create a coach-reviewed reference for these 60 seconds, score each proposal and each missed action, then evaluate a second unseen excerpt.
Use Gemini as a candidate generator with review until precision, recall and identity attribution meet an agreed threshold.</p></html>"""
    (root / "comparison-report.html").write_text(page)
    print(json.dumps({"counts": counts, "main_call_usage": usage, "confirmed_statistics": "not_established"}, indent=2))
    return comparison


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    build(parser.parse_args().input)
