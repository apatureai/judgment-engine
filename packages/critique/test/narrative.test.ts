import { describe, expect, it } from "vitest";
import { reconcileNarrative } from "../src/index.js";

/**
 * The narrative-vs-findings reconciliation (#1).
 *
 * The defect these tests pin: a result whose every finding the grounding gate
 * deleted still published the model's paragraph as its narrative, so a reader
 * met "the hero block is misaligned and the CTA is off-grid" under grade Ship
 * with an empty findings list. Both halves came from the same engine and they
 * contradicted each other.
 */

const MODEL_PROSE = "The hero block is misaligned and the CTA is off-grid.";

describe("reconcileNarrative leaves a grounded narrative alone", () => {
  it("returns the model's prose byte-identical when nothing was deleted", () => {
    const out = reconcileNarrative({
      overall: MODEL_PROSE,
      modelFindingsSeen: 3,
      survivingFindings: 3,
      hallucinationDrops: 0,
    });
    expect(out.overall).toBe(MODEL_PROSE);
    expect(out.ungroundedNarrative).toBeUndefined();
  });

  it("returns it unchanged when the model produced no findings at all", () => {
    // A clean page: the model wrote a summary and had nothing to report. There
    // is nothing to reconcile, and inventing a caveat here would be noise on the
    // commonest good result there is.
    const out = reconcileNarrative({
      overall: "Everything on this page lines up.",
      modelFindingsSeen: 0,
      survivingFindings: 0,
      hallucinationDrops: 0,
    });
    expect(out.overall).toBe("Everything on this page lines up.");
    expect(out.ungroundedNarrative).toBeUndefined();
  });
});

describe("reconcileNarrative when EVERY finding was deleted", () => {
  const out = reconcileNarrative({
    overall: MODEL_PROSE,
    modelFindingsSeen: 2,
    survivingFindings: 0,
    hallucinationDrops: 2,
  });

  it("replaces the narrative with a statement of what actually happened", () => {
    expect(out.overall).toContain("No finding in this review survived validation");
    expect(out.overall).toContain("The model produced 2 finding(s) and all 2 were deleted");
    expect(out.overall).toContain("2 for citing a route or element that was never captured");
  });

  it("does not let the model's claim read as a description of the page", () => {
    expect(out.overall).not.toContain("hero block is misaligned");
  });

  it("preserves the model's claim verbatim rather than deleting it", () => {
    // Deleting it would be its own dishonesty: what the model said is the most
    // useful thing this engine knows about its own judge.
    expect(out.ungroundedNarrative).toBe(MODEL_PROSE);
  });

  it("names the trust budget separately when it, not the gate, did the deleting", () => {
    const filtered = reconcileNarrative({
      overall: MODEL_PROSE,
      modelFindingsSeen: 2,
      survivingFindings: 0,
      hallucinationDrops: 0,
    });
    expect(filtered.overall).toContain("2 by the confidence floor and trust budget");
    expect(filtered.overall).not.toContain("never captured");
  });

  it("splits the count when both stages deleted some", () => {
    const both = reconcileNarrative({
      overall: MODEL_PROSE,
      modelFindingsSeen: 5,
      survivingFindings: 0,
      hallucinationDrops: 3,
    });
    expect(both.overall).toContain("3 for citing a route or element that was never captured");
    expect(both.overall).toContain("2 by the confidence floor and trust budget");
  });

  it("says the model wrote nothing rather than recording an empty narrative", () => {
    const silent = reconcileNarrative({
      overall: "   ",
      modelFindingsSeen: 1,
      survivingFindings: 0,
      hallucinationDrops: 1,
    });
    expect(silent.overall).toContain("The model wrote no summary.");
    expect(silent.ungroundedNarrative).toBeUndefined();
  });
});

describe("reconcileNarrative on a PARTIAL deletion", () => {
  // Decided deliberately: some findings survived, so the narrative may describe
  // real defects on a real page, and nothing in the payload says which sentence
  // covers which finding. Moving it wholesale would discard true description;
  // leaving it bare would let deleted findings keep their prose. So it stays,
  // caveated.
  const out = reconcileNarrative({
    overall: MODEL_PROSE,
    modelFindingsSeen: 3,
    survivingFindings: 1,
    hallucinationDrops: 2,
  });

  it("keeps the model's prose, because part of it still describes the page", () => {
    expect(out.overall).toContain(MODEL_PROSE);
    expect(out.ungroundedNarrative).toBeUndefined();
  });

  it("caveats it with the counts", () => {
    expect(out.overall).toContain("2 of the 3 finding(s) the model reported were deleted");
    expect(out.overall).toContain("2 for citing a route or element that was never captured");
  });

  it("PREPENDS the caveat, so a consumer that truncates for display cannot cut it off", () => {
    // Gate caps this field before rendering it in a Check Run summary. A caveat
    // that can be truncated away is not a caveat.
    expect(out.overall.startsWith("Caveat:")).toBe(true);
    expect(out.overall.indexOf("Caveat:")).toBeLessThan(out.overall.indexOf(MODEL_PROSE));
  });

  it("still caveats when the model wrote no summary at all", () => {
    const silent = reconcileNarrative({
      overall: "",
      modelFindingsSeen: 3,
      survivingFindings: 1,
      hallucinationDrops: 2,
    });
    expect(silent.overall.startsWith("Caveat:")).toBe(true);
    expect(silent.overall.trimEnd().endsWith("not in this result.")).toBe(true);
  });
});

describe("reconcileNarrative is defensive about impossible counts", () => {
  it("treats more survivors than the model produced as nothing deleted", () => {
    const out = reconcileNarrative({
      overall: MODEL_PROSE,
      modelFindingsSeen: 1,
      survivingFindings: 4,
      hallucinationDrops: 0,
    });
    expect(out.overall).toBe(MODEL_PROSE);
  });

  it("never attributes more drops to the gate than were deleted in total", () => {
    const out = reconcileNarrative({
      overall: MODEL_PROSE,
      modelFindingsSeen: 2,
      survivingFindings: 1,
      hallucinationDrops: 99,
    });
    expect(out.overall).toContain("1 for citing a route or element that was never captured");
    expect(out.overall).not.toContain("99");
    expect(out.overall).not.toContain("trust budget");
  });

  it("does not fire on negative counts", () => {
    const out = reconcileNarrative({
      overall: MODEL_PROSE,
      modelFindingsSeen: -3,
      survivingFindings: 0,
      hallucinationDrops: 0,
    });
    expect(out.overall).toBe(MODEL_PROSE);
  });
});
