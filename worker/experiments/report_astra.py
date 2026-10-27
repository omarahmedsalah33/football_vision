"""Build a self-contained report of Astra's comments, not certified match statistics."""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import html
import json
from collections import Counter
from pathlib import Path


def esc(value):
    return html.escape(str(value))


def csv_cell(value):
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    if isinstance(value, (list, dict)):
        return json.dumps(value)
    return value


def build(root: Path):
    manifest = json.loads((root / "manifest.json").read_text())
    result = json.loads((root / "astra-results.json").read_text())
    if result["gemini_results_sha256"] != manifest["gemini_results_sha256"]:
        raise ValueError("Astra results and evidence manifest differ")
    original = (root / "gemini-source-results.json").read_bytes()
    if hashlib.sha256(original).hexdigest() != manifest["gemini_results_sha256"]:
        raise ValueError("Gemini source results checksum mismatch")
    claims = {c["id"]: c for w in manifest["windows"] for c in w["claims"]}
    frames = {f["id"]: f for w in manifest["windows"] for f in w["frames"]}
    reviews = []
    phases = []
    for window in result["results"]:
        for phase in ("blind", "challenge"):
            phases.append(window[phase])
        for review in window["challenge"]["result"]["reviews"]:
            reviews.append({
                **review, "window_id": window["window_id"],
                "gemini": claims[review["claim_id"]],
                "human_review_status": "pending", "statistics_eligible": False,
            })
    if sorted(r["claim_id"] for r in reviews) != sorted(claims):
        raise ValueError("Not every Gemini claim was reviewed exactly once")
    for r in reviews:
        if any(f not in frames for f in r["frame_ids"]):
            raise ValueError("Unknown frame citation")
    counts = {
        axis: dict(Counter(r[f"{axis}_verdict"] for r in reviews))
        for axis in ("action", "outcome", "identity")
    }
    primary_counts = {
        axis: dict(Counter(r[f"{axis}_verdict"] for r in reviews if r["gemini"]["in_primary_window"]))
        for axis in ("action", "outcome", "identity")
    }
    usage = {
        key: sum((p.get("usage") or {}).get(key, 0) for p in phases)
        for key in ("prompt_tokens", "completion_tokens", "total_tokens")
    }
    summary = {
        "status": "cross_model_review_not_ground_truth",
        "model": result["model"], "source_range_s": manifest["source_range_s"],
        "source_images": len(frames), "reviewed_records_including_overlap": len(reviews),
        "primary_records": sum(r["gemini"]["in_primary_window"] for r in reviews),
        "verdict_counts_not_accuracy": counts, "primary_verdict_counts_not_accuracy": primary_counts,
        "main_call_usage": usage, "api_calls": len(phases),
        "returned_models": sorted(set(p["model_returned"] for p in phases)),
        "confirmed_match_statistics": None, "measured_precision": None, "measured_recall": None,
        "human_ground_truth_available": False,
        "limitations": [
            "Astra sees sampled images, not Gemini's native-video input. It can miss events between frames.",
            "Action windows are sampled every 0.5–0.75 seconds; controls every 1.5–2 seconds, with extra source crops around the goal-area claim.",
            "Windows were selected using Gemini timestamps. The initial Astra prompts omit Gemini claims, reducing but not eliminating selection/anchoring bias.",
            "Challenge prompts include both Gemini claims and Astra's own first-pass interpretation; these are not independent human annotations.",
            "Supported/contradicted/inconclusive are Astra's judgments, not certified correctness. Inconclusive does not mean false.",
            "There are 12 proposal records but 11 primary-window records; one overlaps another pass. A goal claim and shot can describe the same action.",
            "Possible extra events in no-proposal controls are hypotheses, not proven misses or measured recall.",
            "No per-player identities, physical speeds, pass accuracy percentages or production statistics were established.",
        ],
    }
    (root / "review-summary.json").write_text(json.dumps(summary, indent=2))
    (root / "claim-reviews.json").write_text(json.dumps(reviews, indent=2))
    columns = ["claim_id", "source_start_s", "source_end_s", "gemini_type", "gemini_outcome",
               "gemini_claim", "action_verdict", "outcome_verdict", "identity_verdict", "comments",
               "challenged_details", "timing_comment", "suggested_correction", "frame_ids",
               "in_primary_window", "human_review_status", "statistics_eligible"]
    with (root / "claim-reviews.csv").open("w", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=columns)
        writer.writeheader()
        for r in reviews:
            c = r["gemini"]
            row = {**{k: r[k] for k in columns if k in r},
                   "source_start_s": c["source_start_s"], "source_end_s": c["source_end_s"],
                   "gemini_type": c["type"], "gemini_outcome": c["outcome"],
                   "gemini_claim": c["evidence"], "in_primary_window": c["in_primary_window"]}
            writer.writerow({k: csv_cell(v) for k, v in row.items()})

    selected = []
    for r in reviews:
        refs = r["frame_ids"]
        for frame_id in ([refs[0], refs[-1]] if refs else []):
            if frame_id not in selected and len(selected) < 24:
                selected.append(frame_id)
    def citations(ids):
        return ", ".join(
            f'<a href="#{esc(f)}">{esc(f)} ({frames[f]["source_time_s"]:.3f}s)</a>'
            if f in selected else f'<code>{esc(f)}</code> ({frames[f]["source_time_s"]:.3f}s; in data bundle)'
            for f in ids
        ) or "No frame citation supplied"
    cards = []
    for r in reviews:
        c = r["gemini"]
        challenges = "".join(f"<li>{esc(x)}</li>" for x in r["challenged_details"])
        cards.append(f"""<section class="claim" id="{esc(r['claim_id'])}">
<h3>{esc(r['claim_id'])} · {c['source_start_s']:.1f}–{c['source_end_s']:.1f}s · {esc(c['type'])}</h3>
<p class="muted">{"Primary-window proposal" if c["in_primary_window"] else "Overlapping proposal; excluded from primary counts"}</p>
<div class="columns"><div><h4>Gemini prediction</h4>
<p><strong>Actor:</strong> {esc(c['actor'])}<br><strong>Receiver:</strong> {esc(c['receiver'])}<br>
<strong>Claimed outcome:</strong> {esc(c['outcome'])}<br><strong>Model confidence:</strong> {esc(c['confidence'])}</p>
<blockquote>{esc(c['evidence'])}</blockquote></div>
<div><h4>GPT-6 Astra assessment</h4><p><strong>Action:</strong> {esc(r['action_verdict'])}<br>
<strong>Outcome:</strong> {esc(r['outcome_verdict'])}<br><strong>Identity:</strong> {esc(r['identity_verdict'])}</p>
<p>{esc(r['comments'])}</p></div></div>
<h4>Astra's specific challenges</h4><ul>{challenges or '<li>No specific challenged detail listed.</li>'}</ul>
<p><strong>Timing comment:</strong> {esc(r['timing_comment'])}</p>
<p><strong>Suggested review correction:</strong> {esc(r['suggested_correction'])}</p>
<p class="muted"><strong>Cited evidence:</strong> {citations(r['frame_ids'])}</p>
</section>""")
    independent = []
    controls = []
    for window in result["results"]:
        w = next(w for w in manifest["windows"] if w["id"] == window["window_id"])
        blind = window["blind"]["result"]
        observations = "".join(
            f'<li><strong>{o["start_s"]:.2f}–{o["end_s"]:.2f}s · {esc(o["action"])}</strong>: '
            f'{esc(o["what_is_visible"])}<br><em>Uncertain:</em> {esc(o["what_is_uncertain"])}'
            f'<br><span class="muted">{citations(o["frame_ids"])}</span></li>'
            for o in blind["observations"]
        )
        independent.append(
            f'<details><summary>{esc(w["id"])} · independent first look · source ranges {esc(w["sampled_ranges"])}</summary>'
            f'<p>{esc(blind["summary"])}</p><ul>{observations or "<li>No action observations supplied.</li>"}</ul></details>')
        if not w["claims"]:
            control = window["challenge"]["result"]
            extras = "".join(
                f'<li>{e["start_s"]:.2f}–{e["end_s"]:.2f}s: {esc(e["comment"])}<br>{citations(e["frame_ids"])}</li>'
                for e in control["additional_possible_events"]
            )
            controls.append(f'<section><h3>Intervals without Gemini proposals</h3><p>{esc(control["summary"])}</p>'
                            f'<ul>{extras or "<li>No additional possible events proposed.</li>"}</ul></section>')
    gallery = []
    for frame_id in selected:
        f = frames[frame_id]
        path = root / f["file"]
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != f["sha256"]:
            raise ValueError("Evidence JPEG checksum mismatch")
        image = base64.b64encode(data).decode()
        gallery.append(f'<figure id="{esc(frame_id)}"><img loading="lazy" alt="Source frame {esc(frame_id)}" '
                       f'src="data:image/jpeg;base64,{image}"><figcaption>{esc(frame_id)} · '
                       f'source {f["source_time_s"]:.3f}s · {"detail crop" if f["crop_xyxy"] else "full frame"}</figcaption></figure>')
    count_rows = "".join(
        f'<tr><td>{axis}</td><td>{counts[axis].get("supported",0)}</td><td>{counts[axis].get("contradicted",0)}</td>'
        f'<td>{counts[axis].get("inconclusive",0)}</td></tr>' for axis in ("action", "outcome", "identity")
    )
    limits = "".join(f"<li>{esc(x)}</li>" for x in summary["limitations"])
    page = f"""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>GPT-6 Astra challenges Gemini</title>
<style>body{{font:16px/1.65 system-ui;background:#0b1915;color:#edf4ee;max-width:1150px;margin:32px auto;padding:0 22px}}
h1,h2,h3,h4{{line-height:1.25}}h1{{font-size:40px}}h2{{margin-top:40px}}h4{{margin:20px 0 8px}}
a{{color:#c6ee76}}.notice{{background:#493b15;border-left:4px solid #ffd969;padding:20px}}
section,.claim,details{{padding:20px;background:#14281f;margin:22px 0}}.columns{{display:grid;grid-template-columns:1fr 1fr;gap:25px}}
blockquote{{border-left:3px solid #779a83;margin:12px 0;padding-left:15px}}table{{border-collapse:collapse;width:100%}}
td,th{{border-bottom:1px solid #34483e;padding:10px;text-align:left}}.muted,figcaption{{color:#b6c8be}}
img{{width:100%;height:auto}}figure{{margin:28px 0}}code{{overflow-wrap:anywhere}}summary{{cursor:pointer}}
@media(max-width:700px){{.columns{{display:block}}h1{{font-size:30px}}}}</style>
<h1>GPT-6 Astra challenges<br>Gemini's football predictions</h1>
<p class="muted">First-minute experiment · 720p source · {len(frames)} timestamped source images · all {len(claims)} Gemini records reviewed</p>
<div class="notice"><strong>This is cross-model review, not ground truth.</strong>
Astra's comments and verdicts below are model judgments. Agreement does not establish correctness,
and inconclusive does not mean false. No confirmed match totals or measured accuracy are reported.</div>
<h2>How the review worked</h2><ol>
<li>Astra inspected source-frame sequences before seeing Gemini's predictions.</li>
<li>It then received Gemini's claims and challenged action type, outcome, identity, timing and over-specific details separately.</li>
<li>Two no-proposal source intervals were also sampled to look for possible omissions. Those remain hypotheses.</li></ol>
<p>Exact returned model(s): <code>{esc(", ".join(summary["returned_models"]))}</code>.
The {len(phases)} calls include five independent first looks and five challenges.
Source frames—not native video—were sent to Astra. Gemini previously received native video with requested 10-fps sampling.</p>
<h2>Astra's verdict distribution</h2><p>Counts below cover {len(reviews)} records, including one overlap.
They are <strong>not accuracy scores or independent action totals</strong>. The shot and goal claim may concern the same action.</p>
<table><tr><th>Claim component</th><th>Supported</th><th>Contradicted</th><th>Inconclusive</th></tr>{count_rows}</table>
<p class="muted">Carry outcomes are not applicable. Astra used “inconclusive” for those outcome fields because the verdict vocabulary had no not-applicable option; read the event comments rather than treating those as failed carries.</p>
<h2>Event-by-event comments and challenges</h2><p>Gemini predictions are shown beside Astra's actual comments.
Suggested corrections are tentative labels for a human reviewer, not automatically applied results.</p>
{"".join(cards)}
<h2>Independent first-look observations</h2><p>These responses were produced before Gemini's answers were supplied. Expand each window to inspect them.</p>
{"".join(independent)}
<h2>Possible omissions: control intervals</h2><p>These intervals had no Gemini proposals in the original run.
Astra's possible extra actions do not establish false negatives or recall.</p>{"".join(controls)}
<h2>Representative source evidence</h2><p>{len(selected)} cited frames are embedded here.
All {len(frames)} exact input frames, their timestamps and hashes are in the downloadable data bundle.
Crops are additional views of the same moment, not extra events.</p>{"".join(gallery)}
<h2>Limits</h2><ul>{limits}</ul>
<h2>What to do with this report</h2><p>Prioritize human review where action/outcome judgments conflict or are inconclusive.
Do not turn either model's event list into official statistics until the source evidence is reviewed.
Preserve disagreements rather than resolving them by model majority vote.</p>
<p class="muted">Actual prompts, independent responses, challenge responses, token usage and source-image hashes are preserved in JSON.
Production match data was not modified.</p></html>"""
    (root / "astra-challenge-report.html").write_text(page)
    print(json.dumps(summary, indent=2))
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    build(parser.parse_args().input)
