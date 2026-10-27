# Replit website + Modal worker

**Current analysis:** Gemini/Astra on Modal CPU replaces RF-DETR/GPU tracking for new
jobs. See `AI_VIDEO_ANALYSIS.md` for the authoritative flow and activation checklist.
GPU-specific guidance below describes the earlier pipeline, not the current default.
The active Modal worker uses the website job API and does **not** receive database
credentials. PostgreSQL connection instructions below apply only to the legacy worker.

## Status

These files prepare the imported app for this hosting split. They do **not**
mean the website or worker has been published, or that video analysis has been
verified on Modal.

The website remains the existing Next.js app in `web/`; the Replit artifact in
`artifacts/football-vision` only starts and builds it. The worker remains the
existing `fa_worker` pipeline, hosted through `worker/modal_app.py`.

## Architecture

1. The website writes jobs to PostgreSQL and sends chunked video uploads directly
   to private Replit App Storage. See [REPLIT_STORAGE.md](REPLIT_STORAGE.md) for
   the current provider, worker access, and configuration.
2. Modal's CPU-only `dispatch` function checks the same database once per minute.
3. If a runnable job exists and the GPU function is not already busy or queued,
   it starts `process_one` on one L4 GPU.
4. `process_one` claims one job using the existing database lease and heartbeat,
   and writes results back using the existing fenced transactions.
5. The GPU scales to zero between work. The CPU scheduler and storage still
   have their own charges. There is no anonymous/public worker endpoint.

Initial processing can take an extra minute plus image/model cold-start time.
Preparation jobs also use the GPU container in this initial configuration.
One GPU job runs at a time. Retries follow the existing queue's backoff.
The function has an 18-hour execution ceiling to accommodate the pipeline's
existing 4x-video-length timeout, including the internal test plan. This is an
upper bound, not an expected processing time or a spending limit.
Model downloads persist in a Modal Volume; customer footage is downloaded only
to temporary per-invocation storage and removed afterward.

## Credentials and isolation

### Replit

Configure production login and the website's production configuration:

- Managed Clerk: `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are provisioned
  through Replit, with the proxy service at `/api/__clerk`.
- `APP_ORIGIN`: the actual website origin (HTTPS, no path).
- `DATABASE_URL`: Replit supplies the database for this environment.
- `STORAGE_PROVIDER=replit` and Replit-provisioned `PRIVATE_OBJECT_DIR`.
- `WORKER_STORAGE_TOKEN`: a dedicated random service key, at least 32 characters.
  This must also be configured in Modal. No S3 credentials are needed.

The Modal CLI uses `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` from Replit Secrets.
Those account credentials must never be sent to the browser or worker image.

### Modal

Before deploying, create a named Modal Secret **football-vision-production** in
Modal's Secrets panel. It must contain:

- `DATABASE_URL`: the **production** PostgreSQL connection string, reachable
  from Modal. Do not use localhost, an internal hostname, or the development DB.
- `STORAGE_PROVIDER=replit`.
- `WORKER_STORAGE_URL`: the published website's `/api/internal/worker-storage` HTTPS URL.
- `WORKER_STORAGE_TOKEN`: the same dedicated service key configured in Replit.
- Optional: `WORKER_SAMPLE_FPS` (default 4), `WORKER_DETECTOR_SIZE` (default medium).

Keep credentials out of command arguments, logs, code, and chat. Use a dedicated
database role with the permissions needed by the existing queue and maintenance
code. Worker storage access is mediated by the authenticated website broker.
TLS and external database connectivity must be verified before enabling schedules.

For development, use a **different database, storage namespace, and secret**, such as
`football-vision-development`. Select the secret with `FOOTBALL_MODAL_SECRET`.
Never point a development worker at the production queue.

## Storage setup

Replit App Storage is provisioned through the workspace. Files remain in its
private directory, with separate development and production namespaces.
The app handles signed-URL CORS and verified part receipts without requiring a
bucket CORS policy change. See REPLIT_STORAGE.md for details.
Do not use local SeaweedFS/Docker settings from `.env.example` in production.

## Publishing order

1. Configure login, storage, and the development DB; verify the website and a
   small upload in preview.
2. Build and validate the website. Replit's Publish flow manages its production
   schema; do not add production migration commands to startup/build hooks.
3. The project owner clicks **Publish** in Replit and configures `APP_ORIGIN`
   for the actual published URL. Verify production sign-in.
4. Configure Modal's production secret with the published app's production DB
   and the shared worker storage key. Ensure Modal has a payment method for GPU usage.
5. From the project root, deploy the Modal application:

   ```sh
   python3 -m modal deploy football_vision/worker/modal_app.py
   ```

   Deployment builds the images and activates the CPU schedule immediately.
   Runnable jobs can then start paid GPU processing.

6. Upload a small known clip, finish pitch calibration, and verify that progress,
   results, and errors appear in the website. This live check is required before
   calling the end-to-end pipeline verified.

To disable polling and stop new GPU work:

```sh
python3 -m modal app stop football-vision-replit
```

Check Modal's Apps dashboard for job logs and GPU usage. Logs must not include
database connection strings, signed media URLs, or secrets.

## Local adapter checks

From the project root:

```sh
python3 -m unittest discover -s football_vision/worker/deployment_tests -v
```

These mock the queue, storage, and Modal invocations. They verify dispatch and
GPU safeguards without cloud charges; they do not validate image builds,
production connectivity, or real-footage accuracy.
