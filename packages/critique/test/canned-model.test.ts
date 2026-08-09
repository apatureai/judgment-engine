import { describe, expect, it } from "vitest";
import {
  CannedModelClient,
  cannedModelFactory,
  parseCannedScript,
  runDeepPass,
  runTriage,
  type CannedScript,
} from "../src/index.js";

const SCRIPT: CannedScript = {
  triage: { needsDeepReview: true, suspectRoutes: ["/", "/pricing"], obviousBreakage: [] },
  routes: {
    "/": {
      grade: "needs_work",
      overall: "the dismiss control is too small",
      findings: [
        {
          dimension: "accessibility",
          severity: "major",
          confidence: 0.8,
          route: "/",
          viewport: "mobile",
          elementRef: "#icon-close",
          title: "Dismiss control is 28x28",
          description: "below the 44x44 minimum",
          suggestion: "pad it",
          introducedByThisPr: true,
        },
      ],
    },
  },
};

describe("parseCannedScript", () => {
  it("accepts a well-formed script and ignores documentation keys", () => {
    const parsed = parseCannedScript({ ...SCRIPT, _comment: ["notes"] });
    expect(parsed.ok).toBe(true);
  });

  it("reports why a malformed script was rejected", () => {
    const parsed = parseCannedScript({ triage: { needsDeepReview: "yes" }, routes: {} });
    expect(parsed).toMatchObject({ ok: false });
  });
});

describe("CannedModelClient", () => {
  it("answers the triage pass from the script", async () => {
    const client = new CannedModelClient(SCRIPT);
    const triage = await runTriage({ client, model: "canned" }, [
      { route: "/", currentPhash: "a", aboveFoldImages: [] },
    ]);
    expect(triage.needsDeepReview).toBe(true);
    expect(triage.suspectRoutes).toEqual(["/", "/pricing"]);
  });

  it("carries the route through the two-step deep pass so coercion finds it", async () => {
    const client = new CannedModelClient(SCRIPT);
    const [result] = await runDeepPass(
      { client, model: "canned", systemPrompt: "rubric", contextBlock: "{}", maxPixels: 1000 },
      [{ route: "/", images: [] }],
    );
    expect(result?.output?.grade).toBe("needs_work");
    expect(result?.output?.findings[0]?.elementRef).toBe("#icon-close");
    // Two calls per route: the thinking prose, then the json_object coercion.
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.responseFormat).toBeUndefined();
    expect(client.calls[1]?.responseFormat).toBe("json_object");
  });

  it("answers the self-host single-call guided-decoding path directly", async () => {
    const client = new CannedModelClient(SCRIPT);
    const [result] = await runDeepPass(
      {
        client,
        model: "canned",
        systemPrompt: "rubric",
        contextBlock: "{}",
        maxPixels: 1000,
        guidedDecoding: true,
      },
      [{ route: "/", images: [] }],
    );
    expect(client.calls).toHaveLength(1);
    expect(result?.output?.findings).toHaveLength(1);
  });

  it("returns an empty critique for a route the script does not cover", async () => {
    const client = new CannedModelClient(SCRIPT);
    const [result] = await runDeepPass(
      { client, model: "canned", systemPrompt: "rubric", contextBlock: "{}", maxPixels: 1000 },
      [{ route: "/unknown", images: [] }],
    );
    expect(result?.output?.findings).toEqual([]);
    expect(result?.output?.grade).toBe("ship");
  });

  it("honours an already-aborted signal", async () => {
    const client = cannedModelFactory(SCRIPT)({ backend: "mock" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.complete({ model: "canned", thinking: false, messages: [] }, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
  });
});
