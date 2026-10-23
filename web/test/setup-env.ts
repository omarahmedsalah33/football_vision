import { config } from "dotenv";

config({ path: ".env", quiet: true });
// Integration tests always run against the dedicated test database.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
(process.env as Record<string, string>).NODE_ENV = "test";
if (process.env.TEST_S3_BUCKET) process.env.S3_BUCKET = process.env.TEST_S3_BUCKET;
