import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["vitest.setup.ts"],
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    coverage: {
      provider: "v8",
      include: ["packages/**/*.ts"],
      exclude: [
        "packages/**/*.test.ts",
        "packages/testing/**",
        "packages/*/src/bin/**",
        "packages/globu-cli/src/cli/process-io.ts"
      ],
      // Enforced off Windows only: the branches for the other platforms are not reached there.
      thresholds:
        process.platform === "win32"
          ? {}
          : {
              statements: 100,
              branches: 100,
              functions: 100,
              lines: 100
            }
    }
  }
});
