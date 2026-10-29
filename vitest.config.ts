import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/tests/**/*.test.ts",
      "services/**/tests/**/*.test.ts",
      "apps/**/tests/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "evidence/**"],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
