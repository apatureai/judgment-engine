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
  const noModelCall = () => {
    let called = false;
    const client: ModelClient = {
      backend: "mock",
      async complete() {
        called = true;
        return { text: "{}", usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
      },
    };
    return { client, wasCalled: () => called };
  };

  it("short-circuits only when phash matches AND the tile-wise diff confirms unchanged (no model call)", async () => {
    const { client, wasCalled } = noModelCall();
    const result = await runTriage({ client, model: "qwen3-vl-flash" }, [
      route({ baselinePhash: "ffff", currentPhash: "ffff", tileScores: [{ ssim: 1 }, { ssim: 0.999 }] }),
    ]);
    expect(result.shortCircuited).toBe(true);
    expect(result.needsDeepReview).toBe(false);
    expect(result.summary).toMatch(/no design changes/i);
    expect(wasCalled()).toBe(false); // never spent a model call
  });

  it("does NOT short-circuit on a phash match when a tile's SSIM is below threshold (#89 regression)", async () => {
    const client = clientReturning({ needsDeepReview: true, suspectRoutes: ["/pricing"], obviousBreakage: [] });
    // pHash identical (low-frequency-blind), but one tile changed (e.g. a button color tweak).
    const result = await runTriage({ client, model: "qwen3-vl-flash" }, [
      route({ baselinePhash: "ffff", currentPhash: "ffff", tileScores: [{ ssim: 1 }, { ssim: 0.5 }] }),
    ]);
    expect(result.shortCircuited).toBe(false);
    expect(result.needsDeepReview).toBe(true);
  });

  it("fails open to a deep review when a phash match has no sensitive-diff input", async () => {
    const client = clientReturning({ needsDeepReview: true, suspectRoutes: [], obviousBreakage: [] });
    const result = await runTriage({ client, model: "qwen3-vl-flash" }, [
      route({ baselinePhash: "ffff", currentPhash: "ffff" }), // no tileScores
    ]);
    expect(result.shortCircuited).toBe(false);
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

  it("omits json_object on the triage call when structuredOutput is false (#87 qwen3.5 caveat)", async () => {
    const seen: Array<string | undefined> = [];
    const client: ModelClient = {
      backend: "mock",
      async complete(req): Promise<ModelResponse> {
        seen.push(req.responseFormat);
        return {
          text: JSON.stringify({ needsDeepReview: true, suspectRoutes: [], obviousBreakage: [] }),
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          finishReason: "stop",
        };
      },
    };
    const changed = [route({ baselinePhash: "0000", currentPhash: "ffff" })];

    await runTriage({ client, model: "qwen3.5-flash-2026-02-23", structuredOutput: false }, changed);
    expect(seen[0]).toBeUndefined(); // no response_format requested

    await runTriage({ client, model: "qwen3-vl-flash" }, changed); // default keeps json_object
    expect(seen[1]).toBe("json_object");
  });
});
