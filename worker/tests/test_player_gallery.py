import io
from pathlib import Path
from unittest.mock import Mock

import pytest
from PIL import Image

from fa_worker.errors import JobFailure
from fa_worker.player_gallery import PlayerGallery
from fa_worker.video_provider import WindowLimit


def photo():
    data = io.BytesIO()
    Image.new("RGB",(400,240),"blue").save(data,format="JPEG")
    return data.getvalue()


@pytest.fixture
def gallery(tmp_path):
    (tmp_path/"crops").mkdir()
    (tmp_path/"crops"/"1.jpg").write_bytes(photo())
    catalog = [{"id":"Unknown1","description":"Blue kit, red shoes","photoKey":None,"referenceSeconds":1.0}]
    cards = [photo()]
    def command(args):
        Path(args[-1]).write_bytes(b"synthetic-video")
    return PlayerGallery(tmp_path/"source.mp4",tmp_path,catalog,cards,[[100,100,300,900]],1.0,
                         lambda *args:photo(),command)


def observation(**changes):
    return {"seconds":2.0,"box":[500,100,700,900],"description":"White shirt, black shorts, yellow shoes",
            "decision":"uncertain","actorId":None,"confidence":"high","visibility":"clear",
            "matchBasis":"distinctive_kit_and_shoes","alternativesRuledOut":[],
            "evidence":"Different kit details and clearly visible yellow shoes.",
            "separations":[],**changes}


def proof():
    return {"actorId":"Unknown1","basis":"co_visible_separate_player","box":[100,100,300,900],
            "evidence":"The blue-kit reference player is separately visible on the left."}


def test_uncertain_appearance_does_not_create_another_unknown(gallery):
    gallery.apply({"observations":[observation()]},0,20)
    assert len(gallery.catalog)==1
    assert gallery.stats["unresolvedAppearances"]==1


def test_new_claim_needs_separation_from_every_known_player(gallery):
    gallery.apply({"observations":[observation(decision="new")]},0,20)
    assert len(gallery.catalog)==1
    assert gallery.unresolved[0]["reason"]=="new_player_not_established"


def test_same_frame_duplicate_is_reused_even_if_model_proposes_new(gallery):
    gallery.apply({"observations":[observation(seconds=1.0,box=[100,100,300,900],decision="new")]},0,20)
    assert len(gallery.catalog)==1
    assert gallery.stats["matchedAppearances"]==1
    assert gallery.stats["newPlayers"]==0


def test_proven_distinct_player_and_later_view_keep_one_canonical_id(gallery):
    gallery.apply({"observations":[observation(decision="new",separations=[proof()])]},0,20)
    assert [p["id"] for p in gallery.catalog]==["Unknown1","Unknown2"]
    assert (gallery.out/"crops"/"2.jpg").exists()
    gallery.apply({"observations":[observation(
        decision="match",actorId="Unknown2",alternativesRuledOut=["Unknown1"])]},20,20)
    assert len(gallery.catalog)==2
    assert len(gallery.references["Unknown2"])==2
    assert len(gallery.cards)==2
    assert gallery.stats["newPlayers"]==1


def test_same_colour_alone_does_not_merge_players(gallery):
    gallery.apply({"observations":[observation(
        decision="match",actorId="Unknown1",matchBasis="shirt_colour")]},0,20)
    assert gallery.stats["matchedAppearances"]==0
    assert len(gallery.references["Unknown1"])==1


def test_competing_gallery_candidates_must_be_ruled_out(gallery):
    gallery.apply({"observations":[observation(decision="new",separations=[proof()])]},0,20)
    gallery.apply({"observations":[observation(
        decision="match",actorId="Unknown1",alternativesRuledOut=[])]},20,20)
    assert gallery.stats["matchedAppearances"]==0
    assert gallery.unresolved[-1]["reason"]=="ambiguous_existing_player"


def test_conflicting_simultaneous_matches_are_not_added(gallery):
    a = observation(decision="match",actorId="Unknown1")
    b = observation(decision="match",actorId="Unknown1",box=[750,100,950,900])
    gallery.apply({"observations":[a,b]},0,20)
    assert gallery.stats["unresolvedAppearances"]==2
    assert len(gallery.references["Unknown1"])==1


def test_separately_visible_same_kit_players_are_not_merged(gallery):
    a = observation(decision="new",separations=[proof()],description="Blue kit, red shoes")
    b = observation(decision="new",separations=[proof()],description="Blue kit, red shoes",
                    box=[750,100,950,900])
    gallery.apply({"observations":[a,b]},0,20)
    assert [p["id"] for p in gallery.catalog]==["Unknown1","Unknown2","Unknown3"]


def test_repeated_new_proposal_in_different_frames_is_not_assumed_distinct(gallery):
    a = observation(decision="new",separations=[proof()])
    b = observation(decision="new",separations=[proof()],seconds=3)
    gallery.apply({"observations":[a,b]},0,20)
    assert len(gallery.catalog)==2
    assert gallery.stats["unresolvedAppearances"]==1


@pytest.mark.parametrize("changes",[
    {"seconds":float("nan")},{"seconds":21},{"box":[1,2,1,9]},
    {"actorId":"Unknown999"},{"decision":"merge_everyone"},
])
def test_invalid_observations_fail_explicitly(gallery,changes):
    with pytest.raises(JobFailure) as error:
        gallery.apply({"observations":[observation(**changes)]},0,20)
    assert error.value.code=="ai_gallery_invalid"


def test_scan_covers_entire_video_not_just_seed_frame(gallery):
    provider = Mock()
    provider.call.return_value = {"observations":[]}
    commands = []
    original = gallery.command
    def command(args):
        commands.append(args)
        original(args)
    gallery.command = command
    audit = gallery.scan(45,provider,Mock())
    assert provider.call.call_count==3
    assert [c[c.index("-ss")+1] for c in commands]==["0","20","40"]
    assert [c[c.index("-t")+1] for c in commands]==["20","20","5"]
    assert audit["completedWindows"]==audit["totalWindows"]==3
    assert len(gallery.catalog[0]["references"])==1


def test_only_confirmed_limits_split_gallery_sections(gallery):
    provider = Mock()
    provider.call.side_effect = [WindowLimit(),{"observations":[]},{"observations":[]}]
    audit = gallery.scan(20,provider,Mock())
    assert provider.call.call_count==3
    assert audit["completedWindows"]==1
    provider.call.reset_mock()
    provider.call.side_effect = JobFailure("ai_provider_timeout","Try again",retryable=True)
    with pytest.raises(JobFailure):
        gallery.scan(20,provider,Mock())
    assert provider.call.call_count==1


def test_gallery_keeps_at_most_three_views_per_player(gallery):
    for seconds in range(2,8):
        gallery.apply({"observations":[observation(
            seconds=seconds,decision="match",actorId="Unknown1")]},0,20)
    assert len(gallery.catalog)==1
    assert len(gallery.references["Unknown1"])==3
    assert gallery.stats["matchedAppearances"]==6


def test_conflicting_readable_numbers_do_not_contaminate_existing_gallery(gallery):
    gallery.catalog[0]["jerseyNumber"] = "17"
    gallery.apply({"observations":[observation(
        decision="match",actorId="Unknown1",jerseyNumber="8")]},0,20)
    assert len(gallery.references["Unknown1"])==1
    assert gallery.unresolved[-1]["reason"]=="contradictory_readable_number"


def test_clear_different_known_number_can_establish_a_new_player(gallery):
    gallery.catalog[0]["jerseyNumber"] = "17"
    separation = {"actorId":"Unknown1","basis":"different_readable_number",
                  "referenceNumber":"17","evidence":"The visible back shows 8, not the known 17."}
    gallery.apply({"observations":[observation(
        decision="new",jerseyNumber="8",separations=[separation])]},0,20)
    assert gallery.catalog[1]["jerseyNumber"]=="8"
    assert gallery.catalog[1]["id"]=="Unknown2"


def test_unknown_number_cannot_be_used_as_proof_of_novelty(gallery):
    separation = {"actorId":"Unknown1","basis":"different_readable_number",
                  "referenceNumber":"17","evidence":"An unverified reference number must not be used."}
    gallery.apply({"observations":[observation(
        decision="new",jerseyNumber="8",separations=[separation])]},0,20)
    assert len(gallery.catalog)==1


def test_feet_only_reference_does_not_replace_good_reference_or_create_new_id(gallery):
    original = (gallery.out/"crops"/"1.jpg").read_bytes()
    for decision,actor in (("match","Unknown1"),("new",None)):
        resolved = gallery.apply({"observations":[observation(
            decision=decision,actorId=actor,box=[100,400,900,500],separations=[proof()])]},0,20)
        assert resolved[0] is None
    assert len(gallery.catalog)==1
    assert (gallery.out/"crops"/"1.jpg").read_bytes()==original
    assert not (gallery.out/"crops"/"2.jpg").exists()


def test_top_level_observation_array_keeps_full_validation(gallery):
    assert gallery.apply([observation()],0,20)=={0:None}
    with pytest.raises(JobFailure):
        gallery.apply([{"seconds":True}],0,20)
