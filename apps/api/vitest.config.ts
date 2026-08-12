import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs once, before any suite file — see test/global-setup.ts for why the
    // citext install has to happen outside the parallel phase.
    globalSetup: ["./test/global-setup.ts"],
  },
});
