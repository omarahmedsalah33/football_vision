"""Provisional player counts with source timestamps, audit flags and PDF evidence."""
import argparse
import base64
import csv
import hashlib
import html
import json
import shutil
import subprocess
import zipfile
from collections import Counter
from pathlib import Path

from experiments.report_astra import csv_cell
from experiments.report_player_frames import timestamp


def esc(value):
    return html.escape(str(value))


def consolidate(events, audit):
    records = []
    for raw in events:
        e = dict(raw)
        review = audit.get(e["id"])
        e["astra_review"] = review
        reasons = []
        if not e["in_primary_window"]:
            reasons.append("overlapping context record")
        if e["actor_id"] is None or e["identity_confidence"] != "high":
            reasons.append("player assignment uncertain")
        if e["event_confidence"] != "high" or e["evidence_level"] != "direct":
            reasons.append("action evidence uncertain")
        if e["type"] == "unclear_kick":
            reasons.append("kick intent unresolved")
        if review and (review["action_verdict"] == "contradicted" or review["identity_verdict"] == "contradicted"):
            reasons.append("sampled-frame action or identity explicitly contradicted")
        neutral = [key.removesuffix("_verdict") for key, value in (review or {}).items()
                   if key.endswith("_verdict") and value == "inconclusive"]
        e["decision_basis"] = ("Gemini retained under user policy; Astra neutral on " + ", ".join(neutral)
                               if neutral else "Gemini proposal; Astra review retained where available")
        e["included_in_provisional_count"] = not reasons
        e["count_exclusion_reasons"] = reasons
        e["goal_claim_supported"] = bool(
            not reasons and e["type"] == "shot" and e["outcome"] == "goal" and
            review and review["outcome_verdict"] == "supported")
        e["goal_accepted"] = bool(
            not reasons and e["type"] == "shot" and e["outcome"] == "goal" and
            (not review or review["outcome_verdict"] != "contradicted"))
        records.append(e)
    # Collapse obvious overlapping cross-clip reports conservatively, not distinct players.
    for i, e in enumerate(records):
        if not e["included_in_provisional_count"]:
            continue
        for other in records[:i]:
            if not other["included_in_provisional_count"] or other["clip_id"] == e["clip_id"]:
                continue
            overlap = min(e["source_end_s"], other["source_end_s"]) - max(e["source_start_s"], other["source_start_s"])
            if (e["type"] == other["type"] and e["actor_id"] == other["actor_id"] and overlap > 0 and
                    (e["type"] == "carry" or abs(e["source_key_s"]-other["source_key_s"]) < 1)):
                e["included_in_provisional_count"] = False
                e["goal_claim_supported"] = False
                e["goal_accepted"] = False
                e["count_exclusion_reasons"].append(f"overlap with {other['id']}; not counted twice")
                e["possible_duplicate_of"] = other["id"]
                break
    return records


def summarize(records, catalog):
    output = []
    for player in catalog:
        observed = [e for e in records if e["actor_id"] == player["id"] and e["in_primary_window"]]
        counted = [e for e in observed if e["included_in_provisional_count"]]
        counts = Counter(e["type"] for e in counted)
        goal_claims = [e for e in observed if e["type"] == "shot" and e["outcome"] == "goal"
                       and not e.get("possible_duplicate_of")]
        minutes = []
        for minute in range(3):
            group = [e for e in counted if minute*60 <= e["source_key_s"] < (minute+1)*60]
            minute_counts = Counter(e["type"] for e in group)
            minutes.append({"minute": f"{minute:02d}:00–{minute+1:02d}:00",
                "passes": minute_counts["pass"], "carries": minute_counts["carry"], "shots": minute_counts["shot"],
                "goals": sum(e["goal_accepted"] for e in group),
                "goal_claims_supported": sum(e["goal_claim_supported"] for e in group)})
        output.append({
            "player_id": player["id"], "passes": counts["pass"], "carries": counts["carry"],
            "shots": counts["shot"], "goal_claims_supported": sum(e["goal_claim_supported"] for e in counted),
            "goals": sum(e["goal_accepted"] for e in counted),
            "unresolved_goal_claims": sum(not e["goal_accepted"] for e in goal_claims),
            "completed_pass_proposals": sum(e["type"] == "pass" and e["outcome"] == "completed" and
                (not e["astra_review"] or e["astra_review"]["outcome_verdict"] != "contradicted") for e in counted),
            "awaiting_review": sum(not e["included_in_provisional_count"] for e in observed),
            "event_ids": [e["id"] for e in counted], "proposed_event_ids": [e["id"] for e in observed],
            "minute_splits": minutes, "official_statistics": None,
        })
    return output


def build(root):
    manifest = json.loads((root / "manifest.json").read_text())
    proposals = json.loads((root / "video-proposals.json").read_text())
    if hashlib.sha256(Path("generated-artifacts/player-images/unknown-players.pdf").read_bytes()).hexdigest() != manifest["reference_pdf_sha256"]:
        raise ValueError("The delivered reference PDF changed; do not attach old counts to new labels")
    for player in manifest["catalog"]:
        photo = Path("generated-artifacts/player-images") / f'{player["id"]}.jpg'
        if hashlib.sha256(photo.read_bytes()).hexdigest() != player["original_crop_sha256"]:
            raise ValueError("A reference player image changed")
    evidence = json.loads((root / "evidence-manifest.json").read_text())
    reviewed = json.loads((root / "astra-audit.json").read_text())
    audit = {r["case_id"]: r for batch in reviewed["results"] for r in batch["challenge"]["result"]["reviews"]}
    records = consolidate(proposals["events"], audit)
    stats = summarize(records, manifest["catalog"])
    output = {"status": "provisional_observations_not_official_statistics", "source_range_s": [0, 180],
              "reference_pdf_sha256": manifest["reference_pdf_sha256"], "players": stats, "events": records,
              "human_ground_truth_available": False, "audit_scope": reviewed["scope"],
              "decision_policy": "Gemini is accepted when Astra supports or is neutral; explicit contradictions remain for review. Existing evidence, assignment and overlap gates still apply.",
              "unattributed_primary_proposals": sum(e["in_primary_window"] and e["actor_id"] is None for e in records),
              "official_match_statistics": None}
    (root / "player-statistics.json").write_text(json.dumps(output, indent=2))
    usage_records = []
    seen_requests = set()
    for file in sorted(root.glob("*-raw.json")):
        raw = json.loads(file.read_text())
        if raw["fingerprint"] in seen_requests:
            continue
        seen_requests.add(raw["fingerprint"])
        usage_records.append({
            "request_file": file.name, "fingerprint": raw["fingerprint"],
            "model": raw.get("returned_model", raw.get("model_returned")),
            "finish_reason": raw["finish_reason"], "usage": raw.get("usage"),
        })
    # Include token-exhausted attempts in usage accounting, without publishing their partial text.
    (root / "actual-model-usage.json").write_text(json.dumps({
        "successful_and_incomplete_response_usage": usage_records,
        "note": "Actual returned usage; no currency estimate. HTTP failures without usage are not measurable here."
    }, indent=2))
    columns = ["event_id", "player_id", "type", "source_start", "source_end", "source_key",
               "outcome", "included_in_provisional_count", "identity_confidence", "evidence_level",
               "visible_evidence", "identity_basis", "uncertainty", "astra_comment", "decision_basis",
               "goal_accepted", "count_exclusion_reasons"]
    with (root / "event-timestamps.csv").open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=columns)
        writer.writeheader()
        for e in records:
            writer.writerow({k: csv_cell(v) for k, v in {
                "event_id": e["id"], "player_id": e["actor_id"] or "Unassigned", "type": e["type"],
                "source_start": timestamp(e["source_start_s"]), "source_end": timestamp(e["source_end_s"]),
                "source_key": timestamp(e["source_key_s"]), "outcome": e["outcome"],
                "included_in_provisional_count": e["included_in_provisional_count"],
                "identity_confidence": e["identity_confidence"], "evidence_level": e["evidence_level"],
                "visible_evidence": e["evidence"], "identity_basis": e["identity_basis"],
                "uncertainty": e["uncertainty"], "astra_comment": (e["astra_review"] or {}).get("comment", ""),
                "decision_basis": e["decision_basis"], "goal_accepted": e["goal_accepted"],
                "count_exclusion_reasons": e["count_exclusion_reasons"]}.items()})
    stat_columns = ["player_id", "passes", "carries", "shots", "goals", "goal_claims_supported",
                    "unresolved_goal_claims", "completed_pass_proposals", "awaiting_review"]
    with (root / "player-statistics.csv").open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=stat_columns)
        writer.writeheader()
        writer.writerows({k: p[k] for k in stat_columns} for p in stats)
    with (root / "per-minute-statistics.csv").open("w", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=["player_id", "minute", "passes", "carries", "shots", "goals", "goal_claims_supported"])
        writer.writeheader()
        for p in stats:
            for minute in p["minute_splits"]:
                writer.writerow({"player_id": p["player_id"], **minute})

    def inline(path):
        return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode()

    rows, details = [], []
    for p in stats:
        photo = Path("generated-artifacts/player-images") / f'{p["player_id"]}.jpg'
        rows.append(f'<tr><td><img class="portrait" src="{inline(photo)}"><strong>{p["player_id"]}</strong></td>'
                    f'<td>{p["passes"]}</td><td>{p["carries"]}</td><td>{p["shots"]}</td>'
                    f'<td>{p["goals"]}</td><td>{p["unresolved_goal_claims"]}</td>'
                    f'<td>{p["awaiting_review"]}</td></tr>')
        actions = []
        for e in records:
            if e["actor_id"] != p["player_id"] or not e["in_primary_window"]:
                continue
            status = "Included as a provisional observation" if e["included_in_provisional_count"] else "Pending / excluded from count"
            target = f'#evidence-{e["id"]}'
            comment = (e["astra_review"] or {}).get("comment", "Not included in the sampled Astra audit.")
            actions.append(f'<li><a href="{target}">{timestamp(e["source_start_s"])}–{timestamp(e["source_end_s"])}</a>'
                           f' · <strong>{esc(e["type"])}</strong> · {esc(status)}<br>'
                           f'<strong>Count decision:</strong> {esc("; ".join(e["count_exclusion_reasons"]) or "Meets the provisional observation rules")}<br>'
                           f'<strong>Decision basis:</strong> {esc(e["decision_basis"])}'
                           f'{"; goal accepted under the configured rule" if e["goal_accepted"] else ""}<br>'
                           f'<strong>Gemini claim:</strong> {esc(e["evidence"])}<br>'
                           f'<strong>Kit/motion basis:</strong> {esc(e["identity_basis"])}<br>'
                           f'<strong>Assignment / action confidence:</strong> {esc(e["identity_confidence"])} / {esc(e["event_confidence"])} (uncalibrated); {esc(e["evidence_level"])} evidence<br>'
                           f'<strong>Astra:</strong> {esc(comment)}<br>'
                           f'<strong>Uncertainty:</strong> {esc(e["uncertainty"])}</li>')
        details.append(f'<section class="player"><h2>{p["player_id"]}: timestamps</h2><ul>'
                       f'{"".join(actions) or "<li>No attributable proposals found; this is not proof of zero actions.</li>"}</ul></section>')
    gallery = []
    for e in records:
        if not e["in_primary_window"]:
            continue
        f = evidence["event_evidence"][e["id"]]
        path = root / f["file"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != f["sha256"]:
            raise ValueError("Evidence checksum mismatch")
        gallery.append(f'<figure id="evidence-{e["id"]}"><h3>{esc(e["id"])} · {esc(e["actor_id"] or "Unassigned")}'
                       f' · {esc(e["type"])}</h3><p>Action interval: {timestamp(e["source_start_s"])}–'
                       f'{timestamp(e["source_end_s"])}. Original key frame: {timestamp(f["source_time_s"])}.</p>'
                       f'<img class="evidence" src="{inline(path)}"><figcaption>'
                       f'<strong>Gemini proposal:</strong> {esc(e["evidence"])}'
                       f'<br><strong>Count policy:</strong> {esc(e["decision_basis"])}'
                       f'{"; goal accepted." if e["goal_accepted"] else "."}'
                       f'<br><strong>Astra outcome review:</strong> '
                       f'{esc((e["astra_review"] or {}).get("outcome_verdict", "not included in sampled audit"))}.'
                       f'<br>Assignment: {esc(e["identity_basis"])}. This single frame is a location reference, '
                       f'not proof of every claimed motion or outcome.</figcaption></figure>')
    unassigned = [e for e in records if e["in_primary_window"] and e["actor_id"] is None]
    unassigned_text = "".join(f'<li>{timestamp(e["source_start_s"])}–{timestamp(e["source_end_s"])} · '
                              f'{esc(e["type"])} · {esc(e["evidence"])}<br>{esc(e["uncertainty"])}'
                              f'<br><strong>Astra challenge:</strong> '
                              f'{esc((e["astra_review"] or {}).get("comment", "Not included in the sampled audit."))}'
                              '</li>' for e in unassigned)
    page = f"""<!doctype html><html lang="en"><meta charset="utf-8"><title>First three minutes — player statistics</title>
<style>@page{{size:A4 landscape;margin:12mm}}body{{font:11pt/1.45 Arial;color:#16251c;margin:0}}
h1{{font-size:25pt}}h2{{font-size:18pt}}a{{color:#195c43}}table{{width:100%;border-collapse:collapse}}
th,td{{border-bottom:1px solid #bac8bf;padding:7px;text-align:left}}tr{{break-inside:avoid}}
.portrait{{height:44px;vertical-align:middle;margin-right:12px}}.notice{{background:#f3ead6;padding:14px}}
li{{margin-bottom:15px}}section{{break-before:page}}.player{{break-before:auto}}h2{{break-after:avoid}}
thead{{display:table-header-group}}figure{{break-before:page;margin:0}}
.evidence{{width:100%;max-height:140mm;object-fit:contain}}figcaption{{font-size:10pt}}
</style><h1>Unknown1–Unknown12 · first three minutes</h1><p>Source-video interval 00:00–03:00.
Labels match the existing player-image PDF. Association uses kit, shoes, readable numbers and movement—not faces.</p>
<div class="notice"><strong>Provisional observations, not certified match totals.</strong>
This is not an exhaustive event count; missed actions and incorrect kit assignments may remain.
Only high-confidence, directly visible event proposals with high-confidence player assignment enter the table;
Gemini is accepted when Astra supports or is neutral; explicit action/identity contradictions remain pending.
Zero means no qualifying attributed proposal—not proof that the player made no actions.
Goals follow the same rule: Astra neutrality retains Gemini's goal decision; an explicit outcome contradiction blocks the goal.
Accepted goals are policy-based decisions, not claims that both models agreed.
Model agreement is not ground truth. Same-colour kits, camera pans and occlusion can cause missing or wrong assignments.</div>
<h2>Per-player counts</h2><table><thead><tr><th>Reference</th><th>Pass attempts</th><th>Carry episodes</th>
<th>Shots</th><th>Goals<br>accepted</th><th>Goal claims<br>pending</th><th>Other pending<br>proposals*</th></tr>
</thead><tbody>{"".join(rows)}</tbody></table><p>*Pending proposal count can include an unresolved shot/goal claim; do not sum columns as distinct actions.
Passes mean attempts, not necessarily completed passes. No precision, recall or pass-accuracy percentage is established.</p>
<p><strong>Astra audit:</strong> {esc(reviewed["scope"])} The audit inspected {len(audit)} selected claims
after an independent first look; remaining proposals are video-model-only.
{len(unassigned)} primary proposals have no dependable player assignment.</p>
{"".join(details)}<section><h2>Actions without dependable player assignment</h2>
<ul>{unassigned_text or "<li>None explicitly unassigned by the model; this does not guarantee all identities are correct.</li>"}</ul></section>
<section><h2>How to read the evidence</h2><p>Timestamps refer to elapsed source-video time, not the camera's burned-in clock.
Action intervals are approximate model estimates; evidence stills use the nearest original source-frame time.
Alternative player/action interpretations in Astra's comments remain review proposals and are not automatically added to counts.
An evidence frame is a navigation aid; review the action interval in the original video to establish touches and outcomes.
A shot and its goal outcome are one action, not two shots. An uninterrupted carry is one episode.
Cross-clip overlapping duplicates are excluded conservatively. Counts are incomplete when visibility or identity is uncertain.</p>
<p>The downloadable bundle includes the complete event ledger, count exclusions, raw model responses,
fixed reference hashes, actual usage and per-minute CSV splits. No production statistics were changed.</p></section>
{"".join(gallery)}</html>"""
    html_file = root / "three-minute-player-statistics.html"
    html_file.write_text(page)
    pdf = (root / "three-minute-player-statistics.pdf").resolve()
    subprocess.run([shutil.which("chromium") or "chromium", "--headless", "--no-sandbox", "--disable-gpu",
                    "--no-pdf-header-footer", f"--print-to-pdf={pdf}", html_file.resolve().as_uri()],
                   check=True, capture_output=True, timeout=120)
    files = ["three-minute-player-statistics.pdf", "player-statistics.json", "player-statistics.csv",
             "event-timestamps.csv", "per-minute-statistics.csv", "manifest.json", "evidence-manifest.json",
             "video-proposals.json", "astra-audit.json", "actual-model-usage.json"]
    with zipfile.ZipFile(root / "three-minute-statistics-evidence.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for name in files:
            z.write(root/name, arcname=name)
        for folder in ("references", "evidence"):
            for file in (root/folder).glob("*.jpg"):
                z.write(file, arcname=str(file.relative_to(root)))
        for file in root.glob("audit-*.json"):
            z.write(file, arcname=file.name)
    print(json.dumps({"players": stats, "primary_proposals": sum(e["in_primary_window"] for e in records),
                      "unassigned": len(unassigned), "audited": len(audit)}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    build(parser.parse_args().input)
