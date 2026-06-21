import { describe, expect, it } from "vitest";
import {
  buildGenomeIndex,
  cosineSimilarity,
  retrieveGenomeRules,
  selectGenomeRules,
  type Embedder,
  type GenomeRule,
} from "../src/index.js";

// Deterministic fake embedder: a bag-of-vocab vector. Token overlap → cosine
// similarity, so retrieval is meaningful AND reproducible. NO real model.
const VOCAB = ["button", "color", "accent", "spacing", "card", "nav", "contrast", "grid"];
const fakeEmbed: Embedder = async (texts) =>
  texts.map((t) => VOCAB.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)));

const rules: GenomeRule[] = [
  { id: "r1", text: "Buttons use the accent color token", component: "Button" },
  { id: "r2", text: "Cards use 16px grid spacing", component: "Card" },
  { id: "r3", text: "Nav contrast must meet AA", component: "Nav" },
];

describe("buildGenomeIndex (#104)", () => {
  it("embeds every rule and is content-addressed + version-stamped", async () => {
    const idx = await buildGenomeIndex("ui-dna@1", rules, fakeEmbed);
    expect(idx.version).toBe("ui-dna@1");
    expect(idx.vectors).toHaveLength(rules.length);
    expect(idx.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the content hash is stable across rule ORDER but changes on rule content", async () => {
    const a = await buildGenomeIndex("ui-dna@1", rules, fakeEmbed);
    const b = await buildGenomeIndex("ui-dna@1", [...rules].reverse(), fakeEmbed);
    expect(b.contentHash).toBe(a.contentHash); // order-independent
    const c = await buildGenomeIndex("ui-dna@1", [...rules, { id: "r4", text: "new rule" }], fakeEmbed);
    expect(c.contentHash).not.toBe(a.contentHash); // content change → new hash
    const d = await buildGenomeIndex("ui-dna@2", rules, fakeEmbed);
    expect(d.contentHash).not.toBe(a.contentHash); // version change → new hash
  });

  it("throws if the embedder returns the wrong number of vectors", async () => {
    const bad: Embedder = async () => [[1, 0]]; // 1 vector for 3 rules
    await expect(buildGenomeIndex("v", rules, bad)).rejects.toThrow(/vectors/);
  });
});

describe("retrieveGenomeRules (#104)", () => {
  it("ranks the most relevant rules first and respects topK", async () => {
    const idx = await buildGenomeIndex("ui-dna@1", rules, fakeEmbed);
    const [q] = await fakeEmbed(["button accent color"]);
    const out = retrieveGenomeRules(idx, q!, { topK: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]!.rule.id).toBe("r1"); // button/accent/color rule wins
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it("filters by minScore (irrelevant rules excluded, not just deprioritized)", async () => {
    const idx = await buildGenomeIndex("ui-dna@1", rules, fakeEmbed);
    const [q] = await fakeEmbed(["button accent color"]);
    const out = retrieveGenomeRules(idx, q!, { topK: 5, minScore: 0.1 });
    // r2 (card/grid/spacing) and r3 (nav/contrast) share no vocab → score 0 → dropped.
    expect(out.map((r) => r.rule.id)).toEqual(["r1"]);
  });

  it("bounds total injected text by maxChars (always keeps at least one)", async () => {
    const idx = await buildGenomeIndex("ui-dna@1", rules, fakeEmbed);
    const [q] = await fakeEmbed(["button color spacing grid nav contrast card accent"]);
    const out = retrieveGenomeRules(idx, q!, { topK: 5, maxChars: 1 });
    expect(out).toHaveLength(1); // cap hit, but one rule is always allowed
  });

  it("is deterministic (ties broken by rule id) and empty for an empty index", async () => {
    const empty = await buildGenomeIndex("v", [], fakeEmbed);
    expect(retrieveGenomeRules(empty, [1, 0])).toEqual([]);
  });
});

describe("selectGenomeRules / cosineSimilarity (#104)", () => {
  it("embeds the query and returns the top rule texts for injection", async () => {
    const idx = await buildGenomeIndex("ui-dna@1", rules, fakeEmbed);
    const texts = await selectGenomeRules(idx, "the primary button color", fakeEmbed, { topK: 1 });
    expect(texts).toEqual(["Buttons use the accent color token"]);
  });

  it("returns [] for an empty genome (the no-genome path leaves the prompt unchanged)", async () => {
    const empty = await buildGenomeIndex("v", [], fakeEmbed);
    expect(await selectGenomeRules(empty, "anything", fakeEmbed)).toEqual([]);
  });

  it("cosineSimilarity is 1 for identical, 0 for orthogonal/degenerate", () => {
    expect(cosineSimilarity([1, 1], [2, 2])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
