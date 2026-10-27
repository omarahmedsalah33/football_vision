import io
import json
import re
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock

import pytest
from PIL import Image

from fa_worker.action_first import mark_duplicates
from fa_worker.action_review import select_for_review
from fa_worker.errors import JobFailure
from fa_worker.video_events import analyze,decisions,totals
from fa_worker.video_provider import WindowLimit


def action(**changes):
    return {"type":"shot","outcome":"goal","start":1,"end":2,"key":1.5,
            "actorId":None,"identityConfidence":"unassigned","actorBox":[100,100,300,900],
            "eventConfidence":"high","evidenceLevel":"direct","evidence":"Visible kick towards goal.",
            "uncertainty":"","id":"w1-e1","window":"w1","review":None,**changes}


@pytest.fixture
def source(tmp_path,monkeypatch):
    from fa_worker import video_events
    raw = io.BytesIO()
    Image.new("RGB",(400,240),"green").save(raw,format="JPEG")
    monkeypatch.setattr(video_events,"frame",lambda *args:raw.getvalue())
    monkeypatch.setattr(video_events,"command",lambda args:Path(args[-1]).write_bytes(b"video"))
    return tmp_path/"source.mp4"


class Provider:
    def __init__(self,actions=None,uncertain=False,review=None,bad_crop=False):
        self.actions = actions or [action()]
        self.uncertain,self.bad_crop = uncertain,bad_crop
        self.review = {"action":"supported","identity":"supported","outcome":"inconclusive",**(review or {})}
        self.calls = []
    def call(self,provider,prompt,images=(),video=None):
        self.calls.append((provider,prompt))
        if prompt.startswith("Detect BALL ACTIONS"):
            assert not images and video
            return {"events":deepcopy(self.actions)}
        if prompt.startswith("Identify the actor"):
            assert video
            cases = json.loads(prompt.split("Cases (times LOCAL to this clip): ")[1].splitlines()[0].rstrip("."))
            registry = json.loads(prompt.split("Existing canonical players, in reference-card order: ")[1].splitlines()[0].rstrip("."))
            return {"observations":[{
                "caseId":case["caseId"],"seconds":case["key"],
                "box":[100,400,900,500] if self.bad_crop else [100,100,300,900],
                "description":"Blue jersey 17, red shoes","jerseyNumber":"17",
                "decision":"uncertain" if self.uncertain else "match" if registry else "new",
                "actorId":None if self.uncertain or not registry else "Unknown1",
                "confidence":"high","visibility":"clear","matchBasis":"distinctive_kit_and_shoes",
                "alternativesRuledOut":[],"evidence":"Same distinctive red shoes and readable shirt number.",
                "separations":[],
            } for case in cases]}
        ids = list(dict.fromkeys(re.findall(r'"case": "(w\d+[ab]*-e\d+)"',prompt)))
        assert provider=="astra" and ids
        if "Look independently" in prompt:
            return {"observations":[{"caseId":case,"observation":"Visible kick","bestFrameSeconds":1.5} for case in ids]}
        return {"reviews":[{"caseId":case,**self.review,"comment":"Timestamped visible action; outcome not established."} for case in ids]}


def test_actions_before_identity_no_global_roster_pass(source,tmp_path):
    provider = Provider()
    stages = Mock()
    output = analyze(source,tmp_path/"out",3,provider,stages)
    assert provider.calls[0][1].startswith("Detect BALL ACTIONS")
    assert provider.calls[1][1].startswith("Identify the actor")
    assert not any(prompt.startswith(("Inspect","Extend a canonical")) for _,prompt in provider.calls)
    data = output["summary"]["videoEvents"]
    assert output["summary"]["pipeline"]=="action-first-v1"
    assert len(data["catalog"])==1
    assert data["players"][0]["goals"]==1
    assert data["events"][0]["actorAssignment"]["status"]=="assigned"
    assert data["events"][0]["canonicalEventId"]=="w1-e1"
    assert data["audit"]["reviewAllCanonicalActions"] is True
    assert data["audit"]["reviewed"]==1
    assert any(call.args[0]=="llm_identity" for call in stages.call_args_list)
    assert (tmp_path/"out"/"crops"/"1.jpg").exists()
    assert (tmp_path/"out"/"tracks.jsonl.gz").exists()


def test_all_video_sections_are_scanned_before_actor_queries(source,tmp_path):
    provider = Provider()
    output = analyze(source,tmp_path/"out",45,provider,Mock())
    assert all(prompt.startswith("Detect BALL ACTIONS") for _,prompt in provider.calls[:3])
    assert provider.calls[3][1].startswith("Identify the actor")
    assert output["summary"]["videoEvents"]["completedWindows"]==3


def test_unknown_actor_does_not_discard_match_action_or_create_label(source,tmp_path):
    data = analyze(source,tmp_path/"out",3,Provider(uncertain=True),Mock())["summary"]["videoEvents"]
    assert data["catalog"]==data["players"]==[]
    assert data["events"][0]["matchIncluded"]
    assert data["events"][0]["goalAccepted"]
    assert not data["events"][0]["included"]


def test_late_linking_reuses_canonical_id_and_does_not_repeat_events(source,tmp_path):
    provider = Provider([action(),action(start=2,end=2.8,key=2.4)])
    data = analyze(source,tmp_path/"out",3,provider,Mock())["summary"]["videoEvents"]
    assert len(data["catalog"])==1
    assert len(data["events"])==2
    assert {e["actorId"] for e in data["events"]}=={"Unknown1"}
    assert data["players"][0]["shots"]==2
    assert data["audit"]["identity"]["lateLinkGroups"]==1


def test_incomplete_reference_cannot_create_player_but_action_is_retained(source,tmp_path):
    data = analyze(source,tmp_path/"out",3,Provider(bad_crop=True),Mock())["summary"]["videoEvents"]
    assert data["catalog"]==[]
    assert data["events"][0]["matchIncluded"]
    assert data["audit"]["identity"]["unresolvedActions"]==1


def test_distant_reference_cannot_assign_the_actor_even_if_it_matches_a_known_player(source,tmp_path):
    class Distant(Provider):
        def call(self,provider,prompt,images=(),video=None):
            response = super().call(provider,prompt,images,video)
            if prompt.startswith("Identify the actor"):
                for observation in response["observations"]:
                    if observation["caseId"]=="w1-e1":
                        observation["seconds"]=7.5
            return response
    data = analyze(source,tmp_path/"out",10,Distant([
        action(),action(start=7,end=8,key=7.5),
    ]),Mock())["summary"]["videoEvents"]
    assert len(data["catalog"])==1
    assert data["events"][0]["actorId"] is None
    assert data["events"][0]["actorAssignment"]["reason"]=="reference_not_near_action"
    assert data["events"][0]["matchIncluded"]
    assert data["players"][0]["shots"]==1


@pytest.mark.parametrize("field,match,player",[
    ("action",False,False),("identity",True,False),("outcome",True,True),
])
def test_astra_verdicts_are_separate(source,tmp_path,field,match,player):
    data = analyze(source,tmp_path/"out",3,Provider(review={field:"contradicted"}),Mock())["summary"]["videoEvents"]
    event = data["events"][0]
    assert event["matchIncluded"] is match
    assert event["included"] is player
    assert event["goalAccepted"] is (field=="identity")


def test_same_contact_is_one_canonical_event_even_without_player_assignment():
    events = mark_duplicates([action(),action(id="w2-e1",window="w2",key=1.6)])
    decisions(events)
    assert events[1]["duplicateOf"]==events[0]["id"]
    assert sum(e["matchIncluded"] for e in events)==1
    assert sum(e["goalAccepted"] for e in events)==1


def test_two_unassigned_players_or_distinct_contacts_are_not_merged():
    events = mark_duplicates([
        action(),action(id="w2-e1",window="w2",key=1.6,actorBox=[600,100,800,900]),
        action(id="w2-e2",window="w2",key=1.9),
    ])
    assert not any(e.get("duplicateOf") for e in events)


def test_same_window_duplicate_is_not_counted_twice():
    events = mark_duplicates([action(actorId="Unknown1",identityConfidence="high"),
                              action(id="w1-e2",actorId="Unknown1",identityConfidence="high")])
    decisions(events)
    players = totals(events,[{"id":"Unknown1"}],3)
    assert players[0]["shots"]==1 and players[0]["pending"]==0


def test_temporary_actor_error_is_not_silently_unassigned_or_split(source,tmp_path):
    class Failing(Provider):
        def call(self,provider,prompt,images=(),video=None):
            if prompt.startswith("Identify the actor"):
                raise JobFailure("ai_provider_timeout","Temporary failure",retryable=True)
            return super().call(provider,prompt,images,video)
    with pytest.raises(JobFailure) as error:
        analyze(source,tmp_path/"out",3,Failing(),Mock())
    assert error.value.code=="ai_provider_timeout"


def test_deterministic_actor_limit_preserves_match_statistics(source,tmp_path):
    class Limited(Provider):
        def call(self,provider,prompt,images=(),video=None):
            if prompt.startswith("Identify the actor"):
                raise WindowLimit()
            return super().call(provider,prompt,images,video)
    data = analyze(source,tmp_path/"out",3,Limited(),Mock())["summary"]["videoEvents"]
    assert data["events"][0]["matchIncluded"]
    assert data["events"][0]["actorId"] is None
    assert data["events"][0]["actorAssignment"]["reason"]=="ai_output_limit"


def test_selective_review_skips_confident_routine_actions_and_prioritizes_goals():
    events = [action(id=f"pass{i}",type="pass",outcome="completed") for i in range(50)]
    shots = [action(id=f"shot{i}",outcome="off_target") for i in range(15)]
    goal = action(id="goal")
    selected = select_for_review(events+shots+[goal],"selective")
    assert len(selected)==12 and selected[0]["id"]=="goal"
    assert all(e["type"]=="shot" for e in selected)
    assert len(select_for_review(events+shots+[goal],"all"))==66


def test_selective_review_includes_ambiguous_actions_but_never_duplicates():
    uncertain = action(id="uncertain",type="pass",eventConfidence="medium")
    conflict = action(id="conflict",type="carry",actorAssignment={"reason":"continuity_not_established"})
    duplicate = action(id="duplicate",duplicateOf="uncertain")
    assert [e["id"] for e in select_for_review([uncertain,conflict,duplicate],"selective")]==["uncertain","conflict"]


def test_selective_strategy_flows_through_analysis_without_discarding_unreviewed_passes(source,tmp_path):
    provider = Provider([action(type="pass",outcome="completed"),action(start=2,end=2.8,key=2.4)])
    data = analyze(source,tmp_path/"out",3,provider,Mock(),review_strategy="selective")["summary"]["videoEvents"]
    assert data["audit"]["reviewStrategy"]=="selective"
    assert data["audit"]["candidates"]==2 and data["audit"]["reviewed"]==1
    assert data["events"][0]["review"] is None and data["events"][0]["matchIncluded"]
    assert data["events"][1]["review"] is not None


def test_game_stats_mode_extracts_defense_without_polluting_legacy_counts(source,tmp_path):
    provider=Provider([action(type="tackle",outcome="won")])
    result=analyze(source,tmp_path/"gold",3,provider,Mock(),game_stats=True)
    data=result["summary"]["videoEvents"]
    assert data["audit"]["gameStatsVersion"]==1
    assert data["events"][0]["type"]=="tackle" and data["events"][0]["included"]
    assert data["players"][0]["shots"]==0 and data["players"][0]["goals"]==0
    prompt=next(p for model,p in provider.calls if p.startswith("Detect BALL ACTIONS"))
    assert "interception" in prompt and "stamina" in prompt


def test_fast_actor_batches_are_larger_but_still_temporally_bounded():
    from fa_worker.action_first import actor_groups
    items=[action(id=str(i),key=i*2) for i in range(9)]
    assert len(actor_groups(items))==3
    assert len(actor_groups(items,fast=True))==2
    assert all(len(g)<=6 and g[-1]["key"]-g[0]["key"]<=12 for g in actor_groups(items,fast=True))


def test_focused_review_preserves_shots_and_ambiguity_not_every_clear_contest():
    items=[action(id="shot"),action(id="def",type="tackle",outcome="won"),
           action(id="uncertain",type="pass",outcome="unknown",eventConfidence="low")]
    assert {e["id"] for e in select_for_review(items,"focused")}=={"shot","uncertain"}


@pytest.mark.parametrize("concurrency",[5,10])
def test_discovery_requests_overlap_with_distinct_clip_paths(source,tmp_path,monkeypatch,concurrency):
    import threading
    from fa_worker import video_events
    barrier=threading.Barrier(concurrency)
    paths=[]
    def command(args):
        paths.append(args[-1])
        Path(args[-1]).write_bytes(b"fake clip")
    monkeypatch.setattr(video_events,"command",command)
    class ConcurrentProvider:
        def call(self,provider,prompt,images=(),video=None):
            assert provider=="gemini" and video==b"fake clip"
            barrier.wait(timeout=5)
            return {"events":[],"photoCandidates":[]}
    result=analyze(source,tmp_path/"parallel",20*concurrency,ConcurrentProvider(),Mock(),
        fast=True,select_photos=True,discovery_concurrency=concurrency)
    assert len(paths)==len(set(paths))==concurrency
    data=result["summary"]["videoEvents"]
    assert data["audit"]["discoveryConcurrency"]==concurrency
    assert data["completedWindows"]==concurrency and data["events"]==[]
