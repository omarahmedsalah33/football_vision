"""Blind-first Astra checks for every canonical action, independent of identity."""
import json
import math
from concurrent.futures import ThreadPoolExecutor
from threading import RLock

from .errors import JobFailure

VERDICTS = {"supported","contradicted","inconclusive"}


def select_for_review(events,strategy):
    candidates = [e for e in events if not e.get("duplicateOf")]
    if strategy=="all":
        return candidates
    if strategy not in {"selective","focused"}:
        raise ValueError("Unsupported action review strategy")
    types = {"shot"} if strategy=="focused" else {"shot","take_on","tackle","interception","recovery","duel"}
    important = [e for e in candidates if e["type"] in types
                 or e["eventConfidence"]!="high" or e["evidenceLevel"]!="direct"
                 or e.get("actorAssignment",{}).get("reason") in {
                     "reference_not_near_action","continuity_not_established"}]
    return sorted(important,key=lambda e:(
        e["outcome"]=="goal", e["type"]=="shot", e["actorId"] is None,
    ),reverse=True)[:12]


def review_actions(source,out,duration,provider,progress,events,catalog,cards,frame,strategy="all",concurrency=1):
    if concurrency not in (1,2):
        raise ValueError("Review concurrency must be 1 or 2")
    selected = select_for_review(events,strategy)
    descriptions = json.dumps([{k:p[k] for k in ("id","description")} for p in catalog])
    batch_size = max(1,min(3,(36-len(cards))//7))
    if concurrency>1 and selected:
        groups=[selected[i:i+batch_size] for i in range(0,len(selected),batch_size)]
        lock=RLock()
        done=0
        def run(index):
            nonlocal done
            directory=out/"review-batches"/str(index)
            directory.mkdir(parents=True,exist_ok=True)
            # Each disjoint group retains blind -> challenge ordering.
            review_actions(source,directory,duration,provider,lambda *a:None,
                           groups[index],catalog,cards,frame,strategy=strategy)
            with lock:
                done+=len(groups[index])
                progress("llm_review",.82+.12*done/len(selected))
        for start in range(0,len(groups),concurrency):
            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                list(pool.map(run,range(start,min(start+concurrency,len(groups)))))
        return {"reviewed":len(selected),"candidates":sum(not e.get("duplicateOf") for e in events),
                "limit":12 if strategy!="all" else len(selected),
                "reviewAllCanonicalActions":strategy=="all","reviewStrategy":strategy}
    for offset in range(0,len(selected),batch_size):
        batch = selected[offset:offset+batch_size]
        images,frames = list(cards),[]
        for event in batch:
            times = sorted(set(round(max(0,min(duration-.05,t)),3) for t in [
                event["start"]-.4,event["start"],event["key"]-.3,event["key"],
                event["key"]+.3,event["end"],event["end"]+.4]))
            for seconds in times:
                images.append(frame(source,seconds,out/"action-review.jpg"))
                frames.append({"case":event["id"],"sourceSeconds":seconds})
        framing = (f"First {len(cards)} images are kit references: {descriptions}. "
                   "ONE canonical player per card, possibly several views of that same player. "
                   f"Remaining frames in image order: {json.dumps(frames)}.")
        blind = provider.call("astra",framing+"""
Look independently before seeing another model's claims.
Return JSON {"observations":[{"caseId":"case","observation":"visible action and identity limitations",
"bestFrameSeconds":0.0}]}. One entry per case. State the clearest source time.
Do not use faces, facial features, body shape, gait signatures, biometrics or names.
Missing sampled contact is not proof that an action never happened.""",images)
        observations = blind.get("observations") if isinstance(blind,dict) else None
        expected = {e["id"] for e in batch}
        if (not isinstance(observations,list) or len(observations)!=len(batch)
                or any(not isinstance(r,dict) or not isinstance(r.get("caseId"),str) for r in observations)
                or {r.get("caseId") for r in observations}!=expected):
            raise JobFailure("ai_review_invalid","Astra's independent review omitted an action.",retryable=True)
        challenge = provider.call("astra",framing+f"""
Your independent observations: {json.dumps(blind)}.
Gemini action claims and targeted actor assignments: {json.dumps(batch)}.
Challenge ACTION, OUTCOME and IDENTITY separately, including any conflicting actor evidence.
Return JSON {{"reviews":[{{"caseId":"case","action":"supported|contradicted|inconclusive",
"identity":"supported|contradicted|inconclusive","outcome":"supported|contradicted|inconclusive",
"comment":"specific visible evidence, limitations and source timestamps"}}]}}.
One review per case. Neutral/inconclusive is allowed. An unassigned actor must not
invalidate a visible match action. Explicit contradiction needs contrary evidence,
not missing frames. Do not use faces, body-shape, gait, biometrics or real names.""",images)
        reviews = challenge.get("reviews") if isinstance(challenge,dict) else None
        if (not isinstance(reviews,list) or len(reviews)!=len(batch)
                or any(not isinstance(r,dict) or not isinstance(r.get("caseId"),str) for r in reviews)
                or {r.get("caseId") for r in reviews}!=expected
                or any(r.get(k) not in VERDICTS for r in reviews for k in ("action","identity","outcome"))
                or any(not isinstance(r.get("comment"),str) or len(r["comment"])>10000 for r in reviews)):
            raise JobFailure("ai_review_invalid","Astra returned an invalid action review.",retryable=True)
        for event in batch:
            review = next(r for r in reviews if r["caseId"]==event["id"])
            event["review"] = {k:review[k] for k in ("action","identity","outcome","comment")}
            best = next(r for r in observations if r["caseId"]==event["id"]).get("bestFrameSeconds")
            if (isinstance(best,(int,float)) and not isinstance(best,bool) and math.isfinite(best)
                    and any(f["case"]==event["id"] and abs(f["sourceSeconds"]-best)<.05 for f in frames)):
                event["review"]["bestFrameSeconds"] = best
        progress("llm_review",.82+.12*min(offset+batch_size,len(selected))/max(1,len(selected)))
    return {"reviewed":len(selected),"candidates":sum(not e.get("duplicateOf") for e in events),
            "limit":12 if strategy!="all" else len(selected),
            "reviewAllCanonicalActions":strategy=="all","reviewStrategy":strategy}
