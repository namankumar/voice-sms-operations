import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["services/**/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
