import { sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { AppError } from "./errors";

export type Limit = { name: string; perMinute: number };

export const LIMITS = {
  createMatch: { name: "match.create", perMinute: 30 },
  startUpload: { name: "upload.start", perMinute: 10 },
  presignParts: { name: "upload.presign", perMinute: 240 },
  completeUpload: { name: "upload.complete", perMinute: 30 },
  analysis: { name: "analysis", perMinute: 20 },
  createOrg: { name: "org.create", perMinute: 5 },
} satisfies Record<string, Limit>;

/** Counts one request against `subject` and throws 429 when the per-minute budget is spent. */
export async function enforceRateLimit(db: DbOrTx, limit: Limit, subject: string): Promise<void> {
  const key = `${limit.name}:${subject}`;
  const result = await db.execute<{ count: number }>(sql`
    insert into rate_limit_buckets (key, window_start, count)
    values (${key}, date_trunc('minute', now()), 1)
    on conflict (key) do update set
      count = case when rate_limit_buckets.window_start = excluded.window_start
                   then rate_limit_buckets.count + 1 else 1 end,
      window_start = excluded.window_start
    returning count`);
  if (Number(result.rows[0]?.count) > limit.perMinute) {
    throw new AppError(429, "rate_limited", "Too many requests. Please wait a minute and try again.");
  }
}
