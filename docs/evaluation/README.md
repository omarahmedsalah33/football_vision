# Accuracy evaluation

Football Vision does not publish accuracy claims it has not measured. This folder holds the
measurements and explains how they are produced.

## Status

**No real-footage measurements yet.** The evaluation harness is built and tested on synthetic
data; it needs access to the SoccerTrack v2 dataset (gated on Hugging Face) to run.

| Check | Data | Result |
|---|---|---|
| Pipeline correctness (tracking, teams, projection, metrics) | Synthetic match with known truth (`worker/tests/test_analysis.py`) | Passing: positions within 0.75 m, team width within 1 m, distance within 15 % |
| Detection, tracking and team accuracy on real football | SoccerTrack v2 | **Not run yet** |

## Dataset

[SoccerTrack v2](https://huggingface.co/datasets/atomscott/soccertrack-v2): 10 university matches
filmed by fixed panoramic cameras covering the whole pitch, with per-frame player positions in
metres. Licence CC BY 4.0 (commercial use with attribution). Players gave informed consent; no
names are included. **Attribution:** Scott et al., *SoccerTrack v2*, arXiv 2508.01802.

Use only matches labelled **validation** or **test** (M2 = 117093; M7 = 128057, M9 = 132831) for
reported numbers, so results are not tuned on the data they are reported on.

## What is measured

Predictions and ground truth are matched per frame in pitch space (optimal assignment, accepted
within 2 m), the same principle as GS-HOTA's localisation step.

| Metric | Meaning |
|---|---|
| Detection recall | Share of real people on the pitch that we found |
| Detection precision | Share of our sightings that are real people |
| Localisation error | Metres between our position and the true position (mean, 90th percentile) |
| Team accuracy | Share of matched players assigned to the correct team |
| Identity switches / minute | How often the track following one real person changes |
| Team-width error | Our team width per 10 s window versus the width computed from the truth |

Calibration mode `oracle` fits the homography to thousands of ground-truth correspondences. It
isolates detection and tracking from calibration error: a best case for a pure homography. The
panoramic camera has lens distortion, so the oracle's own residual is reported too.

## How to run

```bash
# 1. Accept the dataset conditions on Hugging Face and create a read token, then download one match:
huggingface-cli download atomscott/soccertrack-v2 --repo-type dataset --local-dir D:/soccertrack-v2 \
  --include "videos/117093/*" "gsr/117093/*" "raw/117093/*"
# 2. Score three minutes of the first half (writes report.json next to the tracks):
cd worker
.venv/Scripts/python -m fa_worker.eval.soccertrack --root D:/soccertrack-v2 --match 117093 \
  --half 1st --start-min 10 --minutes 3 --out ../docs/evaluation
```

Each run records the models, settings and processing time with its scores, so results can be
compared as the pipeline changes. Downloaded footage must never be committed (the repository
ignores video files).
