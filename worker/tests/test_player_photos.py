import io
from pathlib import Path
from unittest.mock import Mock
import pytest
from PIL import Image
from fa_worker.player_photos import select_player_photos
from fa_worker.errors import JobFailure


def proposal(**changes):
    return {"actorId":"Unknown1","seconds":5,"box":[100,100,400,900],
        "identityConfidence":"high","matchBasis":"distinctive_kit_and_shoes",
        "faceVisible":False,"faceClarity":"not_visible","frontFacing":False,
        "bodyComplete":True,"evidence":"Matching kit and shoes, complete body.",**changes}


def run(tmp_path, responses, duration=40):
    (tmp_path/"crops").mkdir(exist_ok=True)
    (tmp_path/"crops/1.jpg").write_bytes(b"old")
    raw=io.BytesIO();Image.new("RGB",(400,240),"green").save(raw,format="JPEG")
    provider=Mock()
    provider.call.side_effect=[{"photos":r} for r in responses]
    catalog=[{"id":"Unknown1","description":"Blue kit","photoKey":None}]
    audit=select_player_photos(Path("source"),tmp_path,duration,provider,Mock(),catalog,[b"masked-kit"],
        lambda *args:raw.getvalue(),lambda args:Path(args[-1]).write_bytes(b"video"))
    return audit,catalog,provider


def test_full_video_scan_prefers_clear_face_over_larger_back_view(tmp_path):
    audit,catalog,provider=run(tmp_path,[[proposal()],[proposal(box=[100,100,300,700],
        faceVisible=True,faceClarity="clear",frontFacing=True)]])
    assert audit["windows"]==2 and audit["playersWithPhoto"]==1
    assert catalog[0]["referenceSeconds"]==25
    assert catalog[0]["photoSelection"]["faceClarity"]=="clear"
    assert Image.open(tmp_path/"crops/1.jpg").size==(80,144)
    assert all("Do NOT compare faces" in c.args[1] for c in provider.call.call_args_list)


def test_partial_body_and_uncertain_identity_do_not_replace_missing_photo(tmp_path):
    audit,catalog,_=run(tmp_path,[[proposal(bodyComplete=False)],[proposal(identityConfidence="low")]])
    assert audit["playersWithPhoto"]==0
    assert not (tmp_path/"crops/1.jpg").exists()
    assert not catalog[0]["photoSelection"]["bodyComplete"]


def test_no_face_can_still_have_best_available_full_body_photo(tmp_path):
    _,catalog,_=run(tmp_path,[[proposal()]],20)
    assert catalog[0]["photoSelection"]["bodyComplete"]
    assert catalog[0]["photoSelection"]["faceClarity"]=="not_visible"


def test_photo_pass_cannot_invent_an_identity(tmp_path):
    with pytest.raises(JobFailure,match="Invalid photo reference"):
        run(tmp_path,[[proposal(actorId="Unknown99")]],20)


def test_collected_candidates_use_masked_images_not_another_video_pass(tmp_path):
    from fa_worker.player_photos import collect_candidates
    candidates=collect_candidates({"photoCandidates":[proposal()]},20,40,42)
    assert candidates[0]["seconds"]==25
    (tmp_path/"crops").mkdir()
    raw=io.BytesIO();Image.new("RGB",(400,240),"green").save(raw,format="JPEG")
    provider=Mock()
    provider.call.return_value={"photos":[{"candidateId":0,"actorId":"Unknown1",
        "identityConfidence":"high","matchBasis":"distinctive_kit_and_shoes","evidence":"Same number and shoes"}]}
    command=Mock()
    catalog=[{"id":"Unknown1","description":"Blue kit","photoKey":None}]
    audit=select_player_photos(Path("source"),tmp_path,40,provider,Mock(),catalog,[b"reference"],
        lambda *args:raw.getvalue(),command,candidates=candidates)
    command.assert_not_called()
    assert provider.call.call_args.kwargs["video"] is None
    masked=Image.open(io.BytesIO(provider.call.call_args.args[2][1]))
    assert max(masked.getpixel((5,5)))<10
    assert audit["playersWithPhoto"]==1
    assert catalog[0]["referenceSeconds"]==25


def test_candidate_collection_rejects_invalid_times_and_partial_body():
    from fa_worker.player_photos import collect_candidates
    assert collect_candidates({"photoCandidates":[proposal(bodyComplete=False)]},0,20,22)==[]
    with pytest.raises(ValueError):
        collect_candidates({"photoCandidates":[proposal(seconds=23)]},0,20,22)
