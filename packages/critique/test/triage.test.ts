import { describe, expect, it } from "vitest";
import {
  allUnchanged,
  runTriage,
  type ModelClient,
  type ModelResponse,
  type TriageRoute,
} from "../src/index.js";

const route = (over: Partial<TriageRoute> = {}): TriageRoute => ({
  route: "/pricing",
  currentPhash: "ffff",
  aboveFoldImages: [{ objectKey: "jobs/1/s/p.png", route: "/pricing", viewport: "desktop" }],
  ...over,
});

function clientReturning(json: unknown): ModelClient {
  return {
    backend: "mock",
    async complete(): Promise<ModelResponse> {
      return { text: JSON.stringify(json), usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
    },
  };
}

describe("allUnchanged (#28 short-circuit)", () => {
  it("is true only when every route has a baseline within threshold", () => {
    expect(allUnchanged([route({ baselinePhash: "ffff", currentPhash: "fffe" })], 5)).toBe(true);
    expect(allUnchanged([route({ baselinePhash: "0000", currentPhash: "ffff" })], 5)).toBe(false);
    expect(allUnchanged([route({ baselinePhash: undefined })], 5)).toBe(false); // no baseline
    expect(allUnchanged([], 5)).toBe(false);
  });
});

describe("runTriage", () => {
  it("short-circuits with a one-line result when phash matches the baseline (no model call)", async () => {
    let called = false;
    const client: ModelClient = {
      backend: "mock",
      async complete() {
        called = true;
        return { text: "{}", usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
      },
    };
    const result = await runTriage({ client, model: "qwen3-vl-flash" }, [
      route({ baselinePhash: "ffff", currentPhash: "ffff" }),
    ]);
    expect(result.shortCircuited).toBe(true);
    expect(result.needsDeepReview).toBe(false);
    expect(result.summary).toMatch(/no design changes/i);
    expect(called).toBe(false); // never spent a model call
  });

  it("runs the flash model on changes and emits the triage decision", async () => {
    const client = clientReturning({
      needsDeepReview: true,
      suspectRoutes: ["/pricing"],
      obviousBreakage: ["nav overlaps hero on mobile"],
    });
    const result = await runTriage({ client, model: "qwen3-vl-flash" }, [
      route({ baselinePhash: "0000", currentPhash: "ffff" }),
    ]);
    expect(result.shortCircuited).toBe(false);
    expect(result.needsDeepReview).toBe(true);
    expect(result.suspectRoutes).toEqual(["/pricing"]);
    expect(result.obviousBreakage).toContain("nav overlaps hero on mobile");
  });

  it("folds deterministic breakage (#19) in and forces deep review", async () => {
    const client = clientReturning({ needsDeepReview: false, suspectRoutes: [], obviousBreakage: [] });
    const result = await runTriage({ client, model: "qwen3-vl-flash" }, [
      route({ currentPhash: "ffff", deterministicBreakage: ["content overflow on /pricing"] }),
    ]);
    expect(result.obviousBreakage).toContain("content overflow on /pricing");
    expect(result.needsDeepReview).toBe(true); // deterministic breakage forces it
  });
});
