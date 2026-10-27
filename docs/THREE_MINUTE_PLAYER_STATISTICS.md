# Three-minute player-statistics experiment

This experiment uses the twelve **fixed Unknown labels from the delivered player-image
PDF**, not biometric identities. The PDF and original crop hashes bind results to that
exact reference catalog. Do not overwrite/renumber references while an analysis is running.

## Scope and providers

- Source time 00:00–03:00, split into nine 20-second ownership windows with up to
  two seconds of extra video context.
- Gemini 3.8 Flash receives native video at requested 10-fps sampling, kit cards and
  labelled pitch-reference views. Reference heads are partly obscured, and prompts
  explicitly prohibit facial/biometric matching. Ambiguous assignments stay unassigned.
- Astra reviews at most six selected shots, unclear kicks and first-minute passes
  using sampled original-source frames, with a blind-first pass then a challenge.
  Its best-frame citations retain the requested visibility-reference selection.
- Providers use the existing Replit AI Integrations. Usage is billed to Replit credits;
  personal API keys are not required. Actual usage is saved without estimated currency.
- This is an isolated experiment, not a production upload feature or database update.

## Running

```sh
python football_vision/worker/experiments/prepare_player_stats.py \
  --source 'attached_assets/videoplayback_(1)_1792870755316.mp4' \
  --output generated-artifacts/player-stats-three-minutes
node scripts/src/football-player-stats.mjs \
  --manifest generated-artifacts/player-stats-three-minutes/manifest.json
PYTHONPATH=football_vision/worker:. python football_vision/worker/experiments/player_stats_evidence.py \
  --input generated-artifacts/player-stats-three-minutes
node scripts/src/football-player-stats-audit.mjs \
  --manifest generated-artifacts/player-stats-three-minutes/evidence-manifest.json
PYTHONPATH=football_vision/worker:. python football_vision/worker/experiments/report_player_stats.py \
  --input generated-artifacts/player-stats-three-minutes
```

## Counts and limitations

The report contains **provisional qualifying observations, not official match totals**.
Counted proposals require high qualitative event/kit-assignment confidence and direct
visible evidence. Per the user's rule, Astra's neutral/inconclusive verdict retains
Gemini's decision; explicit action or identity contradictions remain pending.
Qualitative model confidence is not calibrated accuracy.

- Pass counts mean attempts, not necessarily completed passes.
- Carry counts mean controlled movement episodes, not touches or successful take-ons.
- A goal is a shot outcome, not a separate action. Gemini's goal is accepted when Astra
  supports it, is neutral, or did not audit it; an explicit outcome contradiction blocks
  the goal. Accepted goals and Astra-supported goal claims are separate fields so neutrality
  is never mislabeled as model agreement or human ground truth.
- Obvious overlapping cross-clip duplicates are not counted twice.
- Source-key timestamps determine 00:00–01:00 / 01:00–02:00 / 02:00–03:00 splits.
- Zero means no qualifying attributed proposal, not proof a player made zero actions.
- Unassigned/pending actions and contradictory evidence are retained in the ledger.
- A still frame locates an action; it cannot alone establish the full motion/outcome.

The PDF, CSVs and evidence bundle include per-player counts, per-minute splits,
event intervals, original-source key frames, kit-assignment basis, Astra comments and
exclusion reasons. Large/private generated files stay in ignored generated-artifacts.

## Paid-request bounds and recovery

Video requests run at most two concurrently, with a ten-second global start limiter
and at most three transient-HTTP attempts. A MAX_TOKENS result is preserved and may
receive one higher-output-budget attempt for that clip only. No silent model fallback.
Each exact-input response has a fingerprint; valid completed/raw results resume within
the experiment without reissuing the same successful model request.
