# Astra challenges Gemini's football-event proposals

This is a private, bounded cross-model review, not an official statistics system.
The requested reviewer is `gpt-6-astra` through Replit AI Integrations for OpenAI.
Usage is billed to Replit credits without a personal API key.

## Method

The existing Gemini first-minute experiment supplies twelve records, including one
overlapping pass proposal. Extract source frames in five windows, including two
intervals where Gemini proposed no events. Action windows use 0.5–0.75-second steps;
controls use 1.5–2-second steps. Additional native-resolution detail crops show
several moments around the goal-area claim.

Each window is reviewed twice:

1. **Independent first look:** actual timestamped frames without Gemini predictions.
2. **Challenge:** the same frames, Astra's first response and Gemini's claims.
   Astra assesses action, outcome, identity, timing and over-specific details.

Window selection still depends on Gemini timestamps. This reduces answer anchoring;
it is not an independent, human-labelled dataset or an unbiased accuracy benchmark.
Astra receives images, not native video, and may miss motion between samples.

## Running

```sh
PYTHONPATH=football_vision/worker:. python football_vision/worker/experiments/prepare_astra_review.py \
  --gemini-input generated-artifacts/gemini-video-comparison \
  --output generated-artifacts/astra-gemini-review
node scripts/src/football-astra-review.mjs \
  --manifest generated-artifacts/astra-gemini-review/manifest.json
PYTHONPATH=football_vision/worker:. python football_vision/worker/experiments/report_astra.py \
  --input generated-artifacts/astra-gemini-review
node --test scripts/src/football-astra-review.test.mjs
```

Generated clips, frames and responses stay in ignored `generated-artifacts/`.
The runner checks source-image hashes, limits the experiment to five windows and
100 images, permits at most two windows in flight, rate-limits requests, and retries
only transient HTTP failures with bounded backoff. Saved exact-input responses can
resume this experiment without another paid call. No global/cross-job cache exists.

Raw responses, prompts, returned model IDs, usage and fingerprints are preserved.
Never write SDK headers, credentials or image base64 payloads to reports or logs.
No production routes, database records or match statistics are modified.

## Clearest full-player reference timestamps

Normal checks now also ask Astra to choose the clearest supplied full-player frame
for locally distinguishable appearances, using clothing, shirt numbers, screen
position and uninterrupted movement only. No face matching, biometric descriptors,
cross-window identity claims or inferred names are requested. Labels are scene-local;
they must not be interpreted as a unique player count.

This adds one bounded image request per window. To obtain only frame selections
without repeating the event checks, or explicitly skip that additional phase:

```sh
node scripts/src/football-astra-review.mjs \
  --manifest generated-artifacts/astra-gemini-review/manifest.json --player-frames
# Existing event-only behaviour: use --skip-player-frames instead.
PYTHONPATH=football_vision/worker:. python football_vision/worker/experiments/report_player_frames.py \
  --input generated-artifacts/astra-gemini-review
```

Outputs include a self-contained reference-frame report, exact source timestamps
in mm:ss.mmm, model selection reasons and limitations, CSV/JSON, and selected
original full-frame JPEGs. "Clearest" is limited to supplied samples from the first
minute, not the full match or guaranteed distinct people. This is an experimental
review command, not a production match-upload feature.

## Reading the report

**Supported**, **contradicted** and **inconclusive** are Astra's judgments of the
available frames, not certified labels. Agreement between models is not ground truth.
Inconclusive is not proof a claim is false. Keep action and outcome judgments separate:
a supported shot does not establish a goal or an on-target outcome.

The raw reviewer verdict vocabulary has no not-applicable value. For carries with a
not-applicable outcome, read Astra's explanatory comments rather than interpreting
an inconclusive outcome verdict as a failed carry.

The HTML report embeds representative cited evidence; the ZIP can contain all exact
input frames. CSV/JSON retain every claim and the overlap flags. Suggested corrections
remain proposals for human review, not automatic changes to match totals.
