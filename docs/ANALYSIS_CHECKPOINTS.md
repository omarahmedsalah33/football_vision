# Analysis recovery checkpoints

Analysis retries reuse private App Storage artifacts. This is automatic; the existing job retry
policy, usage reservation, cancellation, and atomic result publication still apply. There is no
new database table or migration.

## Recovery boundaries

- Every **120 detector calls** (roughly 30 seconds of footage at the default 4 sampled fps), the
  child writes a compressed detection batch. The parent registers its metadata in the leased
  job's config, uploads the bytes, and acknowledges the batch before the child continues.
- A retry downloads matching batches, decodes the source again, and **replays tracking and camera
  following chronologically from the beginning**. Cached detector calls do not run GPU inference.
  This avoids pickling mutable tracker/GPU state or splitting player identities at batch boundaries.
- After analysis finishes, a compressed bundle saves the result, tracks, and player photos.
  An output-upload or final database failure can retry from that bundle without downloading the
  source or starting the analysis child.
- Abrupt interruption can lose the unfinished detection batch. Video decoding, camera following,
  tracking, and metrics may still run again when only detection batches are available.
- A cache-only retry still uses the existing Modal GPU invocation; this reduces repeated inference,
  not all GPU allocation charges.

## Safety and lifecycle

- Metadata is server/worker-owned under `_workerCheckpoints` in job config. Files live under
  `orgs/<org>/matches/<match>/analysis/<job>/checkpoints/<binding>/`.
- The binding covers job/tenant/video identifiers, the source key and verified byte size,
  calibration, detector and sampling settings, worker source code, and relevant package versions.
  Upload source keys are immutable through the supported upload flow.
- Every restore verifies size and SHA-256. Detection JSON and result archives have bounded sizes;
  archives allow only result JSON, compressed tracks, and numbered JPEG player crops. No pickle
  or archive-provided links/path traversal are accepted.
- Missing objects from an interrupted upload are cache misses. Corrupt objects fail explicitly
  rather than quietly mixing untrusted detections into a report.
- Registration happens before upload, so even an interrupted upload remains discoverable.
  The database update requires a live, unexpired lease, running status, and no cancel request.
- Cancellation and lease loss stop publication. Attempts have distinct local directories.
  Results remain invisible until the existing fenced transaction marks the job successful.
- Terminal jobs delete checkpoints immediately, with maintenance retrying failed deletion.
  Queued/running jobs retain checkpoints. Footage, match, and organization purges also clean them.
- The worker storage broker accepts these files only through dedicated worker authentication and
  exact checkpoint paths/MIME types. Browser sessions cannot download them.

## Verification

From the workspace root with worker dependencies installed:

```sh
PYTHONPATH=football_vision/worker:. python -m pytest \
  football_vision/worker/tests/test_checkpoints.py \
  football_vision/worker/tests/test_metrics.py \
  football_vision/worker/tests/test_stitch.py \
  football_vision/worker/deployment_tests -q
pnpm --filter @workspace/football-vision-web exec vitest run --config vitest.storage.config.mts
```

Tests simulate lost disks, interrupted uploads, partial batches, damaged files, expired lease
publication, cancellation, completed-output recovery, private broker access, and cleanup.
A CPU synthetic-video replay checks that cached detections produce identical metrics, tracks,
and player photos. These are not real-football accuracy or paid Modal GPU benchmarks.

## Release

Republish the website broker before deploying the updated Modal worker. Older brokers reject the
new checkpoint namespace. Do not deploy the worker against a development database for production.
