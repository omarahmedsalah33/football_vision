import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["test/worker-api/*.test.ts", "test/storage/worker-analysis.test.ts"],
    testTimeout: 30000, hookTimeout: 30000 },
});
