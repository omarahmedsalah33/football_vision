"""Non-biometric, full-duration Gemini event analysis with blind-first Astra checks."""
from __future__ import annotations

import gzip
import io
import json
import logging
import math
import subprocess
import time
from collections import Counter
from pathlib import Path

from PIL import Image

from .errors import JobFailure
from .video_provider import WindowLimit

POLICY = "Accept Gemini when Astra supports or is neutral. Explicit contradictions remain pending. Labels use kit, numbers, shoes and short-term motion, never faces."
VERDICTS = {"supported", "contradicted", "inconclusive"}
TYPES = {"pass", "carry", "shot", "unclear_kick", "take_on", "tackle", "interception", "recovery", "duel"}
CONFIDENCE = {"high", "medium", "low", "unassigned"}
OUTCOMES = {"completed", "incomplete", "goal", "on_target", "off_target", "unknown", "not_applicable", "won", "lost"}


def command(args):
    try:
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
                       check=True, capture_output=True, timeout=120)
    except (subprocess.SubprocessError, OSError):
        raise JobFailure("video_decode_failed", "A section of the uploaded video could not be decoded.") from None


def frame(source, seconds, target):
    command(["-ss", str(max(0, seconds)), "-i", str(source), "-frames:v", "1",
             "-vf", "scale='min(1280,iw)':-2", "-q:v", "2", str(target)])
    return target.read_bytes()


def number(value, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= maximum:
        raise ValueError("Invalid source time")
    return float(value)


def validate_events(data, duration, ids):
    # Some otherwise valid JSON-mode video responses return the event array at
    # the top level rather than inside {"events": ...}. Keep full field checks.
    events = data if isinstance(data, list) else data.get("events") if isinstance(data, dict) else None
    if not isinstance(events, list) or len(events) > 40:
        raise ValueError("Invalid event list")
    for e in events:
        if not isinstance(e, dict):
            raise ValueError("Invalid event")
        start, end, key = (number(e[k], duration) for k in ("start", "end", "key"))
        if not start <= key <= end or e.get("type") not in TYPES or e.get("outcome") not in OUTCOMES:
            raise ValueError("Invalid event")
        if e.get("actorId") is not None and e["actorId"] not in ids:
            raise ValueError("Unknown actor")
        if e.get("identityConfidence") not in CONFIDENCE or e.get("eventConfidence") not in CONFIDENCE:
            raise ValueError("Invalid confidence")
        if e.get("evidenceLevel") not in {"direct", "partial", "inferred"}:
            raise ValueError("Invalid evidence")
        if e["outcome"] == "goal" and e["type"] != "shot":
            raise ValueError("Only a shot can score")
        if e["type"] in {"take_on","tackle","interception","recovery","duel"} and e["outcome"] not in {
            "won","lost","completed","incomplete","unknown"}:
            raise ValueError("Invalid contest outcome")
        if any(not isinstance(e.get(k), str) or len(e[k]) > 3000 for k in ("evidence", "uncertainty")):
            raise ValueError("Missing evidence text")
    return events


def decisions(events):
    for i, e in enumerate(events):
        reasons = []
        if e.get("duplicateOf"):
            reasons.append("Overlapping event already counted")
        if e["eventConfidence"] != "high" or e["evidenceLevel"] != "direct":
            reasons.append("Gemini's action evidence is uncertain")
        if e["type"] == "unclear_kick":
            reasons.append("Kick intent unresolved")
        review = e["review"]
        if review and review["action"] == "contradicted":
            reasons.append("Astra explicitly contradicts the action")
        if not reasons:
            for previous in events[:i]:
                if (previous["matchIncluded"] and previous["actorId"] is not None
                    and previous["actorId"] == e["actorId"] and previous["type"] == e["type"]
                    and previous["window"] != e["window"]
                    and min(previous["end"], e["end"]) > max(previous["start"], e["start"])
                    and (e["type"] == "carry" or abs(previous["key"]-e["key"]) < 1)):
                    reasons.append("Overlapping event already counted")
                    break
        e["matchIncluded"] = not reasons
        e["goalAccepted"] = bool(not reasons and e["type"] == "shot" and e["outcome"] == "goal"
                                 and (not review or review["outcome"] != "contradicted"))
        if e["actorId"] is None or e["identityConfidence"] != "high":
            reasons.append("Player assignment uncertain")
        if review and review["identity"] == "contradicted":
            reasons.append("Astra explicitly contradicts the player assignment")
        e["included"], e["exclusionReasons"] = not reasons, reasons
    return events


def totals(events, catalog, duration):
    players = []
    for p in catalog:
        observed = [e for e in events if e["actorId"] == p["id"] and not e.get("duplicateOf")]
        counted = [e for e in observed if e["included"]]
        def counts(group):
            c = Counter(e["type"] for e in group)
            return {"passes": c["pass"], "carries": c["carry"], "shots": c["shot"],
                    "goals": sum(e["goalAccepted"] for e in group)}
        players.append({"id": p["id"], **counts(counted),
                        "pending": sum(not e["included"] or (e["outcome"]=="goal" and not e["goalAccepted"])
                                       for e in observed),
                        "perMinute": [{"minute": minute, **counts([e for e in counted
                            if minute*60 <= e["key"] < (minute+1)*60])}
                            for minute in range(math.ceil(duration/60))]})
    return players


def duplicate_reference_box(box, previous):
    """Reject near-identical detections, not separate people in similar kits."""
    left, top, right, bottom = box
    width, height = right-left, bottom-top
    for other in previous:
        x1,y1,x2,y2 = other
        overlap = max(0,min(right,x2)-max(left,x1))*max(0,min(bottom,y2)-max(top,y1))
        union = width*height+(x2-x1)*(y2-y1)-overlap
        centers_close = (abs(left+right-x1-x2)/2 <= .05*min(width,x2-x1)
                         and abs(top+bottom-y1-y2)/2 <= .05*min(height,y2-y1))
        if union > 0 and overlap/union >= .9 and centers_close:
            return True
    return False


def analyze(source: Path, out: Path, duration: float, provider, progress, tracking=None, review_strategy="all", game_stats=False, select_photos=False,fast=False,discovery_concurrency=1,parallel_postprocessing=False):
    if tracking is None:
        from .action_first import analyze_actions
        return analyze_actions(source,out,duration,provider,progress,review_strategy=review_strategy,game_stats=game_stats,select_photos=select_photos,fast=fast,discovery_concurrency=discovery_concurrency,parallel_postprocessing=parallel_postprocessing)
    return analyze_gallery(source,out,duration,provider,progress,tracking=tracking)


def analyze_gallery(source: Path, out: Path, duration: float, provider, progress, tracking=None):
    started = time.monotonic()
    out.mkdir(parents=True, exist_ok=True)
    (out/"crops").mkdir(exist_ok=True)
    reference_times = sorted(set([min(22, duration*.4), min(24, duration*.6)]))
    if tracking is None:
        # Bootstrap with co-visible people. The progressive gallery below then
        # searches the entire video for additional people and reference views.
        reference_times = reference_times[:1]
    reference_frames = [frame(source, t, out/f"roster-{i}.jpg") for i, t in enumerate(reference_times)]
    progress("llm_roster", .03)
    reference_instruction = (
        "Inspect these consecutive reference frames of a football pitch. "
        "Number players left-to-right in the first frame, then add genuinely new players from the second."
        if tracking is not None else
        "Inspect this SINGLE reference frame of a football pitch. Use frame 0 only. "
        "List each visible player exactly once, left-to-right. Do not create multiple "
        "entries for different descriptions of the same person. Do not invent absent players."
    )
    roster = provider.call("gemini", reference_instruction+"""
Return JSON {"players":[{"description":"kit, readable jersey number and shoe colours",
"frame":0,"box":[left,top,right,bottom]}]}.
Boxes use 0–1000 normalized image coordinates around the FULL player.
Only players inside the pitch, not spectators. At most 24 distinct scene-local labels.
The application assigns Unknown1, Unknown2, etc. by array order; do not generate identifiers.
Do not merge people merely because their jerseys match. Use clothing and short-term movement,
NEVER faces, facial features, body shape, gait signatures or real names. A label is not verified identity.""", reference_frames)
    raw_catalog = roster.get("players") if isinstance(roster,dict) else None
    if not isinstance(raw_catalog, list) or not 1 <= len(raw_catalog) <= 24:
        raise JobFailure("ai_roster_invalid", "The reference player catalog could not be established.")
    catalog, cards, reference_boxes = [], [], []
    duplicates_removed = 0
    for i, p in enumerate(raw_catalog, 1):
        if not isinstance(p,dict) or not isinstance(p.get("description"), str) or len(p["description"]) > 1000:
            raise JobFailure("ai_roster_invalid", "AI player reference labels were inconsistent.")
        index = p.get("frame")
        if type(index) is not int or not 0 <= index < len(reference_frames):
            raise JobFailure("ai_roster_invalid", "An AI player reference frame was invalid.")
        box = p.get("box")
        if not isinstance(box, list) or len(box) != 4:
            raise JobFailure("ai_roster_invalid", "An AI player reference crop was invalid.")
        try:
            x1,y1,x2,y2 = [number(v,1000) for v in box]
            if x2 <= x1 or y2 <= y1:
                raise ValueError()
        except ValueError:
            raise JobFailure("ai_roster_invalid", "An AI player reference crop was invalid.") from None
        if tracking is None:
            if duplicate_reference_box(box,reference_boxes):
                duplicates_removed += 1
                continue
            reference_boxes.append(box)
        player_id = f"Unknown{len(catalog)+1}"
        if tracking:
            anchored = tracking.anchor(reference_times[index], box, player_id)
            if anchored and anchored != player_id:
                continue
        image = Image.open(io.BytesIO(reference_frames[index])).convert("RGB")
        w,h = image.size
        crop = image.crop((int(x1*w/1000),int(y1*h/1000),int(x2*w/1000),int(y2*h/1000)))
        if min(crop.size) < 3:
            raise JobFailure("ai_roster_invalid", "An AI player reference was too small.")
        crop.thumbnail((320,640))
        crop.save(out/"crops"/f"{len(catalog)+1}.jpg", quality=90)
        # Head region obscured in model reference cards; identity matching is kit-only.
        crop.paste((0,0,0),(0,0,crop.width,max(1,int(crop.height*.18))))
        card = io.BytesIO()
        crop.save(card,format="JPEG",quality=85)
        cards.append(card.getvalue())
        catalog.append({"id":player_id,"description":p["description"],"photoKey":None,
                        "referenceSeconds":reference_times[index]})
    gallery_audit = None
    if tracking is None:
        from .player_gallery import PlayerGallery
        gallery = PlayerGallery(source,out,catalog,cards,reference_boxes,reference_times[0],frame,command)
        gallery_audit = gallery.scan(duration,provider,progress)
    ids = {p["id"] for p in catalog}
    descriptions = json.dumps([{k:p[k] for k in ("id","description")} for p in catalog])
    events = []
    windows = math.ceil(duration/20)
    for n in range(windows):
        start = n*20
        owned_end = min(start+20,duration)
        progress("llm_events",(.36+.43*n/windows) if gallery_audit is not None else (.06+.73*n/windows))

        def window(begin, finish, context_end, suffix):
            video = out/"section.mp4"
            command(["-ss",str(begin),"-i",str(source),"-t",str(context_end-begin),"-an",
                     "-vf","scale='min(1280,iw)':-2",
                     "-c:v","libx264","-preset","veryfast","-crf","23","-threads","2",
                     "-movflags","+faststart",str(video)])
            prompt = f"""Analyze this football video segment, with ordered KIT-only reference cards.
Catalog: {descriptions}. Segment duration {context_end-begin:.3f}s.
Each reference card is ONE canonical player and may contain several views of that
same player. Multiple views are not different people or additional Unknown labels.
Return JSON {{"events":[{{"type":"pass|carry|shot|unclear_kick","actorId":"UnknownN or null",
"start":0.0,"end":1.0,"key":0.5,"outcome":"completed|incomplete|goal|on_target|off_target|unknown|not_applicable",
"identityConfidence":"high|medium|low|unassigned","eventConfidence":"high|medium|low",
"evidenceLevel":"direct|partial|inferred","evidence":"visible motion and ball evidence","uncertainty":"limitations"}}]}}.
Times are LOCAL elapsed clip seconds, not burned-in clock. start <= key <= end <= segment duration.
Pass = deliberate attempted delivery; completed requires visible teammate control.
Carry = one controlled movement episode >=1 second, not individual touches.
Shot = intentional goal attempt; goal is a shot outcome, not another action.
If kick intent is unclear use unclear_kick. Separate action from outcome.
Use actorId null if kit matching is ambiguous. Do not infer teammates from shirt colour alone.
Reuse the fixed catalog IDs; a later appearance is not a new player label.
If someone is absent from the reference catalog, leave actorId null instead of guessing.
Do NOT use faces, facial features, body shape, gait signatures or real names.
Do not reconstruct unseen history or force similar kits to match. No invented speeds or accuracy.
Prioritize directly visible actions. No events is valid for stoppage, but explain any uncertain action in its uncertainty field."""
            if tracking:
                annotated = out/"section-tracked.mp4"
                tracking.annotate(video, annotated, begin, context_end)
                video = annotated
                prompt += f"""
This video has yellow T-number overlays from a scene-local detector/tracker.
Also return actorTrackId (a visible T-number string or null) for EACH event at its key time.
Reference-backed bindings: {json.dumps(tracking.bindings)}.
Use these bindings only when the overlay follows the acting player continuously at the event.
Do not identify spectators or officials as players. A track alone does not prove an action or ball contact.
Unbound, obscured, conflicting or missing tracks MUST remain actorId null, identityConfidence unassigned.
Never invent a binding or infer identity across camera cuts."""
            try:
                answer = provider.call("gemini",prompt,cards,video.read_bytes())
            except WindowLimit as limit:
                logging.getLogger(__name__).warning(
                    "AI section limit provider=gemini code=%s start=%.3f end=%.3f",
                    limit.code, begin, finish)
                if finish-begin <= 2.5:
                    raise JobFailure(limit.code, "A short video section still exceeded the AI input/output limit.",
                                     retryable=False) from None
                middle = (begin+finish)/2
                return window(begin,middle,min(middle+2,duration),suffix+"a") + window(middle,finish,context_end,suffix+"b")
            try:
                proposals = validate_events(answer,context_end-begin,ids)
            except (ValueError,KeyError,TypeError):
                raise JobFailure("ai_invalid_events", "AI event timestamps or player labels were invalid.",retryable=True) from None
            result = []
            for j,e in enumerate(proposals):
                if begin+e["key"] >= finish:
                    continue
                item = {**e,"id":f"w{n+1}{suffix}-e{j+1}","window":f"w{n+1}{suffix}",
                    "start":round(begin+e["start"],3),"end":round(begin+e["end"],3),
                    "key":round(begin+e["key"],3),"review":None}
                if tracking:
                    tracking.reconcile(item)
                result.append(item)
            return result

        events.extend(window(start,owned_end,min(owned_end+2,duration),""))
    progress("llm_review", .8)
    candidates = sorted([e for e in events if e["type"] in {"shot","unclear_kick","pass"}],
                        key=lambda e:(0 if e["outcome"]=="goal" else 1 if e["type"]=="shot" else
                                      2 if e.get("tracking",{}).get("status") == "conflict" else
                                      2 if e["eventConfidence"]!="high" else 3,e["start"]))
    limit = min(24,max(6,math.ceil(duration/300)*2))
    selected = candidates[:limit]
    batch_size = max(1,min(3,(36-len(cards))//7))
    for offset in range(0,len(selected),batch_size):
        batch = selected[offset:offset+batch_size]
        images = list(cards)
        frames = []
        for e in batch:
            times = sorted(set(round(max(0,min(duration-.05,t)),3) for t in
                [e["start"]-.4,e["start"],e["key"]-.3,e["key"],e["key"]+.3,e["end"],e["end"]+.4]))
            for t in times:
                images.append(frame(source,t,out/"review.jpg"))
                frames.append({"case":e["id"],"sourceSeconds":t})
        framing = f"First {len(cards)} images are KIT reference cards, one canonical player per card; a card may contain several views of that SAME player: {descriptions}. Remaining frames in image order: {json.dumps(frames)}."
        blind = provider.call("astra",f"""{framing}
Look independently before seeing another model's claims. Return JSON {{"observations":[{{"caseId":"case",
"observation":"visible football action, outcome uncertainty and kit evidence","bestFrameSeconds":0.0}}]}}.
One observation for every case. Seek the clearest full-player reference frame and state its source time.
Do not use face recognition, facial features, body-shape or gait signatures, names or unseen trajectories.
Sparse frames may leave motion or outcome unresolved; absence of a sampled touch is not proof it never happened.""",images)
        observations = blind.get("observations",[])
        if (len(observations)!=len(batch) or
            {r.get("caseId") for r in observations}!={e["id"] for e in batch}):
            raise JobFailure("ai_review_invalid","Astra's independent review omitted an event.",retryable=True)
        challenge = provider.call("astra",f"""{framing}
Your blind observations: {json.dumps(blind)}.
Gemini claims: {json.dumps(batch)}.
Challenge action, identity and outcome SEPARATELY. Neutral/inconclusive is permitted.
Return JSON {{"reviews":[{{"caseId":"case","action":"supported|contradicted|inconclusive",
"identity":"supported|contradicted|inconclusive","outcome":"supported|contradicted|inconclusive",
"comment":"concrete visible evidence and source timestamps"}}]}}.
Exactly one review per case. Explicit contradiction requires contrary evidence, not mere missing frames.
Never use faces, facial features, body shape, gait signatures or real names.""",images)
        reviews = challenge.get("reviews",[])
        if (len(reviews)!=len(batch) or {r.get("caseId") for r in reviews}!={e["id"] for e in batch}
            or any(r.get(k) not in VERDICTS for r in reviews for k in ("action","identity","outcome"))
            or any(not isinstance(r.get("comment"),str) or len(r["comment"])>10000 for r in reviews)):
            raise JobFailure("ai_review_invalid","Astra returned an invalid review.",retryable=True)
        for e in batch:
            r = next(r for r in reviews if r["caseId"]==e["id"])
            e["review"] = {k:r[k] for k in ("action","identity","outcome","comment")}
            best = next(r for r in observations if r["caseId"]==e["id"]).get("bestFrameSeconds")
            if (isinstance(best,(int,float)) and not isinstance(best,bool) and math.isfinite(best)
                and any(f["case"]==e["id"] and abs(f["sourceSeconds"]-best)<.05 for f in frames)):
                e["review"]["bestFrameSeconds"] = best
        progress("llm_review",.8+.14*min(offset+batch_size,len(selected))/max(1,len(selected)))
    decisions(events)
    analysis = {"version":1,"durationSeconds":duration,"completedWindows":windows,"totalWindows":windows,
                "models":{"events":"gemini-3.8-flash","review":"gpt-6-astra"},"policy":POLICY,
                "catalog":catalog,"players":totals(events,catalog,duration),"events":events,
                "audit":{"reviewed":len(selected),"candidates":len(candidates),"limit":limit,
                         "catalogPolicy":"tracking-anchors" if tracking is not None else "full-video-gallery-v1",
                         "referenceFrames":len(reference_frames),
                         "duplicateReferencesRemoved":duplicates_removed}}
    if gallery_audit is not None:
        analysis["audit"]["gallery"] = gallery_audit
        analysis["audit"]["bootstrapReferenceFrames"] = len(reference_frames)
        analysis["audit"]["referenceFrames"] = len(gallery_audit["referenceTimestamps"])
    if tracking:
        analysis["tracking"] = tracking.summary(events)
        analysis["models"]["tracking"] = tracking.data["detector"] + "; " + tracking.data["tracker"]
    summary = {"pipeline":"llm-video-v1","models":analysis["models"],"settings":{"sampleFps":10,"windowSeconds":20},
               "pitch":{"length":0,"width":0,"playersPerSide":0},
               "provenance":{"passes":"inferred","carries":"inferred","shots":"inferred","goals":"inferred",
                             "speed":"not_available","distance":"not_available"},
               "quality":{"calibration":{},"detection":{"framesAnalysed":0,"meanPeoplePerFrame":0},
                          "tracking":{"tracks":0,"medianTrackSeconds":0,"meanCoverage":0,"tracksPerExpectedPerson":0},
                          "teams":{"a":0,"b":0,"other":len(catalog)},"teamShape":{"windows":0,"windowsWithBothTeams":0},
                          "camera":{"mode":"moving"},"processingSeconds":time.monotonic()-started},
               "teamShape":[],"durationSeconds":duration,"videoEvents":analysis}
    result = {"summary":summary,"tracks":[]}
    (out/"result.json").write_text(json.dumps(result,allow_nan=False))
    with gzip.open(out/"tracks.jsonl.gz","wt") as sink:
        for e in events:
            sink.write(json.dumps(e)+"\n")
    return result
