# Website analysis: Gemini + Astra on Modal

New analysis jobs use `engine: llm`. RF-DETR tracking is no longer a selectable or
default analysis. Completed legacy reports remain readable; existing queued tracking
jobs report that a new AI analysis is required rather than silently changing their meaning.

## Website workflow

1. Upload a video to private App Storage and wait for validation.
2. Select **Start AI analysis**. Pitch calibration is not required.
3. Modal claims a job through the authenticated website API, renewing its lease and
   reporting progress through that same API. Only the website connects to PostgreSQL.
4. Gemini builds scene-local Unknown reference labels using kit, jersey numbers, shoes
   and short-term motion, not faces. A fixed initial reference catalog may miss later
   substitutes; ambiguous players remain unassigned.
5. The entire duration, including the final partial minute, is analyzed in 20-second
   ownership windows with two seconds of context. Bounded failures split into shorter
   windows without changing source times, model or ten-fps input sampling.
6. Astra first sees selected source frames without Gemini's claims, then challenges
   action, identity and outcome separately. Its review budget is explicit (maximum 24
   selected events, not every event). For a full-sided roster, batch sizes shrink to
   stay within the image-request limit.
7. Gemini stands when Astra supports or is neutral. Explicit contradictions stay pending.
   A contradicted goal can still count as a shot. Existing Gemini confidence/evidence
   and attribution gates still apply; neutral does not turn a low-confidence Gemini
   proposal into a high-confidence one.
   Match action/outcome counts are separate from player attribution: an accepted goal
   can count for the match while its scorer remains unassigned.
8. Final player totals, per-minute statistics and source timestamps appear on the match
   page with playable video, reference photos, review comments and CSV/JSON downloads.

Counts are AI estimates, not certified exhaustive match statistics. Speed, distance,
dribbling success and pass-accuracy percentages are not fabricated.

## Hosting and activation

The website holds managed Gemini/OpenAI credentials. Modal never receives those keys:
it calls the website's dedicated-key, lease-fenced `/api/internal/worker-analysis` broker.
Only pinned Gemini 3.8 Flash / GPT-6 Astra requests are allowed. Modal handles decoding,
section preparation, durable orchestration, review and result persistence on CPU;
there is no paid GPU waiting for remote inference.

Activation order:

1. Publish the updated website. The current published site is
   `https://football-vision.replit.app`; the new route must be present there before the
   worker can claim jobs.
2. In Modal's secure Secrets panel create `football-vision-production-api` containing:
   - `WORKER_API_URL=https://football-vision.replit.app/api/internal/worker-jobs`;
   - `STORAGE_PROVIDER=replit`;
   - `WORKER_STORAGE_URL=https://football-vision.replit.app/api/internal/worker-storage`;
   - `WORKER_STORAGE_TOKEN`, matching the website's private worker key.
3. Deploy from the project root:
   `python -m modal deploy football_vision/worker/modal_app.py`.
4. Check the scheduler. Before website readiness it returns `waiting_for_website`;
   otherwise it starts one CPU worker only when a runnable job exists.

For secure scripted secret creation instead of manual entry in Modal, run
`python football_vision/worker/setup_modal.py --website-url https://football-vision.replit.app`.
The script copies only the existing worker key and endpoint settings into Modal without
printing credentials or placing them in command-line arguments. It refuses to overwrite
an existing secret. **No database connection string or model API keys go to Modal.**

The job endpoint exposes only validated claim, heartbeat, progress, checkpoint/output
registration, completion, failure, cancellation and maintenance operations—not SQL.
The website derives tenant IDs and output paths from the claimed job. It fences writes
on the active lease and commits results, terminal status and quota settlement together.
Its maintenance operations retain the existing 24-hour upload timeout, seven-day
deletion grace period, footage retention and terminal-checkpoint cleanup policies.

Development must use a separate Modal secret, website URL and storage namespace, selected
with `FOOTBALL_MODAL_SECRET`. Do not modify other Modal apps in the account.

## Recovery, privacy and usage

Successful model responses and bounded failures are saved as hash-verified private
`llm-*.json.gz` checkpoints within this job only. A new lease reuses successful requests;
failed long requests are remembered so they split instead of being billed repeatedly
on identical retries. A running HTTP request interrupted before a response was saved
cannot be guaranteed exactly-once provider billing.

Final results and job success commit together. Cancellation/lease loss cannot publish
apparently complete results. Output keys are registered before upload so retention
also covers interrupted jobs. Reference photos do not create CV track rows or assert
measured movement or persistent identity. All source video and reference images stay private.

Full-match processing can take hours and consume substantial paid AI usage. Read
worker progress rather than treating website request completion as match completion.
