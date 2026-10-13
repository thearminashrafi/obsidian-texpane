import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { obsidian: fileURLToPath(new URL("./test/stubs/obsidian.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"], testTimeout: 60000, hookTimeout: 60000 },
});
