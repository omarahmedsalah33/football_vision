from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock
import subprocess

import pytest

from fa_worker.video_events import decisions, totals, validate_events, analyze_gallery as analyze, duplicate_reference_box


def event(**changes):
    return {"id":"w1-e1","window":"w1","actorId":"Unknown1","type":"shot","start":1,"end":2,"key":1.5,
            "outcome":"goal","identityConfidence":"high","eventConfidence":"high","evidenceLevel":"direct",
            "evidence":"Visible kick towards goal","uncertainty":"","review":None,**changes}


def review(**changes):
    return {"action":"supported","identity":"supported","outcome":"inconclusive","comment":"Sampled view",
            **changes}


def test_neutral_reviewer_keeps_gemini_goal_and_player():
    events = decisions([event(review=review(action="inconclusive",identity="inconclusive"))])
    assert events[0]["included"] and events[0]["goalAccepted"]
    assert events[0]["review"]["outcome"] == "inconclusive"


def test_top_level_event_array_is_accepted_only_when_fully_valid():
    assert validate_events([event()],22,{"Unknown1"}) == [event()]
    for malformed in ([1],["event"],{},None):
        with pytest.raises(ValueError):
            validate_events(malformed,22,{"Unknown1"})


@pytest.mark.parametrize("box,duplicate", [
    ([100,100,400,900], True),
    ([101,102,401,902], True),
    ([200,100,500,900], False),
    ([500,100,800,900], False),
    ([150,200,350,800], False),
])
def test_only_near_identical_reference_boxes_are_duplicates(box,duplicate):
    assert duplicate_reference_box(box,[[100,100,400,900]]) is duplicate


def test_single_snapshot_dedup_keeps_separate_same_kit_players_and_consistent_ids(tmp_path):
    source = tmp_path/"source.mp4"
    subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i","color=c=green:s=320x180:r=10",
                    "-t","3","-c:v","libx264","-threads","1",str(source)],check=True)
    class Provider:
        def call(self,provider,prompt,images=(),video=None):
            if prompt.startswith("Inspect "):
                assert len(images) == 1
                return {"players":[
                    {"description":"Blue shirt","frame":0,"box":[100,100,400,900]},
                    {"description":"Same player described again","frame":0,"box":[101,102,401,902]},
                    {"description":"Blue shirt","frame":0,"box":[500,100,800,900]},
                ]}
            if prompt.startswith("Extend a canonical"):
                return {"observations":[]}
            if provider == "gemini":
                assert len(images) == 2
                assert "Unknown3" not in prompt
                assert "leave actorId null" in prompt
                return {"events":[event(actorId="Unknown2")]}
            if "Look independently" in prompt:
                return {"observations":[{"caseId":"w1-e1","observation":"Shot","bestFrameSeconds":1.5}]}
            return {"reviews":[{"caseId":"w1-e1",**review()}]}
    output = tmp_path/"output"
    data = analyze(source,output,3,Provider(),Mock())["summary"]["videoEvents"]
    assert [p["id"] for p in data["catalog"]] == ["Unknown1","Unknown2"]
    assert data["catalog"][0]["description"] == data["catalog"][1]["description"]
    assert data["audit"]["duplicateReferencesRemoved"] == 1
    assert data["players"][0]["goals"] == 0
    assert data["players"][1]["goals"] == 1
    assert data["events"][0]["actorId"] == "Unknown2"
    assert (output/"crops"/"1.jpg").exists() and (output/"crops"/"2.jpg").exists()
    assert not (output/"crops"/"3.jpg").exists()


def test_outcome_contradiction_blocks_goal_not_shot():
    events = decisions([event(review=review(outcome="contradicted"))])
    assert events[0]["included"] and not events[0]["goalAccepted"]


@pytest.mark.parametrize("field",["action","identity"])
def test_explicit_contradiction_stays_pending(field):
    events = decisions([event(review=review(**{field:"contradicted"}))])
    assert not events[0]["included"]
    assert events[0]["goalAccepted"] == (field=="identity")


def test_unassigned_and_uncertain_gemini_proposals_are_not_forced():
    events = decisions([event(actorId=None),event(identityConfidence="medium")])
    assert not any(e["included"] for e in events)
    assert all(e["matchIncluded"] and e["goalAccepted"] for e in events)


def test_cross_window_duplicate_only_counts_once():
    events = decisions([event(type="carry",outcome="not_applicable"),
                        event(id="w2-e1",window="w2",type="carry",outcome="not_applicable")])
    assert [e["included"] for e in events] == [True,False]


def test_fifty_minute_event_and_final_partial_minute_are_included():
    events = decisions([event(start=3050,end=3051,key=3050.5)])
    player = totals(events,[{"id":"Unknown1"}],3054.533)[0]
    assert len(player["perMinute"]) == 51
    assert player["perMinute"][50]["goals"] == 1
    assert player["goals"] == 1


@pytest.mark.parametrize("change",[{"key":99},{"actorId":"Unknown99"},{"key":float("nan")},
                                   {"type":"pass","outcome":"goal"},{"start":True}])
def test_invalid_model_output_is_rejected(change):
    with pytest.raises(ValueError):
        validate_events({"events":[event(**change)]},22,{"Unknown1"})


def test_decoding_catalog_and_report_contract_without_paid_inference(tmp_path):
    source = tmp_path/"source.mp4"
    subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i","color=c=green:s=320x180:r=10",
                    "-t","3","-c:v","libx264","-threads","1",str(source)],check=True)
    class Provider:
        def call(self,provider,prompt,images=(),video=None):
            if prompt.startswith("Inspect "):
                assert len(images) == 1
                assert "SINGLE reference" in prompt
                return {"players":[{"id":"model-label-is-not-authoritative","description":"Blue jersey, black shorts",
                                    "frame":0,"box":[100,100,400,900]}]}
            if prompt.startswith("Extend a canonical"):
                assert video
                return {"observations":[]}
            if provider=="gemini":
                return {"events":[event()]}
            if "Look independently" in prompt:
                return {"observations":[{"caseId":"w1-e1","observation":"Shot","bestFrameSeconds":1.5}]}
            return {"reviews":[{"caseId":"w1-e1",**review()}]}
    output = analyze(source,tmp_path/"output",3,Provider(),Mock())
    data = output["summary"]["videoEvents"]
    assert data["completedWindows"]==data["totalWindows"]==1
    assert data["audit"]["referenceFrames"] == 1
    assert data["audit"]["catalogPolicy"] == "full-video-gallery-v1"
    assert data["audit"]["gallery"]["completedWindows"] == 1
    assert data["players"][0]["goals"]==1
    assert data["events"][0]["review"]["outcome"]=="inconclusive"
    assert (tmp_path/"output"/"crops"/"1.jpg").exists()
    assert output["summary"]["provenance"]["speed"]=="not_available"


def test_player_found_later_in_video_receives_canonical_statistics(tmp_path):
    source = tmp_path/"source.mp4"
    subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i","color=c=green:s=320x180:r=10",
                    "-t","3","-c:v","libx264","-threads","1",str(source)],check=True)
    class Provider:
        def call(self,provider,prompt,images=(),video=None):
            if prompt.startswith("Inspect "):
                return {"players":[{"description":"Blue shirt, red shoes","frame":0,"box":[100,100,300,900]}]}
            if prompt.startswith("Extend a canonical"):
                return {"observations":[{
                    "seconds":.5,"box":[500,100,700,900],"description":"White shirt, yellow shoes",
                    "decision":"new","actorId":None,"confidence":"high","visibility":"clear",
                    "evidence":"Clearly separate co-visible player to the right.",
                    "separations":[{"actorId":"Unknown1","basis":"co_visible_separate_player",
                                    "box":[100,100,300,900],"evidence":"Blue player is separately visible on the left."}],
                }]}
            if provider=="gemini":
                assert len(images)==2 and "Unknown2" in prompt
                return {"events":[event(actorId="Unknown2")]}
            if "Look independently" in prompt:
                return {"observations":[{"caseId":"w1-e1","observation":"Shot","bestFrameSeconds":1.5}]}
            return {"reviews":[{"caseId":"w1-e1",**review()}]}
    output = tmp_path/"output"
    data = analyze(source,output,3,Provider(),Mock())["summary"]["videoEvents"]
    assert [p["id"] for p in data["catalog"]]==["Unknown1","Unknown2"]
    assert data["players"][1]["goals"]==1
    assert data["events"][0]["actorId"]=="Unknown2"
    assert data["audit"]["gallery"]["newPlayers"]==1
    assert data["audit"]["gallery"]["scannedDurationSeconds"]==3
    assert data["catalog"][1]["references"][0]["sourceSeconds"]==.5
    assert (output/"crops"/"2.jpg").exists()


def test_tracking_overlay_dedup_and_attribution_contract_without_paid_inference(tmp_path):
    from fa_worker.player_tracking import TrackingEvidence
    source = tmp_path/"synthetic.mp4"
    subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i","color=c=green:s=320x180:r=10",
                    "-t","3","-c:v","libx264","-threads","1",str(source)],check=True)
    tracking = TrackingEvidence({"version":"rfdetr-bytetrack-v1", "sampleFps":5,"scenes":1,"trackCount":1,
        "detector":"synthetic-not-real-inference","tracker":"synthetic-not-real-inference",
        "frames":[{"time":round(i/5,1),"scene":1,"people":[{"id":"T1","box":[100,100,400,900]}]} for i in range(15)]})
    class Provider:
        def call(self,provider,prompt,images=(),video=None):
            if "Inspect these consecutive" in prompt:
                return {"players":[{"description":"Synthetic kit","frame":0,"box":[100,100,400,900]},
                                   {"description":"Same synthetic reference later","frame":1,"box":[100,100,400,900]}]}
            if provider == "gemini":
                assert "actorTrackId" in prompt and '"T1": "Unknown1"' in prompt
                assert video
                return {"events":[event(actorTrackId="T1")]}
            if "Look independently" in prompt:
                return {"observations":[{"caseId":"w1-e1","observation":"Synthetic shot","bestFrameSeconds":1.5}]}
            return {"reviews":[{"caseId":"w1-e1",**review()}]}
    result = analyze(source,tmp_path/"output",3,Provider(),Mock(),tracking=tracking)
    data = result["summary"]["videoEvents"]
    assert len(data["catalog"]) == 1
    assert data["tracking"]["duplicateReferencesRemoved"] == 1
    assert data["tracking"]["supportedEvents"] == 1
    assert data["events"][0]["tracking"]["status"] == "supported"
    assert data["players"][0]["goals"] == 1
    assert result["summary"]["provenance"]["speed"] == "not_available"
    assert (tmp_path/"output"/"section-tracked.mp4").exists()
