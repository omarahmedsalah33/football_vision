"""Report completed sequential runs only. Counts are AI estimates, not ground truth."""
import argparse
import html
import json
import textwrap
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path("generated-artifacts/tracking-comparison")


def summarize(analysis):
    events = analysis["events"]
    accepted = [e for e in events if e["matchIncluded"]]
    counts = Counter(e["type"] for e in accepted)
    return {
        "referenceLabels": len(analysis["catalog"]),
        "proposedEvents": len(events),
        "matchPasses": counts["pass"],
        "matchCarries": counts["carry"],
        "matchShots": counts["shot"],
        "shotsOnTarget": sum(e["type"] == "shot" and e["outcome"] in {"goal", "on_target"}
                            and (e.get("review") or {}).get("outcome") != "contradicted" for e in accepted),
        "goals": sum(e["goalAccepted"] for e in events),
        "playerAttributedEvents": sum(e["included"] for e in events),
        "matchEventsWithoutCountedPlayer": sum(not e["included"] for e in accepted),
        "excludedMatchProposals": len(events)-len(accepted),
        "astraReviewedEvents": analysis["audit"]["reviewed"],
        "completedWindows": analysis["completedWindows"],
        "totalWindows": analysis["totalWindows"],
        "players": analysis["players"],
        "tracking": analysis.get("tracking"),
    }


def build(tracking_mode="tracking"):
    single_frame = tracking_mode == "single-frame"
    full_gallery = tracking_mode == "full-gallery"
    action_first = tracking_mode == "action-first"
    updated_standard = single_frame or full_gallery or action_first
    candidate = "updated" if updated_standard else "tracking"
    candidate_title = "Updated Gemini + Astra" if updated_standard else "With player tracking"
    stem = ("completed-comparison-action-first" if action_first else
            "completed-comparison-full-gallery" if full_gallery else
            "completed-comparison-single-frame" if single_frame else
            "completed-comparison-v3" if tracking_mode == "tracking-v3" else "completed-comparison")
    analyses = {}
    for label,mode in [("baseline","baseline"),(candidate,tracking_mode)]:
        status = json.loads((ROOT/mode/"status.json").read_text())
        if status["status"] != "succeeded":
            raise RuntimeError(f"{mode} is not complete; do not publish a full comparison")
        analysis = json.loads((ROOT/mode/"result.json").read_text())["summary"]["videoEvents"]
        if analysis["completedWindows"] != analysis["totalWindows"] or analysis["durationSeconds"] != 180:
            raise RuntimeError(f"{mode} does not cover the entire three-minute video")
        if mode == "tracking-v3" and analysis.get("tracking",{}).get("method") != "rfdetr-bytetrack-v3":
            raise RuntimeError("Guarded comparison must be from the v3 trajectory.")
        if updated_standard and label == candidate:
            policy = "action-first-v1" if action_first else "full-video-gallery-v1" if full_gallery else "single-frame-v1"
            if analysis.get("tracking") or analysis.get("audit",{}).get("catalogPolicy") != policy:
                raise RuntimeError("Updated standard run must use the requested gallery policy without tracking.")
            if full_gallery:
                gallery = analysis["audit"].get("gallery",{})
                if gallery.get("completedWindows")!=9 or gallery.get("scannedDurationSeconds")!=180:
                    raise RuntimeError("Gallery discovery must cover the whole three-minute video.")
        analyses[label] = analysis
    summary = {mode: summarize(a) for mode,a in analyses.items()}
    summary["status"] = "completed_sequential_comparison"
    summary["sourceSeconds"] = 180
    summary["trackingMethod"] = (analyses[candidate].get("tracking") or {}).get("method")
    if full_gallery:
        summary["galleryAudit"] = analyses[candidate]["audit"]["gallery"]
    if action_first:
        summary["actorAudit"] = analyses[candidate]["audit"]["identity"]
        summary["duplicateProposals"] = analyses[candidate]["audit"]["duplicateProposals"]
    summary["caveat"] = "AI estimates under the app's counting policy. Model agreement and fewer reference labels do not establish accuracy. Unknown labels are local to each run, not interchangeable."
    summary["goalPolicy"] = "A neutral/inconclusive Astra outcome retains Gemini's estimate; an accepted goal is not necessarily an independently confirmed goal-line crossing."
    summary["shotEvidenceComparison"] = {
        mode: [
            {k: e.get(k) for k in ("key", "outcome", "actorId", "review")}
            for e in a["events"] if e["type"] == "shot" and e["matchIncluded"]
        ] for mode,a in analyses.items()
    }
    b,t = summary["baseline"], summary[candidate]
    summary["measuredPlayerAttribution"] = (
        f"{candidate_title} counted more player-attributed events, but this is not proof of accurate identities."
        if t["playerAttributedEvents"] > b["playerAttributedEvents"] else
        f"{candidate_title} did not increase counted player attribution on this clip.")
    (ROOT/f"{stem}.json").write_text(json.dumps(summary, indent=2))
    metrics = [
        ("Reference labels", "referenceLabels"), ("Proposed events", "proposedEvents"),
        ("Counted match passes", "matchPasses"), ("Counted match carries", "matchCarries"),
        ("Counted match shots", "matchShots"), ("Estimated shots on target", "shotsOnTarget"),
        ("Estimated goals", "goals"), ("Player-attributed events", "playerAttributedEvents"),
        ("Match events without counted player", "matchEventsWithoutCountedPlayer"),
        ("Excluded match proposals", "excludedMatchProposals"), ("Astra-reviewed events", "astraReviewedEvents"),
    ]
    pages = []
    page = draw = y = None
    def new_page():
        nonlocal page,draw,y
        page = Image.new("RGB", (1240,1754),"white")
        draw = ImageDraw.Draw(page)
        pages.append(page)
        y = 65
    def paragraph(text,size=23):
        nonlocal y
        for line in textwrap.wrap(text,width=int(1120/(size*.54))):
            if y+size+20 > 1680:
                new_page()
            draw.text((60,y),line,font=ImageFont.load_default(size=size),fill="#16372b")
            y += size+9
        y += 15
    new_page()
    paragraph("Football Vision: completed three-minute comparison",32)
    paragraph("Original vs updated Gemini + Astra" if updated_standard else
              "Original Gemini + Astra vs guarded player tracking",26)
    paragraph("The original run was preserved. The updated run detects ball actions first, then examines short action contexts to assign actors using a canonical registry. Uncertain actors remain unassigned. All canonical actions receive blind-first Astra checks. No separate whole-video roster pass or computer-vision tracker was used." if action_first else
              "The original run was preserved. The updated run reuses the previously delivered starting labels, then scans every video section to build a canonical multi-view gallery before event analysis. Tracking is off. Both runs completed all nine event windows and targeted Astra checks." if full_gallery else
              "The original completed run was preserved. The updated run uses a single frozen reference frame, without tracking. All model calls were newly inferred or resumed from this run's own checkpoints. Both runs completed all nine windows and targeted Astra checks." if single_frame else
              "The completed original run was reused unchanged. The guarded run was processed separately on the same video, using the identical saved reference request. Both completed nine event windows and their targeted Astra checks. New calls were paced.")
    paragraph("These are AI-estimated counts, NOT independently verified match statistics. Differences can reflect changed inputs, prompts, sampling and model variation, not improved accuracy.",24)
    paragraph(f"Metric | Original Gemini + Astra | {candidate_title}",25)
    for label,key in metrics:
        paragraph(f"{label}:  {b[key]}  |  {t[key]}",22)
    paragraph(summary["goalPolicy"],22)
    paragraph("Shot timestamps and review disagreement",26)
    for mode,shots in summary["shotEvidenceComparison"].items():
        for shot in shots:
            review = shot.get("review") or {}
            paragraph(f"{mode.capitalize()} counted shot at {shot['key']:.1f}s: outcome {shot['outcome']}; Astra action {review.get('action','not reviewed')}, outcome {review.get('outcome','not reviewed')}.",22)
    paragraph("Equal shot totals do not mean the modes found the same event. Player-attributed totals likewise mean accepted by the pipeline, not independently verified identities. A neutral Astra action or outcome retains Gemini's high-confidence estimate under the requested policy.",22)
    for mode,a in analyses.items():
        for e in a["events"]:
            if e["goalAccepted"] and (e.get("review") or {}).get("outcome") == "inconclusive":
                paragraph(f"{mode.capitalize()} goal estimate at {e['key']:.1f}s - Astra outcome inconclusive: {e['review']['comment']}",19)
    paragraph("Interpretation",26)
    paragraph(summary["measuredPlayerAttribution"],23)
    paragraph(f"The reference catalog changed from {b['referenceLabels']} to {t['referenceLabels']} labels. {candidate_title} counted {t['playerAttributedEvents']} player-attributed events versus {b['playerAttributedEvents']} originally. Fewer labels or different match counts alone are not evidence of better player accuracy.")
    paragraph("Unknown1 in one run is not necessarily Unknown1 in the other. No face recognition, ball tracking, calibrated speed or distance was added.")
    if action_first:
        actor = summary["actorAudit"]
        paragraph(f"Targeted actor groups: {actor['targetedGroups']}; late-link groups: {actor['lateLinkGroups']}; assignments before Astra: {actor['assignedActions']}; unresolved before Astra: {actor['unresolvedActions']}; duplicate proposals excluded: {summary['duplicateProposals']}.")
        paragraph("The updated catalog covers actors in detected actions, NOT every player on the pitch. This differs from the old pitch-wide reference catalog. A lower label count is therefore not a measured duplicate-removal rate. Actor assignments and model reviews are estimates, not independent identity verification.")
        paragraph("Reference images are collected near actions across the video. Canonical IDs are stable within this run but are not interchangeable with the original run's labels.")
    elif full_gallery:
        g = summary["galleryAudit"]
        paragraph(f"Full-video reference pass: {g['completedWindows']}/9 sections; {g['scannedDurationSeconds']} seconds. New player labels added: {g['newPlayers']}; existing appearances reused: {g['matchedAppearances']}; unresolved appearances: {g['unresolvedAppearances']}; retained reference views: {g['referenceImages']}.")
        paragraph("Several pictures may belong to one canonical Unknown. A new label requires positive distinct-person evidence; shared shirt colour alone cannot establish identity. Ambiguous appearances stay unresolved. These are model associations, not independently verified unique players.")
    elif single_frame:
        paragraph("The new roster does not list the same player again from a second reference frame. Near-identical boxes are rejected, not same-colour kits. People missing from the snapshot remain unassigned. Fewer references can reflect both removed duplicates and reduced roster coverage; human review is needed to distinguish them.")
    else:
        paragraph("Tracking only anchors supported temporary tracks; gaps, occlusions and camera changes remain unresolved.")
        paragraph("Recommendation: keep tracking experimental and the original mode as default until timestamp-by-timestamp human review confirms better player continuity and attribution.")
    for mode,a in analyses.items():
        new_page()
        paragraph(("Original mode" if mode == "baseline" else candidate_title)+" - per-player estimates",30)
        paragraph("Counts below include only events accepted for this player under the pipeline policy. Zero means no event was safely counted; it does not mean the player performed no actions.")
        paragraph("Label | Passes | Carries | Shots | Goals | Pending",23)
        for p in a["players"]:
            paragraph(f"{p['id']}  |  {p['passes']}  |  {p['carries']}  |  {p['shots']}  |  {p['goals']}  |  {p['pending']}",21)
        paragraph("Events and source timestamps",25)
        for e in a["events"]:
            minute,second = divmod(e["key"],60)
            actor = e["actorId"] if e["included"] else "unassigned / pending"
            paragraph(f"{int(minute):02d}:{second:04.1f} - {e['type']} ({e['outcome']}); {actor}; match {'counted' if e['matchIncluded'] else 'excluded'}; Astra {'checked' if e.get('review') else 'not selected'}.",19)
    pages[0].save(ROOT/f"{stem}-report.pdf",save_all=True,append_images=pages[1:],resolution=150)
    # A self-contained companion preserves the full event evidence and review comments.
    sections = []
    for mode,a in analyses.items():
        table = "".join(f"<tr><td>{html.escape(label)}</td><td>{summary[mode][key]}</td></tr>" for label,key in metrics)
        sections.append(f"<h2>{mode}</h2><table>{table}</table>")
        for e in a["events"]:
            sections.append("<details><summary>"+html.escape(f"{e['key']:.1f}s - {e['type']} - {e['actorId'] or 'unassigned'}")+"</summary><pre>"+html.escape(json.dumps(e,indent=2))+"</pre></details>")
    (ROOT/f"{stem}-report.html").write_text("<!doctype html><meta charset='utf-8'><title>Completed comparison</title><style>body{font-family:Arial;max-width:960px;margin:40px auto;padding:20px;color:#16372b}td{padding:7px;border-bottom:1px solid #ccc}pre{white-space:pre-wrap}details{margin:12px 0}</style><h1>Completed sequential comparison</h1><p>"+html.escape(summary["caveat"])+"</p>"+"".join(sections))
    print(json.dumps({k:v for k,v in summary.items() if k not in {"baseline",candidate}}))
    print(json.dumps({mode:{k:v for k,v in summary[mode].items() if k not in {"players","tracking"}} for mode in analyses},indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tracking-mode",choices=["tracking","tracking-v3","single-frame","full-gallery","action-first"],default="tracking")
    build(parser.parse_args().tracking_mode)
