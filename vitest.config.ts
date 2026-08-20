import { defineConfig } from "vitest/config";

/**
 * This package's own suite, and nothing else.
 *
 * `.trash/` holds working copies of other repositories - the HMAC core is cloned
 * there to be read - and their suites are theirs. Run in with ours they inflate the
 * count, and a failure in one of them would read as a failure here.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".trash/**", "poc/**", "dist/**"],
  },
});
