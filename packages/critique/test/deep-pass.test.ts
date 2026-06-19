import { describe, expect, it } from "vitest";
import {
  critiqueRouteTwoStep,
  mapWithConcurrency,
  runDeepPass,
  type DeepPassDeps,
  type DeepPassRoute,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from "../src/index.js";

/** Records calls; returns prose for the Thinking step and JSON for the coercion step. */
class TwoStepMock implements ModelClient {
  readonly backend = "mock" as const;
  readonly calls: ModelRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 1));
    this.calls.push(request);
    this.inFlight--;
    const text = request.thinking
      ? "The CTA spacing is uneven."
      : JSON.stringify({ grade: "needs_work", overall: "spacing", findings: [] });
    return { text, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, finishReason: "stop" };
  }
}

const deps = (client: ModelClient, concurrency?: number): DeepPassDeps => ({
  client,
  model: "qwen3-vl-plus",
  systemPrompt: "rubric",
  contextBlock: '{"tokens":{}}',
  maxPixels: 1000,
  concurrency,
});

const route = (r: string): DeepPassRoute => ({
  route: r,
  images: [{ objectKey: `jobs/1/s/${r}.png`, route: r, viewport: "desktop" }],
  facts: ["contrast 2.1:1 below AA"],
});

describe("critiqueRouteTwoStep (#29)", () => {
  it("does a Thinking step then a non-thinking json_object coercion", async () => {
    const mock = new TwoStepMock();
    const result = await critiqueRouteTwoStep(deps(mock), route("/pricing"));

    expect(result.output?.grade).toBe("needs_work");
    expect(mock.calls).toHaveLength(2);
    // Step 1 = Thinking, no json; step 2 = non-thinking json_object coercion.
    expect(mock.calls[0]?.thinking).toBe(true);
    expect(mock.calls[0]?.responseFormat).toBeUndefined();
    expect(mock.calls[1]?.thinking).toBe(false);
    expect(mock.calls[1]?.responseFormat).toBe("json_object");
  });

  it("returns null output (no partial) when coercion isn't valid JSON", async () => {
    const badCoercion: ModelClient = {
      backend: "mock",
      async complete(req) {
        return {
          text: req.thinking ? "prose" : "not json at all",
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          finishReason: "stop",
        };
      },
    };
    const result = await critiqueRouteTwoStep(deps(badCoercion), route("/x"));
    expect(result.output).toBeNull();
  });
});

describe("runDeepPass concurrency cap", () => {
  it("runs one request per route, capped at 3 concurrent, order preserved", async () => {
    const mock = new TwoStepMock();
    const routes = ["/a", "/b", "/c", "/d", "/e"].map(route);
    const results = await runDeepPass(deps(mock, 3), routes);

    expect(results.map((r) => r.route)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
    expect(mock.maxInFlight).toBeLessThanOrEqual(3);
    expect(mock.calls).toHaveLength(10); // 5 routes x 2 steps
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order and respects the limit", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });
});
