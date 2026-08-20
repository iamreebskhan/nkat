import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest config for the Pallio Next.js app.
 *
 * Resolves `@/*` to the repo root so tests can import the same
 * paths the app does. Excludes legacy `backend/`, `frontend/`, and
 * `browser-extension/` since those have their own runners.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    include: [
      "lib/**/*.{test,spec}.ts",
      "components/**/*.{test,spec}.ts",
      // The drift checker's quote matching lives in scripts/ and has been the
      // single most error-prone code in the repo — every false-positive class
      // it has shipped (row citations, money formats, U+FFFD, page breaks) was
      // a matching rule. It is testable now that the script guards its own
      // entrypoint.
      "scripts/**/*.{test,spec}.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "backend/**",
      "frontend/**",
      "browser-extension/**",
      "infra/**",
      "loadtest/**",
      "db/**",
    ],
    environment: "node",
    // Prevent test code from accidentally hitting external APIs:
    // anthropic + openai + prisma all read env at first call. Tests
    // mock at module level — see lib/ai/__tests__ helpers.
  },
});
