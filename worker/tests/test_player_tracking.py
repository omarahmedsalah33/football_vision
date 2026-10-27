from copy import deepcopy
from unittest.mock import Mock

import numpy as np
import pytest

from fa_worker.player_tracking import TrackingEvidence, pack_tracks, unpack_tracks, transform_boxes, camera_step, shirt_category, TRACKING_VERSION
from fa_worker.video_events import decisions


def evidence():
    return TrackingEvidence({"version": TRACKING_VERSION, "sampleFps": 5, "scenes": 2, "trackCount": 3,
        "frames": [
            {"time": 1., "scene": 1, "people": [{"id": "T1", "box": [100, 100, 200, 500]},
                                             {"id": "T2", "box": [600, 100, 700, 500]}]},
            {"time": 2., "scene": 1, "people": [{"id": "T1", "box": [110, 100, 210, 500]}]},
            {"time": 3., "scene": 2, "people": [{"id": "T3", "box": [110, 100, 210, 500]}]},
        ]})


def event(**changes):
    return {"id": "w1-e1", "window": "w1", "type": "shot", "actorId": "Unknown1", "actorTrackId": "T1",
            "start": .9, "end": 1.1, "key": 1., "outcome": "goal", "eventConfidence": "high",
            "identityConfidence": "high", "evidenceLevel": "direct", "review": None, **changes}


def test_reference_anchor_is_geometric_and_repeated_reference_merges_only_across_times():
    tracker = evidence()
    assert tracker.anchor(1, [100,100,200,500], "Unknown1") == "Unknown1"
    assert tracker.anchor(2, [110,100,210,500], "Unknown2") == "Unknown1"
    assert tracker.duplicates == 1
    assert tracker.bindings == {"T1": "Unknown1"}


def test_overlapping_or_distant_reference_is_not_force_matched():
    tracker = evidence()
    assert tracker.anchor(1, [300,100,400,500], "Unknown1") is None
    assert tracker.anchor(9, [100,100,200,500], "Unknown1") is None
    assert not tracker.bindings


def test_same_frame_boxes_cannot_be_merged_just_because_the_detector_returned_one_box():
    tracker = evidence()
    tracker.anchor(1, [100,100,200,500], "Unknown1")
    assert tracker.anchor(1, [105,100,205,500], "Unknown2") is None
    assert tracker.duplicates == 0


def test_only_visible_reference_backed_matching_identity_gets_player_statistics():
    tracker = evidence()
    tracker.anchor(1, [100,100,200,500], "Unknown1")
    good = tracker.reconcile(event())
    assert decisions([good])[0]["included"]
    assert good["tracking"]["status"] == "supported"
    for change in ({"actorId": "Unknown2"}, {"actorTrackId": "T2"}, {"actorTrackId": "T999"},
                   {"key": 3., "actorTrackId": "T3"}, {"key": 20.}):
        candidate = tracker.reconcile(event(**change))
        result = decisions([candidate])[0]
        assert result["actorId"] is None and not result["included"]
        assert result["matchIncluded"] and result["goalAccepted"]
    assert "T3" not in tracker.bindings  # matching location after a cut is not identity


def test_medium_confidence_is_not_promoted_by_a_track():
    tracker = evidence()
    tracker.anchor(1, [100,100,200,500], "Unknown1")
    result = decisions([tracker.reconcile(event(identityConfidence="medium"))])[0]
    assert not result["included"]


def test_tracking_pack_round_trip_and_invalid_format():
    tracker = evidence()
    assert unpack_tracks(pack_tracks(tracker.data)) == tracker.data
    with pytest.raises(Exception):
        unpack_tracks(pack_tracks({"version": "wrong"}))


def test_camera_pan_boxes_round_trip_without_identity_or_metric_inference():
    matrix = np.array([[1., 0., 50.], [0., 1., -10.], [0., 0., 1.]])
    boxes = np.array([[100., 200., 150., 300., .9]])
    moved = transform_boxes(boxes, matrix)
    np.testing.assert_allclose(moved, [[150., 190., 200., 290., .9]])
    np.testing.assert_allclose(transform_boxes(moved, np.linalg.inv(matrix)), boxes)
    assert transform_boxes(np.zeros((0, 5)), matrix).shape == (0, 5)


def test_camera_geometry_estimates_background_translation_and_rejects_blank_frames():
    import cv2
    random = np.random.default_rng(3)
    before = random.integers(0, 255, (180, 320), dtype=np.uint8)
    after = cv2.warpAffine(before, np.float32([[1,0,5], [0,1,3]]), (320,180))
    result = camera_step(before, after, 1280, 720)
    assert result is not None
    np.testing.assert_allclose(result[:2, 2], [20,12], atol=1)
    assert camera_step(np.zeros_like(before), np.zeros_like(before),1280,720) is None


def test_wide_camera_pan_preserves_geometry_but_unrelated_scene_is_rejected():
    import cv2
    random = np.random.default_rng(9)
    before = cv2.GaussianBlur(random.integers(0,255,(180,320),dtype=np.uint8),(3,3),0)
    after = cv2.warpAffine(before,np.float32([[1,0,55],[0,1,0]]),(320,180))
    result = camera_step(before,after,1280,720)
    assert result is not None
    np.testing.assert_allclose(result[:2,2],[220,0],atol=2)
    unrelated = random.integers(0,255,(180,320),dtype=np.uint8)
    assert camera_step(before,unrelated,1280,720) is None


@pytest.mark.parametrize("fps",[5,10,30])
def test_bytetrack_buffer_is_in_thirty_fps_units_not_sample_rate(fps):
    from types import SimpleNamespace
    from unittest.mock import patch
    from fa_worker.analysis.tracker import ByteTrackTracker
    construct = Mock()
    fake = SimpleNamespace(ByteTrackTracker=construct,__version__="2.6.1")
    with patch.dict("sys.modules",{"supervision":SimpleNamespace(),"trackers":fake}):
        ByteTrackTracker(fps,lost_seconds=2)
    assert construct.call_args.kwargs["lost_track_buffer"] == 60
    assert construct.call_args.kwargs["frame_rate"] == fps


def test_valid_pan_does_not_reset_ids_but_unexplained_hard_cut_does():
    from types import SimpleNamespace
    from unittest.mock import MagicMock, patch
    from fa_worker.player_tracking import collect_tracks
    frames = []
    for i,value in enumerate([0,255,255,0]):
        frames.append(SimpleNamespace(pts=i/5, time_base=1,
            to_ndarray=lambda format,value=value:np.full((180,320,3),value,dtype=np.uint8)))
    container = MagicMock()
    container.__enter__.return_value = container
    container.streams.video = [SimpleNamespace(start_time=0,time_base=1)]
    container.decode.return_value = iter(frames)
    detector = SimpleNamespace(version="synthetic",detect=lambda image,t:np.array([[10.,10.,30.,60.,.9]]))
    class Tracker:
        version = "synthetic"
        def update(self, boxes):
            return boxes[:,:4],np.array([0])
    factory = Mock(side_effect=[Tracker(),Tracker()])
    with patch.dict("sys.modules",{"fa_worker.analysis.detector":SimpleNamespace(RFDETRDetector=Mock())}), \
         patch("av.open",return_value=container), \
         patch("fa_worker.player_tracking.camera_step",side_effect=[np.eye(3),None,None]):
        result = collect_tracks("synthetic",detector=detector,tracker_factory=factory)
    assert result["scenes"] == 2
    assert [f["people"][0]["id"] for f in result["frames"]] == ["T1","T1","T1","T2"]
    assert factory.call_count == 2


def test_historical_tracking_remains_readable_without_changing_its_provenance():
    data = evidence().data
    data["version"] = "rfdetr-bytetrack-v1"
    loaded = TrackingEvidence(unpack_tracks(pack_tracks(data)))
    assert loaded.summary([])["method"] == "rfdetr-bytetrack-v1"


def test_shirt_colour_conflict_is_negative_evidence_not_identity_merging():
    light = np.full((90,80,3),[190,190,185],dtype=np.uint8)
    blue = np.full((90,80,3),[60,65,160],dtype=np.uint8)
    box = np.array([10,10,70,80])
    assert shirt_category(light,box) == "light"
    assert shirt_category(blue,box) == "blue"
    assert shirt_category(np.zeros_like(light),box) is None
    assert shirt_category(light, [10,10,12,14]) is None


def test_visible_shirt_flip_breaks_the_id_even_if_kalman_reuses_the_local_number():
    from types import SimpleNamespace
    from unittest.mock import MagicMock,patch
    from fa_worker.player_tracking import collect_tracks
    samples = [np.full((180,320,3),rgb,dtype=np.uint8)
               for rgb in ([190,190,185],[60,65,160],[190,190,185])]
    decoded = [SimpleNamespace(pts=i/10,time_base=1,to_ndarray=lambda format,img=img:img)
               for i,img in enumerate(samples)]
    container = MagicMock()
    container.__enter__.return_value = container
    container.streams.video = [SimpleNamespace(start_time=0,time_base=1)]
    container.decode.return_value = iter(decoded)
    detector = SimpleNamespace(version="synthetic",detect=lambda image,t:np.array([[10.,10.,70.,80.,.9]]))
    class Tracker:
        version = "synthetic"
        def update(self,boxes):
            return boxes[:,:4],np.array([0])
    with patch.dict("sys.modules",{"fa_worker.analysis.detector":SimpleNamespace(RFDETRDetector=Mock())}), \
         patch("av.open",return_value=container), \
         patch("fa_worker.player_tracking.camera_step",return_value=np.eye(3)):
        result = collect_tracks("synthetic",detector=detector,tracker_factory=Tracker)
    assert result["scenes"] == 1
    assert [f["people"][0]["id"] for f in result["frames"]] == ["T1","T2","T3"]
