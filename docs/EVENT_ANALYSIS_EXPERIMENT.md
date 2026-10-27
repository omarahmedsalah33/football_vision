# Match-event analysis experiment

This is a **separate, explicitly invoked experiment**, not the production analysis job pipeline.
It does not modify the application database, spend a reserved analysis unit, publish a website,
deploy a permanent worker, or expose footage publicly.

## What it implements

1. Timestamped person and ball detection at a configurable sample rate.
2. Camera-motion estimation using background optical flow and RANSAC homographies.
3. Short-lived player tracklets using geometry and conservative kit-appearance labels.
4. Ball continuity and ambiguous-candidate rejection.
5. Sustained, unambiguous player–ball proximity as an estimated control signal.
6. Review candidates for same-kit completed passes, other control transfers, and ball carries.
7. Optional manually anchored goal regions for **goalward movement candidates**, not shot outcomes.
8. JSON/CSV and a self-contained HTML report with timestamped visual evidence.

It does **not** establish pass intent, incomplete passes, shot outcomes, goals, successful
one-on-one dribbles, unique named players, metres, km/h or whole-match possession. Those fields
are null rather than fabricated zeros. A carry is not automatically a successful dribble.
Kit appearance is not a verified team assignment, especially for mixed kits and goalkeepers.

## Running

Use existing Modal credentials through the SDK, not copied tokens or production database secrets.
From the workspace root:

```sh
# Inspect representative frames across the recording before committing to a longer GPU run.
PYTHONPATH=football_vision/worker:. python football_vision/worker/experiments/match_events.py \
  --video path/to/match.mp4 --output generated-artifacts/event-probe --probe --detector rfdetr

# A continuous test excerpt, preserving event timing at 10 sampled fps.
PYTHONPATH=football_vision/worker:. python football_vision/worker/experiments/match_events.py \
  --video path/to/match.mp4 --output generated-artifacts/event-test \
  --detector rfdetr --fps 10 --start 0 --duration 180

PYTHONPATH=football_vision/worker:. python football_vision/worker/experiments/report_events.py \
  --video path/to/match.mp4 --input generated-artifacts/event-test
```

`--detector footandball` tests the specialist baseline. `--detector soccernet` tests an externally
fine-tuned legacy RF-DETR checkpoint; commercial suitability and dataset licensing need separate
review before production adoption. Omitting `--duration` processes the full recording; GPU time
can be substantial, so do not do this when preliminary ball quality is inadequate.

An optional `--image-id` reuses an already built Modal image. It must contain compatible worker
source: frozen images do not automatically include later local algorithm changes.

Footage goes to an **ephemeral, private Modal volume** only for the run. It is not baked into a
container image, put into the persistent model cache, or added to a new public storage namespace.
Reports and detections download to the ignored `generated-artifacts/` directory. Persistent
application uploads still use the existing Replit App Storage pipeline.

## Output interpretation

- `inference.json`: actual detector, thresholds, sampling, source dimensions, timing and versions.
- `detections.jsonl.gz`: person/ball proposals, kit measurements and camera transforms.
- `observations.jsonl.gz`: coherent ball proposals, tracklets and estimated control.
- `report.json`: requested-statistic availability, coverage, candidates, tracklet data and caveats.
- `event-candidates.csv`: timestamped review queue, explicitly pending/unvalidated.
- `tracklets.csv`: observed fragments with candidate passes/carries, **not unique player totals**.
- `report.html`: standalone diagnostic report; no CDN or external assets.

Sparse probe frames are deliberately refused by the temporal report builder. Coherent detection
coverage is continuity, **not measured accuracy**. Partial-excerpt reports explicitly show the
analyzed time range; they are not full-match totals.

## Models and attribution

### RF-DETR

Roboflow RF-DETR standard models and package: Apache-2.0.
https://github.com/roboflow/rf-detr

The general COCO model is a baseline, not a trained amateur-night-football event detector.
The person and ball class IDs are resolved from the model's class mapping.

### FootAndBall

Jacek Komorowski, Grzegorz Kurzejamski and Grzegorz Sarwas.
*FootAndBall: Integrated Player and Ball Detector*, VISAPP 2020.
https://github.com/jac99/FootAndBall
https://doi.org/10.5220/0008916000470056

Runtime downloads are pinned to a revision and verified against Git blob hashes.
The model is loaded with `torch.load(weights_only=True)`; unrestricted pickle is not enabled.
Upstream license:

> MIT License
>
> Copyright (c) 2020 Sport Algorithmics and Gaming
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### Experimental SoccerNet fine-tune

https://huggingface.co/julianzu9612/RFDETR-Soccernet

The publisher declares Apache-2.0; this is not a legal determination about underlying training
data. We do not adopt the publisher's claimed performance as measured accuracy on user footage.
Weights are revision-pinned and SHA-256 verified. The published example names the wrong base
architecture; the experiment uses the matching legacy Large tensor shapes and a strict weight
load. Only the new, unused keypoint bookkeeping buffer may be initialized locally.

## Validation before product integration

Synthetic tests check event logic, missing-ball rejection, camera cuts, pan compensation,
unknown kits, null-vs-zero behavior and carry-vs-dribble semantics. These do **not** validate
real-video recognition accuracy.

Next, label representative clips from this kind of footage, hold out different time intervals,
and measure ball detection precision/recall, tracking identity errors and event precision/recall.
Do not call pseudo-labels ground truth or evaluate a trained model on its own training labels.
Then add reviewed player/team assignment and measured pitch calibration. Only after that should
reviewed event aggregates be integrated into production match/player statistics.

The extraction experiment assumes constant-frame-rate source timestamps. Production support for
variable-frame-rate video must use decoded presentation timestamps rather than frame index / fps.
