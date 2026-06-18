import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@engine/types": fromRoot("./packages/types/src/index.ts"),
      "@engine/capture": fromRoot("./packages/capture/src/index.ts"),
      "@engine/critique": fromRoot("./packages/critique/src/index.ts"),
      "@engine/db": fromRoot("./packages/db/src/index.ts"),
      "@engine/redis": fromRoot("./packages/redis/src/index.ts"),
      "@engine/storage": fromRoot("./packages/storage/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
