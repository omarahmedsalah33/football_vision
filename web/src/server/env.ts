import { z } from "zod";

// Server-side configuration, validated once. Fails fast with the names (never the values) of
// missing or malformed variables.
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url(),
  STORAGE_PROVIDER: z.enum(["s3", "replit"]).default("s3"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(3).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
}).superRefine((value, ctx) => {
  if (value.STORAGE_PROVIDER === "s3") {
    for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (!value[key]) ctx.addIssue({ code: "custom", path: [key], message: "Required for S3 storage" });
    }
  } else if (!process.env.PRIVATE_OBJECT_DIR) {
    ctx.addIssue({ code: "custom", path: ["PRIVATE_OBJECT_DIR"], message: "Required for Replit storage" });
  }
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Startup/database checks don't need storage credentials; uploads still require the full env. */
export function databaseUrl(): string {
  const parsed = z.object({ DATABASE_URL: z.string().url() }).safeParse(process.env);
  if (!parsed.success) throw new Error("Invalid server configuration: DATABASE_URL");
  return parsed.data.DATABASE_URL;
}

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid server configuration: ${names}`);
  }
  cached = parsed.data;
  return cached;
}
