import io
import re
import pytest
from copy import deepcopy
from pathlib import Path
from threading import Barrier, RLock
from unittest.mock import Mock

from PIL import Image
from fa_worker.action_review import review_actions
from fa_worker.player_photos import select_player_photos
from .test_action_first import Provider, source
from fa_worker import action_first, player_photos
from fa_worker.errors import JobFailure


def test_parallel_review_preserves_blind_then_challenge_and_serial_results(tmp_path):
    events=[{"id":f"e{i}","type":"shot","outcome":"unknown","actorId":None,
             "eventConfidence":"high","evidenceLevel":"direct",
             "start":1,"key":1.5,"end":2} for i in range(6)]
    class Reviews:
        def __init__(self,parallel):
            self.barrier=Barrier(2) if parallel else None
            self.blind=set()
            self.lock=RLock()
        def call(self,provider,prompt,images):
            assert provider=="astra"
            ids=sorted(set(re.findall(r'"case": "(e\d+)"',prompt)))
            if "Look independently" in prompt:
                if self.barrier: self.barrier.wait(timeout=5)
                with self.lock: self.blind.update(ids)
                return {"observations":[{"caseId":i,"observation":"Visible kick"} for i in ids]}
            assert set(ids)<=self.blind
            return {"reviews":[{"caseId":i,"action":"supported","outcome":"inconclusive",
                "identity":"contradicted" if i=="e0" else "inconclusive","comment":"Evidence"} for i in ids]}
    copies=[]
    audits=[]
    paths=set()
    for concurrency in (1,2):
        current=deepcopy(events)
        audits.append(review_actions(Path("source"),tmp_path,10,Reviews(concurrency==2),Mock(),
            current,[],[],lambda source,seconds,path: paths.add(path) or b"frame",
            concurrency=concurrency))
        copies.append(current)
    assert copies[0]==copies[1] and audits[0]==audits[1]
    assert len(paths)==3  # One serial path + two isolated parallel batch paths.


def test_photo_batches_overlap_and_reduce_to_same_best_photo(tmp_path):
    raw=io.BytesIO()
    Image.new("RGB",(400,240),"green").save(raw,format="JPEG")
    candidates=[dict(seconds=i,box=[100,100,300,900],bodyComplete=True,
        faceVisible=i==18,faceClarity="clear" if i==18 else "not_visible",
        frontFacing=i==18) for i in range(19)]
    class Photos:
        def __init__(self,parallel):
            self.barrier=Barrier(2) if parallel else None
        def call(self,provider,prompt,images,video=None):
            if self.barrier: self.barrier.wait(timeout=5)
            ids=re.findall(r'"candidateId":\s*(\d+)',prompt.split("Return ")[0])
            return {"photos":[dict(actorId="Unknown1",candidateId=int(ids[-1]),
                identityConfidence="high",matchBasis="distinctive_kit_and_shoes",evidence="Matching kit")]}
    results=[]
    for concurrency in (1,2):
        out=tmp_path/str(concurrency)
        (out/"crops").mkdir(parents=True)
        catalog=[{"id":"Unknown1","description":"Blue kit","photoKey":None}]
        audit=select_player_photos(Path("source"),out,40,Photos(concurrency==2),Mock(),catalog,[],
            lambda *a:raw.getvalue(),Mock(),candidates=candidates,concurrency=concurrency)
        results.append((audit,catalog,(out/"crops/1.jpg").read_bytes()))
    assert results[0]==results[1]
    assert results[0][1][0]["referenceSeconds"]==18


def test_review_and_photos_overlap_without_mutating_shared_catalog(source,tmp_path,monkeypatch):
    barrier=Barrier(2)
    def review(src,out,duration,provider,progress,events,catalog,*args,**kwargs):
        barrier.wait(timeout=5)
        assert all("photoSelection" not in p for p in catalog)
        for event in events:
            event["review"]={"action":"supported","outcome":"supported","identity":"contradicted","comment":"Different kit"}
        return {"reviewed":len(events)}
    def photos(src,out,duration,provider,progress,catalog,*args,**kwargs):
        barrier.wait(timeout=5)
        for i,p in enumerate(catalog,1):
            p["photoSelection"]={"bodyComplete":True}
            (out/"crops"/f"{i}.jpg").write_bytes(b"test-photo")
        return {"version":1,"windows":1,"playersWithPhoto":len(catalog)}
    monkeypatch.setattr(action_first,"review_actions",review)
    monkeypatch.setattr(player_photos,"select_player_photos",photos)
    progress=Mock()
    result=action_first.analyze_actions(source,tmp_path/"output",3,Provider(),progress,
        select_photos=True,parallel_postprocessing=True)
    data=result["summary"]["videoEvents"]
    assert data["catalog"][0]["photoSelection"]["bodyComplete"]
    assert data["events"][0]["actorAssignment"]["status"]=="challenged"
    fractions=[c.args[1] for c in progress.call_args_list if c.args[0]=="llm_review_photos"]
    assert fractions==sorted(fractions)


def test_failed_photo_batch_does_not_publish_partial_photos_or_catalog(tmp_path):
    raw=io.BytesIO()
    Image.new("RGB",(400,240),"green").save(raw,format="JPEG")
    candidates=[dict(seconds=i,box=[100,100,300,900],bodyComplete=True,
        faceVisible=False,faceClarity="not_visible",frontFacing=False) for i in range(19)]
    class InvalidPhotos:
        def call(self,provider,prompt,images,video=None):
            if '"candidateId": 18' in prompt.split("Return ")[0]:
                return {"photos":[{"actorId":"not-a-player"}]}
            return {"photos":[]}
    catalog=[{"id":"Unknown1","description":"Blue kit","photoKey":None}]
    before=deepcopy(catalog)
    (tmp_path/"crops").mkdir()
    (tmp_path/"crops/1.jpg").write_bytes(b"previous")
    with pytest.raises(JobFailure):
        select_player_photos(Path("source"),tmp_path,40,InvalidPhotos(),Mock(),catalog,[],
            lambda *a:raw.getvalue(),Mock(),candidates=candidates,concurrency=2)
    assert catalog==before
    assert (tmp_path/"crops/1.jpg").read_bytes()==b"previous"
