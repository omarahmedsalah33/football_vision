"""Compare reference photos using same-frame boxes, never face recognition."""
import gzip
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path("generated-artifacts/tracking-comparison")


def roster(mode):
    found = []
    for path in (ROOT/mode/"checkpoints").glob("llm-*.json.gz"):
        result = json.loads(gzip.decompress(path.read_bytes())).get("result")
        if isinstance(result,dict) and "players" in result:
            found.append(result["players"])
    if len(found) != 1:
        raise RuntimeError("Expected exactly one reference list for each run.")
    return found[0]


def iou(a,b):
    overlap = max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    union = (a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-overlap
    return overlap/union if union else 0


def build():
    old,new = roster("baseline"),roster("single-frame")
    frames = [ROOT/mode/"roster-0.jpg" for mode in ("baseline","single-frame")]
    if hashlib.sha256(frames[0].read_bytes()).digest() != hashlib.sha256(frames[1].read_bytes()).digest():
        raise RuntimeError("Position matching requires the exact same reference frame.")
    if any(p["frame"] != 0 for p in new):
        raise RuntimeError("The updated roster must use a single reference frame.")
    for mode,items in (("baseline",old),("single-frame",new)):
        if len(list((ROOT/mode/"crops").glob("*.jpg"))) != len(items):
            raise RuntimeError("Reference numbering differs from the saved crop list.")
    matches,used = [],set()
    for index,p in enumerate(new,1):
        candidates = sorted([(iou(p["box"],q["box"]),j) for j,q in enumerate(old,1)
                             if q["frame"] == 0],reverse=True)
        score,j = candidates[0]
        margin = score-(candidates[1][0] if len(candidates)>1 else 0)
        confirmed = score >= .5 and margin >= .2 and j not in used
        previous = j if confirmed else None
        if confirmed:
            used.add(j)
        matches.append({"new":index,"previous":previous,"sameFrameBoxIoU":round(score,4)})
    pages = []
    background,ink,accent = "#ffffff","#16372b","#bde45a"
    def text(draw,xy,value,size=23,fill=ink):
        draw.text(xy,value,font=ImageFont.load_default(size=size),fill=fill)
    def page(title,subtitle):
        image = Image.new("RGB",(1240,1754),background)
        draw = ImageDraw.Draw(image)
        draw.rectangle((0,0,1240,12),fill=accent)
        text(draw,(60,50),title,32)
        text(draw,(60,105),subtitle,22)
        pages.append(image)
        return image,draw
    def photo(page,mode,index,box):
        with Image.open(ROOT/mode/"crops"/f"{index}.jpg") as source:
            width,height = box[2]-box[0],box[3]-box[1]
            fitted = ImageOps.contain(source.convert("RGB"),(width,height))
            page.paste(fitted,(box[0]+(width-fitted.width)//2,box[1]+(height-fitted.height)//2))
    for offset in range(0,len(matches),6):
        image,draw = page("New Unknowns compared with previous Unknowns",
                          f"Previous: {len(old)} reference labels  |  New: {len(new)} reference labels")
        text(draw,(60,145),"Pairs below use positions in the identical 00:22 reference image, not face recognition.",20)
        text(draw,(60,175),"The numbers can change between runs. Images are limited by the original video resolution.",20)
        for slot,match in enumerate(matches[offset:offset+6]):
            x,y = 60+(slot%2)*570,225+(slot//2)*475
            draw.rounded_rectangle((x,y,x+550,y+445),radius=12,outline="#c9d6cf",width=2)
            previous = match["previous"]
            heading = f"New Unknown{match['new']}  /  Previous Unknown{previous}" if previous else f"New Unknown{match['new']}  /  No clear match"
            text(draw,(x+18,y+17),heading,22)
            text(draw,(x+40,y+60),"PREVIOUS",18)
            text(draw,(x+315,y+60),"NEW",18)
            if previous:
                photo(image,"baseline",previous,(x+20,y+95,x+260,y+370))
                text(draw,(x+40,y+395),f"Unknown{previous}",23)
            else:
                text(draw,(x+30,y+180),"Uncertain",23)
            photo(image,"single-frame",match["new"],(x+285,y+95,x+525,y+370))
            text(draw,(x+315,y+395),f"Unknown{match['new']}",23)
        text(draw,(60,1695),"Same-frame reference correspondence only; not verified identity throughout the video.",19)
    extra = [(i,p) for i,p in enumerate(old,1) if p["frame"] != 0]
    for offset in range(0,len(extra),10):
        image,draw = page("Previous additional references - 00:24",
                          "These came from the old second frame, which the new roster does not use.")
        text(draw,(60,145),"They may repeat players above. No cross-frame identity matches or merges are claimed.",20)
        for slot,(index,p) in enumerate(extra[offset:offset+10]):
            x,y = 60+(slot%2)*570,210+(slot//2)*290
            draw.rounded_rectangle((x,y,x+550,y+270),radius=12,outline="#c9d6cf",width=2)
            photo(image,"baseline",index,(x+20,y+25,x+190,y+245))
            text(draw,(x+220,y+85),f"Previous Unknown{index}",25)
            text(draw,(x+220,y+130),"Old reference only",21)
    target = ROOT/"new-vs-previous-unknowns.pdf"
    pages[0].save(target,save_all=True,append_images=pages[1:],resolution=150)
    pages[0].save(ROOT/"new-vs-previous-unknowns-preview.jpg",quality=88)
    (ROOT/"new-vs-previous-unknowns-mapping.json").write_text(json.dumps(matches,indent=2))
    print(json.dumps({"pdf":str(target),"pages":len(pages),"previous":len(old),"new":len(new),
                      "sameFramePairs":sum(m["previous"] is not None for m in matches),
                      "mapping":matches},indent=2))


if __name__ == "__main__":
    build()
