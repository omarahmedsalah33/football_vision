# Football Vision

AI football match intelligence SaaS. Evidence-based analysis of fixed-camera match
footage: every metric carries its provenance (measured / estimated / inferred / unavailable) and links
back to the video.

- Architecture, decisions, threat model: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- What works, what's missing, known limitations: [docs/STATUS.md](docs/STATUS.md)

## Layout

| Path | What |
|---|---|
| `web/` | Next.js 16 app: marketing site, authenticated app, API, authorization, billing rules |
| `worker/` | Python analysis worker: claims jobs from Postgres, processes video |
| `infra/` | Local-only infrastructure config (dev credentials, never used in production) |
| `docker-compose.yml` | Local Postgres 17 + S3-compatible storage (SeaweedFS) |

## Local setup

Prerequisites: Docker Desktop, Node.js 24 LTS (npm 11), Python 3.12+.

```bash
# 1. Infrastructure (Postgres on 127.0.0.1:5433, S3 on 127.0.0.1:8333)
docker compose up -d

# 2. Web app
cd web
cp .env.example .env          # used by tests and scripts
cp .env.example .env.local    # used by `next dev`
npm install
npm run db:migrate
npm run dev                   # http://localhost:3000

# 3. Worker (separate terminal)
cd worker
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # Windows; use .venv/bin/python elsewhere
cp .env.example .env
.venv/Scripts/python -m fa_worker.main              # add --once to drain the queue and exit
```

### Authentication keys (Clerk)

Sign-in needs Clerk keys in `web/.env.local`. For local development, temporary keys for an
unclaimed development app can be created without an account. Do not run `clerk init` inside this
repo, because it rewrites `src/proxy.ts` and the auth pages. Run it in an empty scratch Next.js
project instead, and copy only the `*CLERK*` lines into `web/.env.local`. For a permanent setup,
create an application at dashboard.clerk.com and paste its development keys.

## Checks

```bash
cd web && npm run check        # typecheck, lint, 64 unit+integration tests, production build
cd worker && .venv/Scripts/python -m pytest      # 30 tests (queue, validation, pipeline)
```

Browser end-to-end tests (real sign-in, upload and worker run; needs Clerk keys in `.env.local`
and the worker venv):

```bash
cd web && npx playwright install chromium   # first time only
npm run e2e                                 # screenshots land in web/test-results/screenshots
```

Integration tests need `docker compose up -d`. They use separate databases
(`footballanalyzer_test`, `footballanalyzer_worker_test`) and a separate bucket (`fa-videos-test`).

End-to-end smoke test of upload → queue → worker, bypassing only sign-in:

```bash
cd web && npx tsx scripts/smoke-pipeline.mts path/to/video.mp4
cd ../worker && .venv/Scripts/python -m fa_worker.main --once
cd ../web && npx tsx scripts/smoke-pipeline.mts --status <matchId>
```
