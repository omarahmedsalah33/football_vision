// Runs once when a server instance starts, before it handles requests.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getDb } = await import("./server/db/client");
  const { migrationState } = await import("./server/db/migration-check");
  const { log } = await import("./server/log");

  const state = await migrationState(getDb());
  if (state.upToDate) return;

  const message =
    `Database schema is behind this build: ${state.applied} of ${state.expected} migrations applied. ` +
    "Run `npm run db:migrate` before starting the app.";
  // In production, refuse to serve traffic against the wrong schema; in development, be loud.
  if (process.env.NODE_ENV === "production") throw new Error(message);
  log.error({ ...state }, message);
}
