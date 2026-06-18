import { describe, expect, it } from "vitest";
import { activeDimensions, buildSystemPrompt, RUBRIC_ORDER } from "../src/index.js";

describe("buildSystemPrompt (#30)", () => {
  it("covers all eight rubric dimensions when a brand block exists", () => {
    const prompt = buildSystemPrompt({ brandPresent: true });
    for (const dim of RUBRIC_ORDER) expect(prompt).toContain(dim);
    expect(activeDimensions(true)).toHaveLength(8);
  });

  it("suppresses the brand dimension when there is no brand block", () => {
    expect(activeDimensions(false)).not.toContain("brand");
    const prompt = buildSystemPrompt({ brandPresent: false });
    expect(prompt).toContain("brand dimension is suppressed");
    // The brand rubric line is gone, but the suppression note explains why.
    expect(prompt).not.toMatch(/- brand:/);
  });

  it("states the anti-hallucination rules (grounding, no hover/focus/animation, lower confidence)", () => {
    const prompt = buildSystemPrompt({ brandPresent: true });
    expect(prompt).toMatch(/grounded|geometry|element_ref/i);
    expect(prompt).toMatch(/hover, focus, active, or animation/i);
    expect(prompt).toMatch(/LOWER the confidence/);
    expect(prompt).toMatch(/captured image segment/i);
  });

  it("appends component-library addenda when present", () => {
    const prompt = buildSystemPrompt({
      brandPresent: false,
      componentAddenda: ["shadcn/ui: CSS-variable themed over Radix."],
    });
    expect(prompt).toContain("COMPONENT-LIBRARY CONTEXT");
    expect(prompt).toContain("shadcn/ui: CSS-variable themed over Radix.");
  });
});
