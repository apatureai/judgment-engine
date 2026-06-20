import type { RepoContext } from "@engine/types";
import { describe, expect, it } from "vitest";
import {
  critique,
  DEFAULT_PASS_MODELS,
  MockModelClient,
  resolvePassModel,
  type ModelClientFactory,
} from "../src/index.js";

const context: RepoContext = {
  installationId: "1",
  repository: { owner: "acme", name: "web", defaultBranch: "main" },
  brand: null,
  tokens: {},
  uiDnaVersion: "ui-dna@2026.06.12",
  contentHash: "abc",
};

describe("critique (per-pass model abstraction)", () => {
  it("returns a version-stamped Critique implementing the core contract", async () => {
    const result = await critique([], context, { depth: "deep" });
    expect(["ship", "ship_with_nits", "needs_work", "blocked"]).toContain(result.grade);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.metadata.uiDnaVersion).toBe("ui-dna@2026.06.12");
    expect(result.metadata.engineVersion).toBeTruthy();
    expect(result.validation.hallucinationDrops).toBe(0);
  });

  it("stamps the default per-pass model (triage=flash, deep=plus)", async () => {
    expect((await critique([], context, { depth: "triage" })).metadata.model).toBe("qwen3-vl-flash");
    expect((await critique([], context, { depth: "deep" })).metadata.model).toBe("qwen3-vl-plus");
    expect(DEFAULT_PASS_MODELS.deep.thinking).toBe(true);
  });

  it("swaps the model by config with no call-site change", async () => {
    const result = await critique([], context, { depth: "deep" }, {
      passModels: { deep: { model: "claude-opus-vision", backend: "self-host" } },
    });
    expect(result.metadata.model).toBe("claude-opus-vision");
  });

  it("routes through an injected ModelClient with the resolved pass settings", async () => {
    const mock = new MockModelClient("dashscope");
    const factory: ModelClientFactory = () => mock;
    await critique([], context, { depth: "deep" }, { modelFactory: factory });

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.model).toBe("qwen3-vl-plus");
    expect(mock.calls[0]?.thinking).toBe(true); // deep -> Thinking pass
  });
});

describe("resolvePassModel", () => {
  it("applies overrides over the defaults", () => {
    expect(resolvePassModel("triage")).toEqual(DEFAULT_PASS_MODELS.triage);
    expect(resolvePassModel("triage", { triage: { backend: "self-host" } })).toEqual({
      model: "qwen3-vl-flash",
      backend: "self-host",
      thinking: false,
    });
  });
});
