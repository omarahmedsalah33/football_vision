import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  redact: {
    paths: [
      "*.authorization",
      "*.cookie",
      "*.password",
      "*.secret",
      "*.token",
      "*.url", // presigned URLs carry signatures
      "*.urls",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    censor: "[redacted]",
  },
});
