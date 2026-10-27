# Private Replit App Storage

The user-selected storage provider is Replit App Storage; no Amazon S3 or
Cloudflare account is needed for this deployment.

## What changed

- The existing upload UI still uses retryable 16 MiB chunks sent **directly**
  to storage. Video bytes never pass through Next.js.
- Each upload has a private, random staging manifest bound to its final object.
- Completion checks every part's actual byte length and receipt, pins object
  generations, and composes the parts inside storage. Groups of at most 32
  components are combined recursively, supporting larger multi-part videos.
- The original total-size, file-signature, authorization, quota, and retention
  checks remain in effect.
- Some Replit buckets allow signed-URL CORS but do not expose `ETag` to browser
  JavaScript. The client obtains a verified receipt from an authenticated
  app endpoint when needed. That endpoint checks upload ownership and part size.
- Viewing frames and videos still requires an authorized app request; it
  returns an expiring signed URL. Files are not made public.
- A daily Modal CPU task removes temporary chunks older than 24 hours,
  including PUTs that finish after the user cancels an upload.

Signed URLs use capability authorization, not browser cookies. A bucket's
wildcard CORS setting does **not** make its objects publicly readable.

## Environment separation

The provisioned `PRIVATE_OBJECT_DIR` is extended with:

- `football-vision/development` for preview/test execution
- `football-vision/production` for published execution

The same logical database object keys can therefore never cross these storage
namespaces accidentally. Modal uses the appropriate website endpoint, not
Replit's local authentication sidecar.

## Website configuration

Replit provisions `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`, and
`PUBLIC_OBJECT_SEARCH_PATHS`. The app uses only the private directory.

Set `STORAGE_PROVIDER=replit`. The app still requires `DATABASE_URL`,
`APP_ORIGIN`, and its managed Clerk configuration. S3 keys are **not** required.
Use the actual published HTTPS origin for production `APP_ORIGIN`.

Set **WORKER_STORAGE_TOKEN** using Replit Secrets to a dedicated random value
of at least 32 characters. Never use a Clerk secret, database password, Modal API
token, or session secret in its place. It must match the value in Modal.

## Modal configuration

The named Modal Secret `football-vision-production` must contain:

| Key | Value |
| --- | --- |
| `DATABASE_URL` | The published app's externally reachable **production** PostgreSQL URL |
| `STORAGE_PROVIDER` | `replit` |
| `WORKER_STORAGE_URL` | `https://<actual-published-host>/api/internal/worker-storage` |
| `WORKER_STORAGE_TOKEN` | The same dedicated secret configured in the website |

Optional worker sampling/detector settings are unchanged.

The broker requires the dedicated key in `X-Worker-Storage-Token`. Clerk browser
sessions do not authorize worker access. It only signs source-video downloads
and the frame/track/player artifact paths used by the existing pipeline; a
worker cannot overwrite a source video through the upload operation.

No bucket credentials, Replit sidecar credentials, or Modal account tokens are
sent to a browser or stored in an image. Signed URLs are short-lived and must
never be logged. Rotating the shared key requires updating both hosts.

Deploy only after configuring the secret and verifying the production database:

```sh
python3 -m modal deploy football_vision/worker/modal_app.py
```

This activates schedules and can start paid GPU jobs. The local adapter tests
do not constitute a real GPU/video-analysis verification.

## Development checks

These commands do not start Modal compute:

```sh
pnpm --filter @workspace/football-vision-web exec vitest run --config vitest.storage.config.mts
python3 -m unittest discover -s football_vision/worker/deployment_tests -v
pnpm --filter @workspace/football-vision-web exec tsx scripts/check-replit-storage.ts
pnpm --filter @workspace/football-vision-web exec tsx scripts/check-replit-storage.ts --compose-tree
```

The last two commands explicitly create tiny temporary objects in the
development namespace, verify private direct uploads/downloads and server-side
composition, then clean up. The tree check uses 33 chunks to exercise composition
beyond GCS's 32-component per-request limit.

## Existing S3 installations

The original S3 adapter remains available with `STORAGE_PROVIDER=s3` and its
original credentials. Existing remote S3 files are **not migrated** automatically.
Do not change providers for a populated deployment without a separate migration.
