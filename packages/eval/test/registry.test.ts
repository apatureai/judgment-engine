import { pgliteExecutor, runMigrations } from "@engine/db";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { ModelPromptRegistry, type RegistryStamp } from "../src/index.js";

let registry: ModelPromptRegistry;

const stamp = (over: Partial<RegistryStamp> = {}): RegistryStamp => ({
  model: "qwen3-vl-plus",
  promptVersion: "v1",
  engineVersion: "1.0.0",
  captureVersion: "c1",
  ...over,
});

beforeEach(async () => {
  const db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  registry = new ModelPromptRegistry(pgliteExecutor(db));
});

describe("ModelPromptRegistry (#71)", () => {
  it("registers a candidate and refuses promotion without a passing eval", async () => {
    const cand = await registry.registerCandidate(stamp());
    expect(cand.status).toBe("candidate");
    await expect(registry.promote(cand.id)).rejects.toThrow(/eval gate has not passed/);
  });

  it("promotes a candidate that passed eval to the single stable version", async () => {
    const cand = await registry.registerCandidate(stamp());
    await registry.recordEval(cand.id, true);
    const promoted = await registry.promote(cand.id);
    expect(promoted.status).toBe("stable");
    expect((await registry.current())?.id).toBe(cand.id);
  });

  it("a new promotion demotes the prior stable (at most one stable)", async () => {
    const a = await registry.registerCandidate(stamp({ promptVersion: "v1" }));
    await registry.recordEval(a.id, true);
    await registry.promote(a.id);

    const b = await registry.registerCandidate(stamp({ promptVersion: "v2" }));
    await registry.recordEval(b.id, true);
    await registry.promote(b.id);

    const current = await registry.current();
    expect(current?.id).toBe(b.id);
    expect((await registry.get(a.id))?.status).toBe("rolled_back");
  });

  it("rolls back to the previous stable version", async () => {
    const a = await registry.registerCandidate(stamp({ promptVersion: "v1" }));
    await registry.recordEval(a.id, true);
    await registry.promote(a.id);
    const b = await registry.registerCandidate(stamp({ promptVersion: "v2" }));
    await registry.recordEval(b.id, true);
    await registry.promote(b.id);

    const restored = await registry.rollback();
    expect(restored?.id).toBe(a.id); // back to the last stable
    expect((await registry.current())?.id).toBe(a.id);
    expect((await registry.get(b.id))?.status).toBe("rolled_back");
  });
});
