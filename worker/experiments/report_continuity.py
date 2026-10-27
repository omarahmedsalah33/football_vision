"""Private continuity diagnostics, explicitly not a new Gemini/Astra event analysis."""
import io
import json
import subprocess
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from fa_worker.player_tracking import TrackingEvidence, unpack_tracks

ROOT = Path("generated-artifacts/tracking-continuity-v3-guarded")
SOURCE = Path("generated-artifacts/football-first-three-minutes.mp4")


def build():
    audit = json.loads((ROOT/"continuity-audit.json").read_text())
    before,after = audit["modes"]["previous"],audit["modes"]["updated"]
    tracker = TrackingEvidence(unpack_tracks((ROOT/"player-tracks.json.gz").read_bytes()))
    tracker.bindings = after["bindings"]
    tid = next(k for k,v in tracker.bindings.items() if v == "Unknown7")
    if any(p["id"] == tid for t in (26,28.3) for p in tracker.at(t)["people"]):
        raise RuntimeError("The reference ID persists through the known shirt switch; do not publish this report")
    grid = Image.new("RGB",(1200,960),"#10291e")
    for index,seconds in enumerate([22,24,26,27.8,28.3,29.2]):
        raw = subprocess.check_output(["ffmpeg","-v","error","-ss",str(seconds),"-i",str(SOURCE),
            "-frames:v","1","-f","image2pipe","-vcodec","mjpeg","-"])
        source = Image.open(io.BytesIO(raw)).convert("RGB")
        f = tracker.at(seconds)
        person = next((p for p in f["people"] if p["id"] == tid),None)
        cell = Image.new("RGB",(400,480),"#10291e")
        draw = ImageDraw.Draw(cell)
        draw.text((10,8),f"{seconds:.1f}s | {tid} / Unknown7",font=ImageFont.load_default(size=20),fill="white")
        if person:
            x1,y1,x2,y2 = [value*size/1000 for value,size in zip(person["box"],[source.width,source.height]*2)]
            pad = max(8,(x2-x1)*.4)
            crop = source.crop((max(0,x1-pad),max(0,y1-pad),min(source.width,x2+pad),min(source.height,y2+pad)))
            scale = min(380/crop.width,410/crop.height,4)
            crop = crop.resize((int(crop.width*scale),int(crop.height*scale)),Image.Resampling.BICUBIC)
            cell.paste(crop,((400-crop.width)//2,45))
        else:
            draw.text((10,60),"Not observed; no inferred image",fill="white")
        grid.paste(cell,((index%3)*400,(index//3)*480))
    grid.save(ROOT/"goal-track-evidence.jpg",quality=90)
    lines = [
        ("Football Vision: reduced tracking gaps",32),
        ("Full 180-second detector/tracker test; no new Gemini/Astra event calls",22),
        ("Metric | Previous tracker | Updated tracker",25),
        (f"Temporary person tracks: {before['temporaryTracks']} | {after['temporaryTracks']}",23),
        (f"Continuity regions / ID resets: {before['continuityRegions']} | {after['continuityRegions']}",23),
        (f"Reference-label entries after deduplication: {before['referenceLabels']} | {after['referenceLabels']}",23),
        (f"Person observations attached to reference tracks: {100*before['referenceBackedObservationFraction']:.1f}% | {100*after['referenceBackedObservationFraction']:.1f}%",23),
        ("Rates are normalized because tracking sampling increased from 5 to 10 fps. These are geometric coverage measures, not verified unique-player counts or identity accuracy.",21),
        ("The number of temporary IDs can rise when the guard deliberately splits a false player link. An ID count alone does not tell us whether identities became more accurate.",21),
        ("What changed",26),
        ("Corrected ByteTrack's lost-track buffer units: a two-second request must be supplied in 30-fps units, not the sampling frame rate. Camera motion is estimated before declaring an image change a cut; a background-corner fallback handles wider pans. Ten-fps sampling and lower-confidence detections help recover existing tracks without lowering the new-track activation threshold.",21),
        ("A colour safeguard breaks a track if its observed shirt switches clearly between light and blue. Colour is negative evidence only: it never joins two tracks or identifies a person. Ambiguous or same-colour swaps remain possible.",21),
        ("Timestamp evidence and withdrawn claim",26),
        ("An earlier unguarded 10-fps experiment mistakenly put the same ID on a light-shirted player at 22-24s, a blue-shirted player at 25.6-26.6s, and a light-shirted player again around 28s. That ID cannot establish that the shooter is Unknown7. The next pages first show this REJECTED old sequence, then show that the guarded reference track stops before the shirt switch.",21),
        ("Important limits",26),
        ("The reference catalog is still sampled near the beginning. Most detected person observations remain unanchored. IDs can still switch during crossings, occlusions or camera changes; spectators may also be detected. No face recognition, cross-cut identity stitching, ball tracking or calibrated speed was added.",21),
        ("This is NOT a new pass/shot/goal or player-statistics comparison. Previous Gemini/Astra totals are unchanged. A new inference run and independent event review are needed before claiming improved individual statistics. Keep tracking optional.",22),
    ]
    pages = []
    page = Image.new("RGB",(1240,1754),"white")
    pages.append(page)
    draw = ImageDraw.Draw(page)
    y = 55
    for text,size in lines:
        for line in textwrap.wrap(text,width=int(1120/(size*.54))):
            if y+size+20 > 1680:
                page=Image.new("RGB",(1240,1754),"white")
                pages.append(page)
                draw=ImageDraw.Draw(page)
                y=55
            draw.text((60,y),line,font=ImageFont.load_default(size=size),fill="#16372b")
            y+=size+9
        y+=15
    old_grid = Image.open("generated-artifacts/tracking-continuity-v2-10fps/goal-track-evidence.jpg").convert("RGB")
    page=Image.new("RGB",(1240,1754),"white")
    draw=ImageDraw.Draw(page)
    draw.text((40,40),"REJECTED: same ID switches light-blue-light",font=ImageFont.load_default(size=29),fill="#16372b")
    page.paste(old_grid,(20,130))
    draw.text((40,1140),"This earlier ID is NOT reliable evidence of one player.",font=ImageFont.load_default(size=22),fill="#16372b")
    pages.append(page)
    page=Image.new("RGB",(1240,1754),"white")
    draw=ImageDraw.Draw(page)
    draw.text((40,40),"Guarded: original reference ID does not cross the switch",font=ImageFont.load_default(size=27),fill="#16372b")
    page.paste(grid,(20,130))
    draw.text((40,1140),"Missing frames are not inferred or automatically joined to the shooter.",font=ImageFont.load_default(size=22),fill="#16372b")
    pages.append(page)
    pages[0].save(ROOT/"tracking-continuity-report.pdf",save_all=True,append_images=pages[1:],resolution=150)
    print("Saved continuity report and timestamp evidence; no new event statistics produced.")


if __name__ == "__main__":
    build()
