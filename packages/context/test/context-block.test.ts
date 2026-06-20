import { describe, expect, it } from "vitest";
import {
  buildContextBlock,
  CONTEXT_VERSION,
  serializeContextBlock,
  type ContextBlockInput,
} from "../src/index.js";

const base: ContextBlockInput = {
  tokens: { "color.b": "#000", "color.a": "#fff" },
  brand: { description: "calm app", tone: null, audience: null, do: ["x"], dont: [] },
  componentLibraries: [{ id: "radix", rubricAddendum: "radix note" }],
  uiDnaVersion: "ui-dna@2026.06.12",
  routes: ["/pricing", "/"],
};

describe("serializeContextBlock", () => {
  it("is byte-identical regardless of input key/array ordering", () => {
    const a = serializeContextBlock(base);
    const reordered: ContextBlockInput = {
      uiDnaVersion: "ui-dna@2026.06.12",
      routes: ["/", "/pricing"],
      componentLibraries: [{ id: "radix", rubricAddendum: "radix note" }],
      brand: { dont: [], do: ["x"], audience: null, tone: null, description: "calm app" },
      tokens: { "color.a": "#fff", "color.b": "#000" },
    };
    expect(serializeContextBlock(reordered)).toBe(a);
    // No wall-clock timestamps leak in.
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("buildContextBlock content-hash", () => {
  it("stamps the context version and a stable content hash", () => {
    const block = buildContextBlock(base);
    expect(block.contextVersion).toBe(CONTEXT_VERSION);
    expect(block.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Same input -> same hash (cache stays warm).
    expect(buildContextBlock(base).contentHash).toBe(block.contentHash);
  });

  it("invalidates (hash changes) when any token or config input changes", () => {
    const original = buildContextBlock(base).contentHash;
    const tokenChange = buildContextBlock({
      ...base,
      tokens: { ...base.tokens, "color.a": "#eee" },
    }).contentHash;
    const brandChange = buildContextBlock({ ...base, brand: null }).contentHash;

    expect(tokenChange).not.toBe(original);
    expect(brandChange).not.toBe(original);
  });
});
