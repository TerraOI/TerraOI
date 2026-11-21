import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/**/*.test.mjs",
      // T-211: `workers/` and `localbox/` hold real logic (the pull loop, the signer, the box), so
      // their tests run here too. Without this glob a test file in those folders is silently never
      // collected - the vacuous-pass trap COORDINATION §6b now names for pgTAP.
      "workers/**/*.test.ts",
      "localbox/**/*.test.ts",
    ],
    environment: "node",
  },
});
