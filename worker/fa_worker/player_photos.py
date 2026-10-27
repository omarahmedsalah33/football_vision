"""Best full-body reference per known player; face visibility ranks quality ONLY.

Identity decisions remain kit/number/context based. No facial matching, embeddings,
face reconstruction or new player identities are introduced by this pass.
"""
import io
import json
import math
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

from .errors import JobFailure
from .player_gallery import box, reference_quality
from .video_provider import WindowLimit


def collect_candidates(response,begin,finish,context_end):
    items=response.get("photoCandidates")
    if not isinstance(items,list) or len(items)>24:
        raise ValueError("Invalid photo candidates")
    output=[]
    for item in items:
        seconds=item["seconds"]
        if isinstance(seconds,bool) or not isinstance(seconds,(float,int)) or not math.isfinite(seconds) or not 0<=seconds<=context_end-begin:
            raise ValueError("Invalid photo time")
        box(item["box"])
        if any(not isinstance(item.get(k),bool) for k in ("faceVisible","frontFacing","bodyComplete")) or item.get("faceClarity") not in {"clear","partial","not_visible"}:
            raise ValueError("Invalid photo quality")
        if begin+seconds<finish and item["bodyComplete"]:
            output.append({**item,"seconds":begin+seconds})
    return output


def select_player_photos(source, out, duration, provider, progress, catalog, cards, frame, command,candidates=None,concurrency=1,_selection_sink=None):
    from .action_first import segment
    if not catalog:
        return {"version": 1, "windows": 0, "playersWithPhoto": 0}
    if concurrency not in (1,2):
        raise ValueError("Photo concurrency must be 1 or 2")
    if concurrency>1 and candidates is not None:
        size=max(1,min(18,36-len(cards)))
        candidates=[{**c,"candidateId":i} for i,c in enumerate(candidates)]
        groups=[candidates[i:i+size] for i in range(0,len(candidates),size)]
        def run(index):
            directory=out/"photo-batches"/str(index)
            (directory/"crops").mkdir(parents=True,exist_ok=True)
            selection={}
            audit=select_player_photos(source,directory,duration,provider,lambda *a:None,
                deepcopy(catalog),cards,frame,command,candidates=groups[index],_selection_sink=selection)
            return audit,selection
        best={}
        completed=0
        for start in range(0,len(groups),concurrency):
            with ThreadPoolExecutor(max_workers=concurrency) as pool:
                results=list(pool.map(run,range(start,min(start+concurrency,len(groups)))))
            # Ordered reduction preserves tie-breaking independently of completion order.
            for audit,selection in results:
                completed+=audit["windows"]
                for actor,photo in selection.items():
                    if actor not in best or photo["rank"]>best[actor]["rank"]:
                        best[actor]=photo
            progress("llm_photos",.94+.015*min(start+concurrency,len(groups))/max(1,len(groups)))
        _apply_selected(out,catalog,best)
        return {"version":1,"windows":completed,"playersWithPhoto":len(best)}
    ids = {p["id"] for p in catalog}
    best = {}
    windows = math.ceil(duration / 20)
    completed = 0
    descriptions = [{"id": p["id"], "description": p["description"]} for p in catalog]

    def scan(begin, end, batch=None):
        nonlocal completed
        clip = segment(source, out / "photo-section.mp4", begin, end, command) if batch is None else None
        images=list(cards)
        prompt = f"""Choose player CARD PHOTOS from ALL analyzed frames in this video section.
The first {len(cards)} images are head-masked KIT references for these existing labels: {json.dumps(descriptions)}.
Return JSON {{"photos":[{{"actorId":"existing Unknown ID","seconds":0.0,
"box":[0,0,1000,1000],"identityConfidence":"high",
"matchBasis":"readable_number_and_kit|distinctive_kit_and_shoes|direct_short_term_continuity",
"faceVisible":true,"faceClarity":"clear|partial|not_visible","frontFacing":true,
"bodyComplete":true,"evidence":"kit/context match and visible photo-quality details"}}]}}.
One best candidate per confidently matched player present in this section; [] is valid.
seconds are LOCAL, 0 <= seconds <= {end-begin:.3f}. Boxes are full-person LEFT,TOP,RIGHT,BOTTOM normalized 0–1000.
Look beyond ball actions and stoppages. Choose a COMPLETE full-body image including head and feet.
Among complete-body images, a clearly visible face is the HIGHEST photo-quality priority,
then a front-facing view, sharpness, size and lack of obstruction.
If no face is visible, return the best complete-body view and say not_visible.
Never mistake a shoe, cut-off torso, bystander or overlapping person for a full-body reference.
IMPORTANT: use ONLY kit, numbers, shoes and short-term video continuity to associate labels.
Do NOT compare faces, facial features, body shape or gait to identify people. Face visibility
is for photo quality only. Do not create labels or merge players. Shared shirt colour alone
is insufficient; omit an ambiguous candidate rather than attach the wrong person's photo."""
        if batch is not None:
            prompt=f"""Match photo candidates to EXISTING kit-reference labels only.
First {len(cards)} head-masked reference images correspond to {json.dumps(descriptions)}.
Remaining images are head-masked candidates in this order: {json.dumps(batch)}.
Return {{"photos":[{{"candidateId":0,"actorId":"Unknown1","identityConfidence":"high",
"matchBasis":"readable_number_and_kit|distinctive_kit_and_shoes",
"evidence":"specific matching kit, number and shoes"}}]}}.
Choose at most ONE best confidently matched full-body candidate per player in this batch,
using supplied faceClarity then frontFacing quality metadata. [] is valid.
Shared shirt colour alone is insufficient. Do NOT compare faces, body shape or gait.
Never create or merge identities. Omit ambiguous associations. Candidate IDs must come from this batch."""
            for candidate in batch:
                image=Image.open(io.BytesIO(frame(source,candidate["seconds"],out/"candidate-frame.jpg"))).convert("RGB")
                w,h=image.size
                crop=image.crop(tuple(int(v*s/1000) for v,s in zip(candidate["box"],(w,h,w,h),strict=True)))
                crop.paste((0,0,0),(0,0,crop.width,max(1,int(crop.height*.18))))
                crop.thumbnail((240,400))
                raw=io.BytesIO();crop.save(raw,format="JPEG",quality=85)
                images.append(raw.getvalue())
        try:
            answer = provider.call("gemini", prompt, images, video=clip)
        except WindowLimit:
            if batch is not None:
                if len(batch)<=1:
                    raise
                mid=len(batch)//2
                scan(begin,end,batch[:mid]);scan(begin,end,batch[mid:])
                return
            if end-begin <= 2:
                raise
            mid = (begin+end)/2
            scan(begin,mid); scan(mid,end)
            return
        items = answer.get("photos") if isinstance(answer,dict) else None
        if not isinstance(items,list) or len(items)>len(catalog):
            raise JobFailure("ai_photo_invalid", "Invalid player-photo selection.", retryable=True)
        seen = set()
        for item in items:
            try:
                if batch is not None:
                    candidate=next((c for c in batch if c["candidateId"]==item.get("candidateId")),None)
                    if candidate is None:
                        raise ValueError()
                    item={**item,**candidate}
                actor = item["actorId"]
                if actor not in ids or actor in seen:
                    raise ValueError()
                seen.add(actor)
                seconds = item["seconds"]
                if isinstance(seconds,bool) or not isinstance(seconds,(float,int)) or not math.isfinite(seconds) or not 0<=seconds<=end-begin:
                    raise ValueError()
                coords = box(item["box"])
                if any(not isinstance(item.get(k),bool) for k in ("faceVisible","frontFacing","bodyComplete")):
                    raise ValueError()
                clarity = item["faceClarity"]
                if clarity not in {"clear","partial","not_visible"}:
                    raise ValueError()
                if not isinstance(item.get("evidence"),str) or len(item["evidence"])>3000:
                    raise ValueError()
                if not item["bodyComplete"] or item.get("identityConfidence")!="high" or item.get("matchBasis") not in {
                    "readable_number_and_kit","distinctive_kit_and_shoes","direct_short_term_continuity"}:
                    continue
                absolute = min(duration-.001,begin+seconds)
                image = Image.open(io.BytesIO(frame(source,absolute,out/"photo-frame.jpg"))).convert("RGB")
                w,h=image.size
                crop=image.crop(tuple(int(v*s/1000) for v,s in zip(coords,(w,h,w,h),strict=True)))
                if crop.width<8 or crop.height<24 or not .12<=crop.width/crop.height<=1.4:
                    continue
                if not item["faceVisible"]:
                    clarity="not_visible"
                elif crop.height<70 and clarity=="clear":
                    clarity="partial"
                rank=({"not_visible":0,"partial":1,"clear":2}[clarity],
                      int(item["frontFacing"]),reference_quality(crop),crop.width*crop.height)
                if actor not in best or rank>best[actor]["rank"]:
                    raw=io.BytesIO();crop.save(raw,format="JPEG",quality=95)
                    best[actor]={"rank":rank,"photo":raw.getvalue(),"seconds":absolute,"box":coords,
                        "faceVisible":item["faceVisible"],"faceClarity":clarity,"bodyComplete":True,
                        "note":"Best eligible full-body candidate across analyzed sections; face visibility ranks photo quality, not identity. "+item["evidence"]}
            except (KeyError,TypeError,ValueError):
                raise JobFailure("ai_photo_invalid","Invalid photo reference or timestamp.",retryable=True) from None
        completed += 1

    if candidates is None:
        for n in range(windows):
            scan(n*20,min(duration,(n+1)*20))
            progress("llm_photos",.94+.015*(n+1)/windows)
    else:
        size=max(1,min(18,36-len(cards)))
        candidates=[{**c,"candidateId":c.get("candidateId",i)} for i,c in enumerate(candidates)]
        for offset in range(0,len(candidates),size):
            scan(0,duration,candidates[offset:offset+size])
            progress("llm_photos",.94+.015*min(offset+size,len(candidates))/len(candidates))
    if _selection_sink is not None:
        _selection_sink.update(best)
    _apply_selected(out,catalog,best)
    return {"version":1,"windows":completed,"playersWithPhoto":len(best)}


def _apply_selected(out,catalog,best):
    (out/"crops").mkdir(parents=True,exist_ok=True)
    for i,player in enumerate(catalog,1):
        selected=best.get(player["id"])
        path=out/"crops"/f"{i}.jpg"
        if selected:
            path.write_bytes(selected["photo"])
            player["referenceSeconds"]=selected["seconds"]
            player["photoSelection"]={"policyVersion":1,"sourceSeconds":selected["seconds"],
                **{k:selected[k] for k in ("faceVisible","faceClarity","bodyComplete","note")}}
        else:
            path.unlink(missing_ok=True)
            player["photoKey"]=None
            player["photoSelection"]={"policyVersion":1,"faceVisible":False,"faceClarity":"not_visible",
                "bodyComplete":False,"note":"No confidently associated complete-body candidate was found; photo omitted rather than showing another player."}
