"""Automatic pitch calibration (experimental, not yet used by the product), on synthetic frames with
exact ground truth. The rule that matters: when it says it is confident, it must be right."""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("cv2", reason="computer-vision extra not installed (pip install -e '.[cv]')")

from fa_worker.analysis.autocalib import auto_calibrate  # noqa: E402

from . import synthetic_camera as sc  # noqa: E402


@pytest.fixture(scope="module")
def texture():
    return sc.world_texture()


@pytest.mark.parametrize("t", [4, 12, 16])
def test_confident_answers_are_accurate_and_unclear_views_are_declined(texture, t):
    target, focal = sc.pan_path(t, 24.0)
    r = auto_calibrate(sc.render(texture, target, focal), attempts=2)
    assert r is not None
    err = sc.mapping_error_m(r.H, target, focal)
    if r.confident:
        assert err < 1.5, f"confident but {err:.2f} m off"
    else:
        assert t == 12, "a view with plenty of lines should be found"


def test_a_frame_without_pitch_lines_is_not_attempted():
    grass = np.zeros((720, 1280, 3), np.uint8)
    grass[:] = (45, 125, 55)
    assert auto_calibrate(grass) is None
