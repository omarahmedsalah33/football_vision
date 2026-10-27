"""Ball actions first; targeted actors, canonical player IDs and one event ledger."""
import gzip
import hashlib
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .action_review import review_actions
from .errors import JobFailure
from .player_gallery import PlayerGallery, box, overlap
from .video_provider import WindowLimit

POLICY = "action-first-v1"


def segment(source,target,begin,end,command):
    command(["-ss",str(begin),"-i",str(source),"-t",str(end-begin),"-an",
             "-vf","scale='min(1280,iw)':-2","-c:v","libx264","-preset","veryfast",
             "-crf","23","-threads","2","-movflags","+faststart",str(target)])
    return target.read_bytes()


def mark_duplicates(events):
    """Strong same-contact evidence only; two unassigned actors are not equal."""
    for index,event in enumerate(events):
        if event.get("duplicateOf"):
            continue
        for prior in events[:index]:
            if (prior.get("duplicateOf") or prior["type"]!=event["type"]
                    or min(prior["end"],event["end"])<=max(prior["start"],event["start"])):
                continue
            same_actor = prior["actorId"] is not None and prior["actorId"]==event["actorId"]
            near_contact = round(abs(prior["key"]-event["key"]),3)<(.15 if prior["window"]==event["window"] else .4)
            a,b = prior.get("actorBox"),event.get("actorBox")
            same_position = a is not None and b is not None and overlap(a,b)>=.65
            if (event["type"]=="carry" and same_actor) or (near_contact and (same_position or same_actor)):
                event["duplicateOf"] = prior["id"]
                event["canonicalEventId"] = prior["id"]
                break
        event.setdefault("canonicalEventId",event["id"])
    return events


def actor_groups(events, fast=False):
    groups = []
    for event in sorted(events,key=lambda e:e["key"]):
        if not groups or len(groups[-1])>=(6 if fast else 3) or event["key"]-groups[-1][0]["key"]>(12 if fast else 6):
            groups.append([])
        groups[-1].append(event)
    return groups


def registry_fingerprint(gallery):
    digest = hashlib.sha256()
    digest.update(json.dumps(gallery.catalog,sort_keys=True).encode())
    for card in gallery.cards:
        digest.update(card)
    return digest.hexdigest()


def assign_actors(source,out,duration,provider,progress,events,gallery,command,fast=False):
    candidates = [e for e in events if not e.get("duplicateOf")]
    groups = actor_groups(candidates,fast)
    seen = {}

    def resolve(batch,padding=2):
        begin = max(0,batch[0]["key"]-padding)
        end = min(duration,batch[-1]["key"]+padding+1)
        clip = segment(source,out/"actor-context.mp4",begin,end,command)
        registry = [{k:p.get(k) for k in ("id","description","jerseyNumber")} for p in gallery.catalog]
        cases = [{"caseId":e["id"],"key":round(e["key"]-begin,3),"type":e["type"],
                  "actorBoxAtContact":e.get("actorBox"),"actionEvidence":e["evidence"]} for e in batch]
        signature = registry_fingerprint(gallery)
        prompt = f"""Identify the actor of EACH ball action in this short video.
Do not change the detected actions or outcomes; this pass is ONLY actor association.
Cases (times LOCAL to this clip): {json.dumps(cases)}.
Existing canonical players, in reference-card order: {json.dumps(registry)}.
Each card may contain multiple views of ONE player, not multiple identities.
Clip length {end-begin:.3f}s. Follow the actual ball touch before and after each case.
Choose a clear FULL-player reference of that SAME actor within 3 seconds of the case.
Return JSON {{"observations":[{{"caseId":"case","seconds":0.0,
"box":[100,100,200,500],"description":"kit, number, shorts and shoes","jerseyNumber":null,
"decision":"match|new|uncertain","actorId":null,"confidence":"high|medium|low",
"visibility":"clear|partial|occluded",
"matchBasis":"readable_number_and_kit|distinctive_kit_and_shoes|continuous_in_segment|uncertain",
"alternativesRuledOut":["all other existing IDs"],
"evidence":"specific visible evidence connecting this player to this ball action",
"separations":[{{"actorId":"existing ID","basis":"co_visible_separate_player|different_kit_and_shoes|different_readable_number",
"referenceNumber":null,"box":[100,100,200,500],"evidence":"positive evidence of a different person"}}]}}]}}.
Exactly ONE observation per case. seconds are LOCAL elapsed clip seconds.
Every box is [LEFT, TOP, RIGHT, BOTTOM], X then Y, on a 0-1000 scale. NOT Y/X order.
Boxes must contain the full player, not just feet, the ball, or a horizontal strip.
Match an existing ID only with distinguishing kit/number/shoe evidence or visible unbroken
continuity to a reference within this clip. Shared shirt colour is NOT enough, even if
only one matching player is currently in the registry. Explicitly rule out competing IDs.
For new: actorId null, provide positive separation from EVERY existing ID; distinguish
separate co-visible bodies at this exact time, different kit AND shoes, or a different
readable jersey number compared with an already known number. Missing views are not
novelty evidence. With an empty registry the first clearly visible actor may be new.
If the same actor appears in several cases, reuse its existing ID; do not invent new IDs.
If identity, actor continuity or distinction is uncertain, choose uncertain, not another Unknown.
Unreadable jerseyNumber and referenceNumber must be null; readable numbers are digit strings.
Do not use faces, facial features, body shape, gait signatures, biometrics or real names."""
        try:
            answer = provider.call("gemini",prompt,gallery.cards,clip)
        except WindowLimit as error:
            if len(batch)>1:
                middle = len(batch)//2
                resolve(batch[:middle],padding)
                resolve(batch[middle:],padding)
                return
            if padding>.6:
                resolve(batch,.6)
                return
            event = batch[0]
            event["actorAssignment"] = {"status":"unresolved","method":"targeted_video","reason":error.code}
            seen[event["id"]] = signature
            return
        observations = answer if isinstance(answer,list) else answer.get("observations") if isinstance(answer,dict) else None
        expected = {e["id"] for e in batch}
        if (not isinstance(observations,list) or len(observations)!=len(batch)
                or any(not isinstance(r,dict) or not isinstance(r.get("caseId"),str) for r in observations)
                or {r.get("caseId") for r in observations}!=expected):
            raise JobFailure("ai_actor_invalid","The actor check omitted or duplicated an action.",retryable=True)
        # Do not let a reference to an unrelated distant moment establish the actor.
        blocked = {}
        for index,raw in enumerate(observations):
            observation = raw.copy()
            observations[index] = observation
            event = next(e for e in batch if e["id"]==observation["caseId"])
            local = observation.get("seconds")
            if isinstance(local,(int,float)) and not isinstance(local,bool) and math.isfinite(local):
                if abs(begin+local-event["key"])>3:
                    observation["decision"] = "uncertain"
                    blocked[event["id"]] = "reference_not_near_action"
            if (observation.get("matchBasis")=="continuous_in_segment"
                    and isinstance(observation.get("actorId"),str) and observation["actorId"] in gallery.references):
                if not any(begin<=r["sourceSeconds"]<=end for r in gallery.references[observation["actorId"]]):
                    observation["decision"] = "uncertain"
                    blocked[event["id"]] = "continuity_not_established"
        usable = [r for r in observations if r["caseId"] not in blocked]
        indexed = gallery.apply({"observations":usable},begin,end-begin) if usable else {}
        resolved = {observation["caseId"]:indexed[index] for index,observation in enumerate(usable)}
        for observation in observations:
            event = next(e for e in batch if e["id"]==observation["caseId"])
            actor = resolved.get(event["id"])
            event["actorId"],event["identityConfidence"] = actor,"high" if actor else "unassigned"
            if event["id"] in blocked:
                event["actorAssignment"] = {"status":"unresolved","method":"targeted_video","reason":blocked[event["id"]]}
                seen[event["id"]] = signature
                continue
            event["actorAssignment"] = {
                "status":"assigned" if actor else "unresolved","method":"targeted_video",
                "evidence":observation.get("evidence",""),
                "referenceSeconds":round(begin+observation["seconds"],3),
                "referenceBox":observation["box"],"matchBasis":observation.get("matchBasis","uncertain"),
            }
            seen[event["id"]] = signature

    for index,batch in enumerate(groups):
        progress("llm_identity",.4+.30*index/max(1,len(groups)))
        resolve(batch)
    pending = [e for e in candidates if e["actorId"] is None and seen.get(e["id"])!=registry_fingerprint(gallery)]
    retry_groups = actor_groups(pending,fast)
    for index,batch in enumerate(retry_groups):
        progress("llm_identity",.73+.07*index/max(1,len(retry_groups)))
        resolve(batch)
    for player in gallery.catalog:
        player["references"] = [{k:r[k] for k in ("sourceSeconds","box")}
                                for r in gallery.references[player["id"]]]
    return {"targetedGroups":len(groups),"lateLinkGroups":len(retry_groups),
            "assignedActions":sum(e["actorId"] is not None for e in candidates),
            "unresolvedActions":sum(e["actorId"] is None for e in candidates),
            "referenceViews":sum(len(refs) for refs in gallery.references.values()),
            "unresolvedReferences":gallery.unresolved}


def analyze_actions(source:Path,out:Path,duration,provider,progress,review_strategy="all",game_stats=False,select_photos=False,fast=False,discovery_concurrency=1,parallel_postprocessing=False):
    from .video_events import command,frame,validate_events,decisions,totals,POLICY as COUNTING_POLICY
    started = time.monotonic()
    out.mkdir(parents=True,exist_ok=True)
    (out/"crops").mkdir(exist_ok=True)
    events = []
    photo_candidates = []
    photo_sections = {}
    if discovery_concurrency not in range(1,11):
        raise ValueError("Discovery concurrency must be between 1 and 10")
    photo_prompt = """
Also return a top-level "photoCandidates" array (up to 24): one best complete-body
view per visually distinct on-pitch player seen across this section, INCLUDING stoppages.
Each candidate: {"seconds":0.0,"box":[100,100,200,900],"faceVisible":true,
"faceClarity":"clear|partial|not_visible","frontFacing":true,"bodyComplete":true}.
Use LOCAL seconds and normalized XY boxes. Among full-body views prioritize face clarity,
then front-facing view and sharpness. [] is valid. Do NOT identify anyone by their face;
face visibility is solely a photo-quality measure. Do not invent labels or crop only heads.
""" if fast and select_photos else ""
    windows = math.ceil(duration/20)
    extended = """Also detect take_on, tackle, interception, recovery and duel:
take_on = an explicit attempt to beat an opponent while controlling the ball (won/lost/unknown);
tackle = a direct attempt to dispossess a ball-controlling opponent (won/lost/unknown);
interception = cutting out an opponent delivery, with visible control for won;
recovery = controlling a loose ball without a direct opponent challenge;
duel = a contested possession episode not already represented by a tackle or take_on.
Use one event per continuous episode, NOT each contact. Never label the SAME actor's
same contest as both duel and tackle/take_on. A carry is not automatically a take_on.
Do not invent successful outcomes from proximity. Omit inferred/off-screen contests.
Do not estimate speed, strength, fitness or stamina; downstream GAME ratings are proxies.
""" if game_stats else ""
    event_types = "pass|carry|shot|unclear_kick" + ("|take_on|tackle|interception|recovery|duel" if game_stats else "")

    def discover(begin,finish,context_end,label):
        clip_path = out/f"action-section-{label}.mp4"
        clip = segment(source,clip_path,begin,context_end,command)
        clip_path.unlink(missing_ok=True)
        try:
            response = provider.call("gemini",f"""Detect BALL ACTIONS in this football video, not player identities.
Find passes, controlled carries and intentional shots throughout the section.
{extended}
{photo_prompt}
Return JSON {{"events":[{{"type":"{event_types}","actorId":null,
"identityConfidence":"unassigned","actorBox":[100,100,200,500],
"start":0.0,"end":1.0,"key":0.5,"outcome":"completed|incomplete|goal|on_target|off_target|unknown|not_applicable{('|won|lost' if game_stats else '')}",
"eventConfidence":"high|medium|low","evidenceLevel":"direct|partial|inferred",
"evidence":"visible ball contact and subsequent ball movement","uncertainty":"limits"}}]}}.
Times are LOCAL elapsed seconds; 0 <= start <= key <= end <= {context_end-begin:.3f}.
actorBox is the FULL acting player's box at key, [LEFT,TOP,RIGHT,BOTTOM] X/Y order
normalized 0-1000, or null if the actor is obscured. Never invent an Unknown ID.
Pass = one deliberate attempted delivery; completion needs visible teammate control.
Carry = one controlled movement episode >=1 second, not each touch.
Shot = intentional goal attempt. Goal is its outcome, not a second event.
Use unclear_kick if intent is uncertain. Separate visible action from outcome.
Do not infer a goal from celebration or a player's reaction. [] is valid during stoppages.
Do not infer teams from shirt colour alone. Never use facial features, body shape, gait,
biometrics or names, and do not invent speed or accuracy.""",video=clip)
        except WindowLimit as error:
            if finish-begin<=2.5:
                raise JobFailure(error.code,"A short action section still exceeded the AI limit.") from None
            middle = (begin+finish)/2
            return discover(begin,middle,min(middle+2,duration),label+"a")+discover(middle,finish,context_end,label+"b")
        try:
            if fast and select_photos:
                from .player_photos import collect_candidates
                photo_sections[label] = collect_candidates(response,begin,finish,context_end)
            proposals = validate_events(response,context_end-begin,set())
            for proposal in proposals:
                if proposal.get("actorBox") is not None:
                    box(proposal["actorBox"])
        except (ValueError,KeyError,TypeError):
            raise JobFailure("ai_invalid_events","AI action times or actor locations were invalid.",retryable=True) from None
        result = []
        for index,proposal in enumerate(proposals):
            if begin+proposal["key"]>=finish:
                continue
            result.append({**proposal,"actorId":None,"identityConfidence":"unassigned",
                           "id":f"{label}-e{index+1}","window":label,"review":None,
                           **{k:round(begin+proposal[k],3) for k in ("start","end","key")}})
        return result

    def section(n):
        return discover(n*20,min((n+1)*20,duration),min((n+1)*20+2,duration),f"w{n+1}")
    # Each batch finishes before another starts; a failed batch cannot queue a
    # whole match of extra paid requests. Identity/gallery mutation stays serial.
    for start in range(0,windows,discovery_concurrency):
        progress("llm_events",.04+.34*start/windows)
        indices=range(start,min(windows,start+discovery_concurrency))
        if discovery_concurrency==1:
            batches=[section(start)]
        else:
            with ThreadPoolExecutor(max_workers=discovery_concurrency) as pool:
                batches=list(pool.map(section,indices))
        for batch in batches:
            events.extend(batch)
    photo_candidates = sorted((c for section_candidates in photo_sections.values() for c in section_candidates),
                              key=lambda c:(c["seconds"],tuple(c["box"])))
    mark_duplicates(events)
    catalog,cards = [],[]
    gallery = PlayerGallery(source,out,catalog,cards,[],0,frame,command)
    identities = assign_actors(source,out,duration,provider,progress,events,gallery,command,fast=fast)
    mark_duplicates(events)
    photo_audit=None
    if parallel_postprocessing:
        from copy import deepcopy
        from threading import RLock, BoundedSemaphore
        import shutil
        from .player_photos import select_player_photos
        lock=RLock()
        decoders=BoundedSemaphore(2)
        def prepared_frame(*args,**kwargs):
            with decoders:
                return frame(*args,**kwargs)
        fractions=[0.,0.]
        def report(index,fraction):
            with lock:
                fractions[index]=max(fractions[index],min(1.,max(0.,fraction)))
                progress("llm_review_photos",.82+.135*sum(fractions)/2)
        photo_catalog=deepcopy(catalog)
        photo_out=out/"post-photos"
        (photo_out/"crops").mkdir(parents=True,exist_ok=True)
        def review_task():
            result=review_actions(source,out,duration,provider,
                lambda stage,f:report(0,(f-.82)/.12),events,catalog,cards,prepared_frame,
                strategy=review_strategy,concurrency=2)
            report(0,1)
            return result
        def photo_task():
            result=None
            if select_photos:
                result=select_player_photos(source,photo_out,duration,provider,
                    lambda stage,f:report(1,(f-.94)/.015),photo_catalog,cards,prepared_frame,command,
                    candidates=photo_candidates if fast else None,concurrency=2)
            report(1,1)
            return result
        report(0,0)
        with ThreadPoolExecutor(max_workers=2) as pool:
            review_future=pool.submit(review_task)
            photo_future=pool.submit(photo_task)
            review,photo_audit=review_future.result(),photo_future.result()
        if select_photos:
            for index,(player,photo) in enumerate(zip(catalog,photo_catalog,strict=True),1):
                assert player["id"]==photo["id"]
                for key in ("photoSelection","referenceSeconds","photoKey"):
                    if key in photo:
                        player[key]=photo[key]
                target=out/"crops"/f"{index}.jpg"
                source_photo=photo_out/"crops"/f"{index}.jpg"
                if source_photo.exists():
                    shutil.copyfile(source_photo,target)
                else:
                    target.unlink(missing_ok=True)
    else:
        progress("llm_review",.82)
        review = review_actions(source,out,duration,provider,progress,events,catalog,cards,frame,strategy=review_strategy)
    decisions(events)
    for event in events:
        if event.get("actorAssignment") and event.get("review") and event["review"]["identity"]=="contradicted":
            event["actorAssignment"]["status"] = "challenged"
    audit = {**review,"catalogPolicy":POLICY,"actionFirst":True,"catalogScope":"actors_of_detected_actions","identity":identities,
             "duplicateProposals":sum(bool(e.get("duplicateOf")) for e in events)}
    if game_stats:
        audit["gameStatsVersion"] = 1
    if select_photos and not parallel_postprocessing:
        from .player_photos import select_player_photos
        progress("llm_photos",.94)
        audit["photoSelection"] = select_player_photos(source,out,duration,provider,progress,catalog,cards,frame,command,
            candidates=photo_candidates if fast else None)
    elif photo_audit is not None:
        audit["photoSelection"]=photo_audit
    if fast:
        audit["optimizationVersion"] = 1
    if discovery_concurrency>1:
        audit["discoveryConcurrency"] = discovery_concurrency
    # Keep the wire contract backward compatible with already-published websites.
    analysis = {"version":1,"durationSeconds":duration,"completedWindows":windows,"totalWindows":windows,
                "models":{"events":"gemini-3.8-flash","review":"gpt-6-astra"},
                "policy":COUNTING_POLICY,"catalog":catalog,"players":totals(events,catalog,duration),
                "events":events,"audit":audit}
    summary = {"pipeline":POLICY,"models":analysis["models"],"settings":{"sampleFps":10,"windowSeconds":20},
               "pitch":{"length":0,"width":0,"playersPerSide":0},
               "provenance":{**{k:"inferred" for k in ("passes","carries","shots","goals")},
                             "speed":"not_available","distance":"not_available"},
               "quality":{"calibration":{},"detection":{"framesAnalysed":0,"meanPeoplePerFrame":0},
                          "tracking":{"tracks":0,"medianTrackSeconds":0,"meanCoverage":0,"tracksPerExpectedPerson":0},
                          "teams":{"a":0,"b":0,"other":len(catalog)},
                          "teamShape":{"windows":0,"windowsWithBothTeams":0},
                          "camera":{"mode":"moving"},"processingSeconds":time.monotonic()-started},
               "teamShape":[],"durationSeconds":duration,"videoEvents":analysis}
    result = {"summary":summary,"tracks":[]}
    (out/"result.json").write_text(json.dumps(result,allow_nan=False))
    with gzip.open(out/"tracks.jsonl.gz","wt") as sink:
        for event in events:
            sink.write(json.dumps(event)+"\n")
    return result
