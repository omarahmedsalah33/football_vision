import pytest

from fa_worker.errors import JobFailure
from fa_worker.stages.validate import check, run_probe, validate

from .conftest import write_audio_only, write_video

GOOD = {
    "container": "mov,mp4,m4a,3gp,3g2,mj2",
    "video_codec": "h264",
    "duration_seconds": 5400.0,
    "width": 1920,
    "height": 1080,
    "fps": 25.0,
    "decoded_samples": 3,
}


def failure_code(facts, max_duration=7800):
    with pytest.raises(JobFailure) as exc:
        check(facts, max_duration)
    assert exc.value.reject_video
    return exc.value.code


def test_accepts_a_typical_match_recording():
    info = check(GOOD, 7800)
    assert (info.width, info.height, info.fps) == (1920, 1080, 25.0)


@pytest.mark.parametrize(
    "override, code",
    [
        ({"duration_seconds": 9000.0}, "too_long"),
        ({"duration_seconds": 4.0}, "too_short"),
        ({"width": 480, "height": 270}, "resolution_too_low"),
        ({"width": 7680, "height": 4320}, "resolution_too_high"),
        ({"fps": 5.0}, "unsupported_frame_rate"),
        ({"fps": 240.0}, "unsupported_frame_rate"),
        ({"container": "avi"}, "unsupported_container"),
        ({"decoded_samples": 1}, "undecodable"),
    ],
)
def test_rejects_unsupported_videos(override, code):
    assert failure_code({**GOOD, **override}) == code


def test_plan_duration_limit_comes_from_the_job():
    assert failure_code(GOOD, max_duration=3600) == "too_long"


def test_probe_errors_map_to_safe_codes():
    assert failure_code({"error": "no_video_stream"}) == "no_video_stream"
    assert failure_code({"error": "undecodable"}) == "undecodable"


def test_real_probe_accepts_a_generated_video(tmp_path):
    info = validate(write_video(tmp_path / "ok.mp4"), 7800, timeout_seconds=60)
    assert info.width == 640 and info.height == 368
    assert info.fps == pytest.approx(10, rel=0.01)
    assert info.duration_seconds == pytest.approx(12, abs=0.5)


def test_real_probe_accepts_matroska(tmp_path):
    info = validate(write_video(tmp_path / "ok.mkv", container="matroska"), 7800, timeout_seconds=60)
    assert info.container == "matroska,webm"


def test_random_bytes_with_video_extension_are_rejected(tmp_path):
    bad = tmp_path / "fake.mp4"
    bad.write_bytes(b"\x00\x00\x00\x20ftypisom" + bytes(range(256)) * 200)
    with pytest.raises(JobFailure) as exc:
        validate(bad, 7800, timeout_seconds=60)
    assert exc.value.code == "undecodable"


def test_truncated_video_is_rejected(tmp_path):
    full = write_video(tmp_path / "full.mp4", seconds=20)
    truncated = tmp_path / "truncated.mp4"
    truncated.write_bytes(full.read_bytes()[: full.stat().st_size // 3])
    with pytest.raises(JobFailure) as exc:
        validate(truncated, 7800, timeout_seconds=60)
    assert exc.value.code == "undecodable"


def test_audio_only_file_is_rejected(tmp_path):
    with pytest.raises(JobFailure) as exc:
        validate(write_audio_only(tmp_path / "audio.mp4"), 7800, timeout_seconds=60)
    assert exc.value.code == "no_video_stream"


def test_probe_timeout_is_enforced(tmp_path):
    with pytest.raises(JobFailure) as exc:
        run_probe(write_video(tmp_path / "slow.mp4"), timeout_seconds=0.01)
    assert exc.value.code == "probe_timeout"
