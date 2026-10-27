# Experimental tracking-assisted video analysis

The website's analysis-mode selector offers the original Gemini + Astra mode and an
optional player-tracking-assisted mode. Existing jobs and reports remain unchanged.
Each run uses the normal analysis reservation, cancellation, lease and settlement flow.

## Processing

1. The CPU Modal worker claims the job through the website API.
2. Only if `playerTracking` is enabled, a separate T4 invocation downloads the same
   private source through the storage broker and detects people with standard
   Apache-licensed RF-DETR Nano. ByteTrack runs at five source samples per second.
3. Background optical-flow geometry compensates for camera pan/zoom in image space.
   Hard cuts and unresolvable camera jumps start new track namespaces.
4. Gemini builds the same pitch-only kit reference catalog as before. Unambiguous
   overlap between a reference box and a track anchors that temporary track to a
   catalog label. Repeated references to the same track at different reference
   times can be removed; overlapping boxes in one frame are never auto-merged.
5. Gemini receives original-time video sections with temporary T-number overlays,
   the reference cards and the explicit reference-backed binding map.
6. Individual assignment requires the proposed player to match a bound track
   visible at the event timestamp. Conflict, unknown track or missing evidence
   leaves the player unassigned. The original Gemini assignment is retained
   separately for audit. Match-level event/outcome decisions are independent.
7. Selected Astra blind-first checks retain the existing neutral/contradiction
   policy. The final report and CSV/JSON export include tracking status.

GPU computation stops before the Gemini/Astra processing. No provider credentials
or database connection strings are sent to the GPU. Trajectories are privately
checkpointed inside the same job to avoid repeating completed detection on retries.
No cross-job identity cache is introduced.

## Limitations

This is **not** validated individual-player identity tracking. Standard COCO person
detection can miss distant players and can detect spectators/officials. Only
pitch-reference-anchored tracks receive player statistics. Low visibility,
camera movement and occlusion can fragment or switch tracks. A reference anchor
does not prove a track remains correct forever.

There is no automatic cross-cut re-identification, face/body/gait recognition,
ball tracking, verified possession, measured speed or measured distance. Geometry
compensation does not calibrate metres. The mode may reduce assigned events; fewer
labels do not establish higher accuracy. Keep the original mode as the default.

## Reproducible opt-in three-minute comparison

The fixed test input is `generated-artifacts/football-first-three-minutes.mp4`.
Run the private detector probe with:

    python -m modal run football_vision/worker/experiments/tracking_probe.py

Run AI modes explicitly (normal provider usage costs apply):

    PYTHONPATH=football_vision/worker python football_vision/worker/experiments/compare_tracking.py baseline
    PYTHONPATH=football_vision/worker python football_vision/worker/experiments/compare_tracking.py tracking

The experiment never claims or modifies website jobs. Successful provider responses
are saved privately for resumption. The two modes may share an identical roster
response within this explicit controlled experiment; app jobs never share checkpoints.
The runner stops on rate limits rather than launching repeated paid retries.
Never report a partial run as a full-video comparison or model agreement as ground truth.
