"""Progressive, non-biometric reference gallery covering the video's timeline.

Model associations remain estimates. Uncertain appearances do not create a new
Unknown, and identical kit colours are never sufficient evidence to merge.
"""
import io
import json
import math

from PIL import Image, ImageDraw, ImageOps, ImageFilter, ImageStat

from .errors import JobFailure
from .video_provider import WindowLimit

POLICY = "full-video-gallery-v1"
MAX_PLAYERS = 24


def reference_quality(picture):
    body = picture.crop((0,int(picture.height*.18),picture.width,picture.height)).convert("L")
    edges = body.filter(ImageFilter.FIND_EDGES)
    if min(edges.size)>4:
        edges = edges.crop((1,1,edges.width-1,edges.height-1))
    sharpness = ImageStat.Stat(edges).stddev[0]
    return math.log1p(picture.width*picture.height)*math.log1p(sharpness)


def box(value):
    if (not isinstance(value,list) or len(value) != 4 or
            any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v)
                or not 0 <= v <= 1000 for v in value) or
            value[0] >= value[2] or value[1] >= value[3]):
        raise ValueError("Invalid player box")
    return value


def overlap(a,b):
    intersection = max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    union = (a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection
    return intersection/union if union else 0


class PlayerGallery:
    def __init__(self,source,out,catalog,cards,seed_boxes,seed_seconds,frame,command):
        self.source,self.out,self.catalog,self.cards = source,out,catalog,cards
        self.frame,self.command = frame,command
        self.references = {}
        self.stats = {"policy":POLICY,"completedWindows":0,"totalWindows":0,
                      "matchedAppearances":0,"newPlayers":0,"unresolvedAppearances":0}
        self.unresolved = []
        for player,coords in zip(catalog,seed_boxes,strict=True):
            self.references[player["id"]] = [{
                "sourceSeconds":seed_seconds,"box":coords,
                "area":(coords[2]-coords[0])*(coords[3]-coords[1]),
                "photo":(out/"crops"/f"{len(self.references)+1}.jpg").read_bytes(),
            }]
            self.references[player["id"]][0]["quality"] = reference_quality(
                Image.open(io.BytesIO(self.references[player["id"]][0]["photo"])))

    def pending(self,seconds,reason):
        self.stats["unresolvedAppearances"] += 1
        if len(self.unresolved)<100:
            self.unresolved.append({"sourceSeconds":seconds,"reason":reason})

    def same_position(self,seconds,coords):
        matches = {actor for actor,refs in self.references.items() for r in refs
                   if abs(r["sourceSeconds"]-seconds)<.05 and overlap(coords,r["box"])>=.9}
        return next(iter(matches)) if len(matches)==1 else None

    def distinct(self,observation,seconds,coords,prior_ids):
        proofs = observation.get("separations",[])
        if not isinstance(proofs,list) or len(proofs)>MAX_PLAYERS:
            return False
        if any(not isinstance(p,dict) or not isinstance(p.get("actorId"),str) for p in proofs):
            return False
        by_id = {p.get("actorId"):p for p in proofs if isinstance(p,dict)}
        if len(by_id)!=len(proofs):
            return False
        for player in self.catalog:
            actor = player["id"]
            # Two genuinely separate co-visible boxes can establish distinctness
            # for new people added earlier in this same response.
            if actor not in prior_ids and any(
                    abs(r["sourceSeconds"]-seconds)<.05 and overlap(coords,r["box"])<.1
                    for r in self.references[actor]):
                continue
            proof = by_id.get(actor,{})
            if not isinstance(proof.get("evidence"),str) or not 10<=len(proof["evidence"])<=1500:
                return False
            basis = proof.get("basis")
            if basis == "co_visible_separate_player":
                try:
                    other = box(proof.get("box"))
                except ValueError:
                    return False
                if overlap(coords,other)>=.1:
                    return False
                known = self.same_position(seconds,other)
                if known is not None and known != actor:
                    return False
            elif basis == "different_readable_number":
                candidate,reference = observation.get("jerseyNumber"),proof.get("referenceNumber")
                if (not candidate or not reference or candidate==reference or
                        reference!=player.get("jerseyNumber")):
                    return False
            elif basis != "different_kit_and_shoes":
                return False
        return True

    def apply(self,data,begin,length):
        observations = data if isinstance(data,list) else data.get("observations") if isinstance(data,dict) else None
        if not isinstance(observations,list) or len(observations)>40:
            raise JobFailure("ai_gallery_invalid","The player-gallery response was invalid.",retryable=True)
        prior_ids = {p["id"] for p in self.catalog}
        parsed = []
        try:
            for item in observations:
                if not isinstance(item,dict):
                    raise ValueError()
                local = item.get("seconds")
                if (isinstance(local,bool) or not isinstance(local,(int,float)) or
                        not math.isfinite(local) or not 0<=local<=length):
                    raise ValueError()
                coords = box(item.get("box"))
                if item.get("decision") not in {"match","new","uncertain"}:
                    raise ValueError()
                if item.get("actorId") is not None and item["actorId"] not in prior_ids:
                    raise ValueError()
                description = item.get("description")
                if not isinstance(description,str) or not 1<=len(description)<=1000:
                    raise ValueError()
                number = item.get("jerseyNumber")
                if number is not None and (not isinstance(number,str) or not number.isascii()
                                           or not number.isdigit() or not 1<=len(number)<=3):
                    raise ValueError()
                parsed.append((item,round(min(begin+local,begin+length-.05),3),coords))
        except (ValueError,TypeError,KeyError):
            raise JobFailure("ai_gallery_invalid","Player-gallery timestamps, boxes or labels were invalid.",
                             retryable=True) from None
        resolved = {i:None for i in range(len(parsed))}
        for index,(item,seconds,coords) in enumerate(parsed):
            new_actor = False
            actor = self.same_position(seconds,coords)
            if actor is None:
                evidence = item.get("evidence")
                if (item.get("confidence")!="high" or item.get("visibility")!="clear" or
                        not isinstance(evidence,str) or not 10<=len(evidence)<=1500):
                    self.pending(seconds,"insufficient_identity_evidence")
                    continue
                if item["decision"] == "match":
                    actor = item.get("actorId")
                    alternatives = item.get("alternativesRuledOut")
                    if (not actor or item.get("matchBasis") not in
                            {"readable_number_and_kit","distinctive_kit_and_shoes","continuous_in_segment"}
                            or not isinstance(alternatives,list)
                            or any(not isinstance(a,str) for a in alternatives)
                            or len(set(alternatives))!=len(alternatives)
                            or set(alternatives)!=prior_ids-{actor}):
                        self.pending(seconds,"ambiguous_existing_player")
                        continue
                    if any(other.get("actorId")==actor and other.get("decision")=="match"
                           and abs(other_time-seconds)<.05 and overlap(coords,other_box)<.1
                           for other,other_time,other_box in parsed):
                        self.pending(seconds,"conflicting_co_visible_assignments")
                        continue
                    known_number = next(p.get("jerseyNumber") for p in self.catalog if p["id"]==actor)
                    if known_number and item.get("jerseyNumber") and known_number!=item["jerseyNumber"]:
                        self.pending(seconds,"contradictory_readable_number")
                        continue
                elif item["decision"] == "new":
                    if item.get("actorId") is not None:
                        self.pending(seconds,"new_claim_with_existing_id")
                        continue
                    if len(self.catalog)>=MAX_PLAYERS:
                        self.pending(seconds,"catalog_capacity")
                        continue
                    if not self.distinct(item,seconds,coords,prior_ids):
                        self.pending(seconds,"new_player_not_established")
                        continue
                    actor = f"Unknown{len(self.catalog)+1}"
                    self.catalog.append({"id":actor,"description":item["description"],
                                         "photoKey":None,"referenceSeconds":seconds})
                    self.references[actor] = []
                    self.cards.append(b"")
                    self.stats["newPlayers"] += 1
                    new_actor = True
                else:
                    self.pending(seconds,"uncertain_match")
                    continue
            if not self.add_reference(actor,seconds,coords):
                if new_actor:
                    self.catalog.pop()
                    self.cards.pop()
                    self.references.pop(actor)
                    self.stats["newPlayers"] -= 1
                self.pending(seconds,"incomplete_or_tiny_reference")
                continue
            if not new_actor:
                self.stats["matchedAppearances"] += 1
            if item.get("jerseyNumber"):
                player = next(p for p in self.catalog if p["id"]==actor)
                if not player.get("jerseyNumber"):
                    player["jerseyNumber"] = item["jerseyNumber"]
            resolved[index] = actor
        return resolved

    def add_reference(self,actor,seconds,coords):
        refs = self.references[actor]
        if any(abs(r["sourceSeconds"]-seconds)<.05 and overlap(coords,r["box"])>=.9 for r in refs):
            return True
        image = Image.open(io.BytesIO(self.frame(self.source,seconds,self.out/"gallery-frame.jpg"))).convert("RGB")
        w,h = image.size
        crop = image.crop(tuple(int(v*scale/1000) for v,scale in zip(coords,(w,h,w,h),strict=True)))
        if crop.width<6 or crop.height<12 or not .12<=crop.width/crop.height<=1.4:
            return False
        raw = io.BytesIO()
        crop.save(raw,format="JPEG",quality=90)
        refs.append({"sourceSeconds":seconds,"box":coords,
                     "area":(coords[2]-coords[0])*(coords[3]-coords[1]),
                     "quality":reference_quality(crop),"photo":raw.getvalue()})
        refs.sort(key=lambda r:(r["quality"],r["area"]),reverse=True)
        del refs[3:]
        index = next(i for i,p in enumerate(self.catalog) if p["id"]==actor)
        (self.out/"crops"/f"{index+1}.jpg").write_bytes(refs[0]["photo"])
        self.catalog[index]["referenceSeconds"] = refs[0]["sourceSeconds"]
        collage = Image.new("RGB",(240*len(refs),360),"#eeeeee")
        draw = ImageDraw.Draw(collage)
        for slot,r in enumerate(refs):
            picture = Image.open(io.BytesIO(r["photo"])).convert("RGB")
            picture.paste((0,0,0),(0,0,picture.width,max(1,int(picture.height*.18))))
            picture = ImageOps.contain(picture,(225,320))
            collage.paste(picture,(slot*240+(240-picture.width)//2,10))
            draw.text((slot*240+10,340),f"{actor} / {r['sourceSeconds']:.1f}s",fill="#16372b")
        encoded = io.BytesIO()
        collage.save(encoded,format="JPEG",quality=85)
        self.cards[index] = encoded.getvalue()
        return True

    def scan(self,duration,provider,progress):
        windows = math.ceil(duration/20)
        self.stats["totalWindows"] = windows
        def section(begin,end):
            video = self.out/"gallery-section.mp4"
            self.command(["-ss",str(begin),"-i",str(self.source),"-t",str(end-begin),"-an",
                          "-vf","scale='min(1280,iw)':-2","-c:v","libx264","-preset","veryfast",
                          "-crf","23","-threads","2","-movflags","+faststart",str(video)])
            descriptions = [{k:p.get(k) for k in ("id","description","jerseyNumber")} for p in self.catalog]
            prompt = f"""Extend a canonical KIT-only player gallery using this football video section.
Existing players, in reference-card order: {json.dumps(descriptions)}.
Each card may contain up to three views of ONE player. Review the WHOLE section for
new players and clearer reference frames, not just the beginning. Section length {end-begin:.3f}s.
Return JSON {{"observations":[{{"seconds":0.0,"box":[0,0,100,100],
"description":"kit, readable jersey number, shorts and shoes","decision":"match|new|uncertain",
"jerseyNumber":"clearly readable digits or null",
"actorId":"existing UnknownN or null","confidence":"high|medium|low","visibility":"clear|partial|occluded",
"matchBasis":"readable_number_and_kit|distinctive_kit_and_shoes|continuous_in_segment|uncertain",
"alternativesRuledOut":["existing IDs other than the matched ID"],
"evidence":"specific visible identity evidence, not just shared shirt colour",
"separations":[{{"actorId":"existing ID","basis":"co_visible_separate_player|different_kit_and_shoes|different_readable_number",
"referenceNumber":"known reference number or null","box":[0,0,100,100],
"evidence":"how this existing player is demonstrably different"}}]}}]}}.
seconds are LOCAL elapsed video seconds. Boxes are 0-1000 around the FULL player at that time.
Use match to REUSE an existing ID across appearances. Seek the clearest full-player view.
For a match explicitly rule out all competing gallery IDs; shirt colour alone is NOT enough.
Use new ONLY if demonstrably distinct from EVERY existing player. Provide a separation for
each existing ID: either a separate co-visible full-player box at the SAME seconds, a
different clearly readable number compared with an already KNOWN gallery number, or
a clear difference in BOTH kit and shoes. Unknown numbers or lack of a matching view is
NOT proof of novelty. Repeated appearances are not new people. Prefer one new-person
reference snapshot per section; do not propose the same new player repeatedly.
If distinction or a match cannot be established, use uncertain, not another Unknown.
Only pitch players. Never use faces, facial features, body-shape or gait signatures,
biometrics or names. Do not invent IDs, clothing details, shoe colours or unseen continuity.
At most 40 observations; [] is valid when no reliable additions are available."""
            try:
                answer = provider.call("gemini",prompt,self.cards,video.read_bytes())
            except WindowLimit:
                if end-begin<=2.5:
                    raise
                middle = (begin+end)/2
                section(begin,middle)
                section(middle,end)
                return
            self.apply(answer,begin,end-begin)
        for n in range(windows):
            progress("llm_roster",.04+.30*n/windows)
            section(n*20,min((n+1)*20,duration))
            self.stats["completedWindows"] += 1
        for player in self.catalog:
            player["references"] = [{k:r[k] for k in ("sourceSeconds","box")}
                                    for r in self.references[player["id"]]]
        times = sorted({r["sourceSeconds"] for refs in self.references.values() for r in refs})
        return {**self.stats,"scannedDurationSeconds":duration,
                "referenceImages":sum(len(refs) for refs in self.references.values()),
                "referenceTimestamps":times,"unresolvedReferences":self.unresolved}
