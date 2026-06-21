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
      "@engine/secrets": fromRoot("./packages/secrets/src/index.ts"),
      "@engine/observability": fromRoot("./packages/observability/src/index.ts"),
      "@engine/jobs": fromRoot("./packages/jobs/src/index.ts"),
      "@engine/api": fromRoot("./packages/api/src/index.ts"),
      "@engine/context": fromRoot("./packages/context/src/index.ts"),
      "@engine/eval": fromRoot("./packages/eval/src/index.ts"),
      "@engine/feedback": fromRoot("./packages/feedback/src/index.ts"),
      "@engine/review": fromRoot("./packages/review/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
