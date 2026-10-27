# Gemini native-video comparison

This is a bounded, private experiment, not a production match-analysis integration.
It uses `gemini-3.8-flash` through Replit AI Integrations; usage is billed to Replit
credits and does not require a personal Google API key. The SDK reads managed
environment variables; never paste credentials into commands, source or reports.

## Inputs and execution

Prepare three 720p MP4 excerpts covering source intervals 0–22, 20–42 and 40–60
seconds, each under 5.5 MB, with a manifest describing local filenames, durations,
source offsets and ownership windows 0–20, 20–40 and 40–60. Generated footage,
manifests and reports belong under the ignored `generated-artifacts/` directory.

```sh
node scripts/src/football-gemini-comparison.mjs --manifest generated-artifacts/gemini-video-comparison/manifest.json
PYTHONPATH=football_vision/worker:. python football_vision/worker/experiments/report_gemini.py \
  --input generated-artifacts/gemini-video-comparison
node --test scripts/src/football-gemini-comparison.test.mjs
```

The runner uses native inline MP4 video with requested 10-fps sampling, sequential
rate-limited calls, bounded retry/backoff for transient HTTP failures, and local
response validation. It refuses oversized input and never silently substitutes a
model or frame rate. Successful responses are resumed only when their exact
request fingerprint matches, avoiding repeat charges within this experiment.
Raw responses, prompts, video hashes, returned model IDs and usage are preserved
without SDK headers, credentials or video base64 payloads.

The successful request uses JSON mode and the provider's default media resolution.
An initial request with optional high-resolution and schema settings was rejected;
the exact failing setting was not isolated. That does not imply native video is unsupported. Inspect actual response video-token
usage rather than assuming a successful text control proves video ingestion.

## Interpretation

All events are **pending human review**, including those labelled high confidence
or directly visible by the model. These fields are self-reports, not validation.
Candidate counts are never confirmed pass/shot/goal totals or accuracy scores.

Keep overlap proposals and possible-duplicate flags. Primary-window ownership is
not perfect deduplication. A goal outcome and its shot record may describe the
same action and must not be counted as separate attacks.

The detector baseline must be restricted to the same source interval. Its prototype
does not classify shot/goal outcomes, which must be shown as “not implemented,”
not zero shots/goals. Partial visual inspection is not a complete, independent,
human-labelled reference and cannot establish precision or recall.

Do not report physical speed/distance without pitch calibration, or per-player
totals from clothing descriptions without reliable cross-clip identity.
Only reviewed, validated event aggregates should enter production statistics.
