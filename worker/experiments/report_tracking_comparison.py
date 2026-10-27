"""Build a private, explicitly partial comparison report from saved experiment evidence."""
import base64
import gzip
import hashlib
import html
import io
import json
import subprocess
import textwrap
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from fa_worker.player_tracking import TrackingEvidence, unpack_tracks

ROOT = Path("generated-artifacts/tracking-comparison")


def records(mode):
    return [json.loads(gzip.decompress(p.read_bytes())) for p in
            sorted((ROOT/mode/"checkpoints").glob("llm-*.json.gz"), key=lambda p: p.stat().st_mtime_ns)]


def build():
    data = unpack_tracks((ROOT/"player-tracks.json.gz").read_bytes())
    tracking = TrackingEvidence(data)
    roster = next(r["result"]["players"] for r in records("baseline") if "players" in r.get("result", {}))
    catalog, merges = [], []
    for index, p in enumerate(roster):
        label = f"Unknown{len(catalog)+1}"
        bound = tracking.anchor([22,24][p["frame"]], p["box"], label)
        if bound and bound != label:
            merges.append({"rawReference": index+1, "retainedLabel": bound})
        else:
            catalog.append({**p, "id": label})
    first_base = next(r["result"]["events"] for r in records("baseline") if "events" in r.get("result", {}))
    first_tracking = [r["result"]["events"] for r in records("tracking") if "events" in r.get("result", {})][-1]
    first_base = [e for e in first_base if e["key"] < 20]
    first_tracking = [tracking.reconcile(dict(e)) for e in first_tracking if e["key"] < 20]
    def counts(events):
        types = Counter(e["type"] for e in events)
        return {"proposedEvents": len(events), "passes": types["pass"], "carries": types["carry"],
                "shots": types["shot"], "goalProposals": sum(e["outcome"] == "goal" for e in events),
                "playerAssignedProposals": sum(e["actorId"] is not None for e in events),
                "unassignedProposals": sum(e["actorId"] is None for e in events)}
    summary = {
        "status": "partial_comparison_provider_rate_limited",
        "sourceSha256": hashlib.file_digest(Path("generated-artifacts/football-first-three-minutes.mp4").open("rb"), "sha256").hexdigest(),
        "sourceSeconds": 180, "trackingCompletedSeconds": 180, "sampledFrames": len(data["frames"]),
        "baselineReferences": len(roster), "trackingReferences": len(catalog), "merges": merges,
        "temporaryTracks": data["trackCount"], "continuityRegions": data["scenes"],
        "anchoredTracks": len(tracking.bindings),
        "commonIntervalSeconds": [0, 20],
        "commonIntervalGeminiOnlyProposals": {"baseline": counts(first_base), "tracking": counts(first_tracking)},
        "astraCompleted": False,
        "baselineStatus": json.loads((ROOT/"baseline"/"status.json").read_text()),
        "trackingStatus": json.loads((ROOT/"tracking"/"status.json").read_text()),
        "conclusion": "Five repeated reference entries were merged, but player identity accuracy and full match statistics are not established. Keep tracking experimental and off by default.",
    }
    (ROOT/"comparison-summary.json").write_text(json.dumps(summary, indent=2))
    # Show the SAME source moments with current (camera-compensated) track IDs.
    montage = Image.new("RGB", (1280, 1440))
    for i,t in enumerate([22,24]):
        raw = subprocess.check_output(["ffmpeg","-v","error","-ss",str(t),"-i",
            "generated-artifacts/football-first-three-minutes.mp4","-frames:v","1","-f","image2pipe","-vcodec","mjpeg","-"])
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        draw = ImageDraw.Draw(image)
        for p in tracking.at(t)["people"]:
            box = [v*s/1000 for v,s in zip(p["box"], [image.width,image.height,image.width,image.height])]
            draw.rectangle(box, outline="yellow", width=2)
            label = p["id"] + (" / "+tracking.bindings[p["id"]] if p["id"] in tracking.bindings else "")
            draw.text((box[0],max(0,box[1]-14)), label, fill="yellow")
        draw.text((12,12), f"Source 00:{t:02d} - temporary track IDs; not verified identities", fill="white")
        montage.paste(image,(0,i*720))
    montage.save(ROOT/"tracking-reference-check.jpg", quality=85)
    lines = [
        ("Football Vision: three-minute tracking test", 32),
        ("PARTIAL AI COMPARISON - Gemini returned HTTP 429", 23),
        ("The detector/tracker processed all 180 seconds at 5 samples/sec (900 frames). Neither AI mode completed its full event-analysis and Astra-review stages. These are not final match statistics.", 21),
        ("Reference-label comparison (same Gemini roster input)", 25),
        (f"Original reference entries: {len(roster)} | Tracking-assisted entries: {len(catalog)} | Repeated entries removed: {len(merges)}", 22),
        ("This measures repeated reference entries, NOT verified unique players or identity accuracy. Labels can still be duplicated or incorrectly associated.", 20),
        ("Tracking quality and limitations", 25),
        (f"{data['trackCount']} temporary track fragments; {data['scenes']} continuity regions/resets; {len(tracking.bindings)} tracks anchored to reference labels. These are NOT counts of actual players or camera cuts.", 21),
        ("Camera movement, distant players, occlusion and night lighting remain difficult. A shorter label list does not prove better per-player statistics.", 21),
        ("Shared first 20 seconds: provisional Gemini proposals only", 25),
    ]
    for mode, values in summary["commonIntervalGeminiOnlyProposals"].items():
        lines.append((f"{mode.capitalize()}: {values['proposedEvents']} proposed events; {values['passes']} passes, {values['carries']} carries, {values['shots']} shots; {values['playerAssignedProposals']} assigned, {values['unassignedProposals']} unassigned.", 21))
    lines += [
        ("Different proposed event counts are model variation, not accuracy. No independent action/outcome ground truth was established. Astra review did not finish; no full three-minute goals/pass/shot comparison is available.", 20),
        ("Recommendation: keep the original Gemini + Astra mode as default. Treat tracking as an optional diagnostic until independently reviewed player continuity and event assignments improve.", 22),
        ("Operational status: Modal worker updated; publish the website to expose the optional mode. No production match was changed by this benchmark. No new automated AI retries are running.", 20),
    ]
    page = Image.new("RGB",(1240,1754),"white")
    draw = ImageDraw.Draw(page)
    y = 65
    for text, size in lines:
        font = ImageFont.load_default(size=size)
        for line in textwrap.wrap(text, width=int(1120/(size*.53))):
            draw.text((60,y),line,font=font,fill="#16372b")
            y += size+9
        y += 13
    evidence_page = Image.new("RGB",(1240,1754),"white")
    evidence_draw = ImageDraw.Draw(evidence_page)
    evidence_draw.text((60,50),"Reference evidence: 00:22 and 00:24",font=ImageFont.load_default(size=30),fill="#16372b")
    picture = montage.copy()
    picture.thumbnail((1120,1400))
    evidence_page.paste(picture,(60,120))
    evidence_draw.text((60,1560),"Yellow boxes are temporary tracker observations, not verified identities.",font=ImageFont.load_default(size=21),fill="#16372b")
    page.save(ROOT/"tracking-comparison-report.pdf",save_all=True,append_images=[evidence_page],resolution=150)
    embedded = base64.b64encode((ROOT/"tracking-reference-check.jpg").read_bytes()).decode()
    content = "".join(f"<p style='font-size:{size/1.5}px'>{html.escape(text)}</p>" for text,size in lines)
    (ROOT/"tracking-comparison-report.html").write_text(f"<!doctype html><meta charset='utf-8'><title>Tracking comparison</title><style>body{{font-family:Arial;max-width:980px;margin:40px auto;padding:20px;color:#16372b}}img{{max-width:100%}}</style>{content}<img src='data:image/jpeg;base64,{embedded}' alt='Player tracking evidence at 22 and 24 seconds'>")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    build()
