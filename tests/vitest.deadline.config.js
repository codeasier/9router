import { mergeConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import base from "./vitest.config.js";

export default mergeConfig(base, {
  test: {
    setupFiles: [fileURLToPath(new URL("./setup/no-network.js", import.meta.url))],
  },
});
