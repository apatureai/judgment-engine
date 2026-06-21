import type {
  Capture,
  CaptureContext,
  CaptureImage,
  CaptureInSandbox,
  GeometryRect,
  Viewport,
} from "@engine/types";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelCallOptions,
  ModelBackend,
  PassModelConfig,
} from "@engine/critique";
import { buildGenomeIndex, type Embedder } from "@engine/context";
import { loadGoldenResult } from "@engine/types";
import { describe, expect, it } from "vitest";
import { runReview, type ReviewInput } from "../src/index.js";

// ---------------------------------------------------------------------------
// Stubs — NO real model / sandbox / browser / GPU. All live I/O is injected.
// ---------------------------------------------------------------------------

/** A model whose deep-pass json_object coercion returns a per-route critique. */
function scriptedModel(critiqueByRoute: (route: string) => unknown): {
  factory: (config: PassModelConfig) => ModelClient;
  calls: ModelRequest[];
} {
  const calls: ModelRequest[] = [];
  const client: ModelClient = {
    backend: "mock" as ModelBackend,
    async complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse> {
      if (options?.signal?.aborted) throw new Error("aborted");
      calls.push(request);
      let text: string;
      if (request.responseFormat === "json_object" || request.responseFormat === "json_schema") {
        // Triage call OR deep-pass coercion: distinguish by whether the prompt
        // mentions triaging. Triage system msg starts with "You are triaging".
        const system = request.messages.find((m) => m.role === "system")?.content ?? "";
        if (system.startsWith("You are triaging")) {
          // Triage: deep review warranted on every listed route.
          const userMsg = request.messages.find((m) => m.role === "user")?.content ?? "";
          const routes = userMsg.replace("Routes: ", "").split(", ").filter(Boolean);
          text = JSON.stringify({ needsDeepReview: true, suspectRoutes: routes, obviousBreakage: [] });
        } else {
          // Deep-pass coercion: the prior user message is the route's prose, which
          // we encoded as the route id so we can return that route's critique.
          const userMsg = request.messages.find((m) => m.role === "user")?.content ?? "";
          text = JSON.stringify(critiqueByRoute(userMsg));
        }
      } else {
        // Deep-pass thinking step: echo the route id (from "Review route X.") as
        // the prose, so the coercion step can route on it.
        const userMsg = request.messages.find((m) => m.role === "user")?.content ?? "";
        const m = /Review route (\S+?)\./.exec(userMsg);
        text = m ? (m[1] ?? "") : "prose";
      }
      return {
        text,
        thinkingText: request.thinking ? "thinking" : undefined,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        finishReason: "stop",
      };
    },
  };
  return { factory: () => client, calls };
}

const VIEWPORTS: Viewport[] = ["mobile", "desktop"];

function captureImagesFor(routes: string[]): CaptureImage[] {
  return routes.flatMap((route) =>
    VIEWPORTS.map((viewport) => ({
      route,
      viewport,
      objectKey: `cap/${route}/${viewport}.png`,
      width: 1280,
      height: 720,
    })),
  );
}

function geometryFor(routes: string[], selectors: string[]): GeometryRect[] {
  return routes.flatMap((route) =>
    VIEWPORTS.flatMap((viewport) =>
      selectors.map((selector) => ({
        route,
        viewport,
        selector,
        role: null,
        rect: { x: 0, y: 0, width: 100, height: 40 },
      })),
    ),
  );
}

/** Stub capture seam — deterministic, no browser. */
function stubCapture(routes: string[], selectors: string[], opts: { unstable?: boolean; empty?: boolean } = {}): CaptureInSandbox {
  return async (_url: string, _ctx: CaptureContext): Promise<Capture> => ({
    images: opts.empty ? [] : captureImagesFor(routes),
    geometry: opts.empty ? [] : geometryFor(routes, selectors),
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: opts.unstable ?? false },
    captureVersion: "stub-capture@1",
  });
}

/** Deterministic bag-of-tokens embedder — no model. */
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const lower = t.toLowerCase();
    return [
      lower.includes("pricing") ? 1 : 0,
      lower.includes("home") ? 1 : 0,
      lower.includes("button") || lower.includes("cta") ? 1 : 0,
      lower.length % 7,
    ];
  });

function baseInput(routes: string[], over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    url: "https://preview.example.test",
    depth: "deep",
    context: {
      tokens: { "color.accent": "#ff0066" },
      brand: null,
      componentLibraries: [],
      uiDnaVersion: "ui-dna@2026.06.12",
      routes,
    },
    captureContext: {
      installationId: "inst_1",
      viewports: VIEWPORTS,
      darkMode: false,
      isFork: false,
      routes,
    },
    routes: routes.map((route) => ({ route, currentPhash: "abc", facts: [`fact for ${route}`] })),
    wireOptions: { screenshotRetentionSeconds: 2_592_000 },
    ...over,
  };
}

// A valid CritiqueOutput row that survives the gate (route captured, elementRef
// in the geometry map, confidence above the 0.55 floor). `dimension`/`elementRef`
// default to a route-unique pair so two routes' findings don't dedupe together
// in the global post-filter (#33, which dedupes by dimension|elementRef).
function critiqueFor(
  route: string,
  severity: "major" | "minor" | "nit",
  grade: string,
  opts: { dimension?: string; elementRef?: string } = {},
): unknown {
  return {
    grade,
    overall: `Review of ${route}.`,
    findings: [
      {
        dimension: opts.dimension ?? "color_contrast",
        severity,
        confidence: 0.9,
        route,
        viewport: "mobile",
        elementRef: opts.elementRef ?? "#cta",
        title: `Issue on ${route}`,
        description: `A ${severity} issue on ${route}.`,
        suggestion: "Fix it.",
        introducedByThisPr: true,
      },
    ],
    notReviewed: [],
  };
}

describe("runReview — end-to-end orchestrator", () => {
  it("composes context→capture→triage→deep-pass→assemble→project into the golden wire shape", async () => {
    const routes = ["/pricing", "/home"];
    const { factory, calls } = scriptedModel((route) =>
      route === "/pricing"
        ? critiqueFor("/pricing", "major", "needs_work", { dimension: "color_contrast", elementRef: "#cta" })
        : critiqueFor("/home", "nit", "ship_with_nits", { dimension: "spacing", elementRef: "#hero" }),
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
    });

    // Worst grade across routes, floored to surviving findings (#106): major -> needs_work.
    expect(result.grade).toBe("needs_work");
    // Both routes' findings survive the gate + filter.
    expect(result.findings.map((f) => f.route).sort()).toEqual(["/home", "/pricing"]);
    // Deterministic wire ids.
    expect(result.findings.map((f) => f.id)).toEqual(["f_001", "f_002"]);
    // Metadata is stamped from the deep pass + capture + context.
    expect(result.metadata.captureVersion).toBe("stub-capture@1");
    expect(result.metadata.uiDnaVersion).toBe("ui-dna@2026.06.12");
    expect(result.metadata.model).toBe("qwen3-vl-plus");

    // Golden SHAPE: same top-level keys + finding keys as the cross-repo anchor.
    const golden = loadGoldenResult();
    expect(Object.keys(result).sort()).toEqual(Object.keys(golden).sort());
    expect(Object.keys(result.findings[0]!).sort()).toEqual(Object.keys(golden.findings[0]!).sort());
    expect(Object.keys(result.metadata).sort()).toEqual(Object.keys(golden.metadata).sort());

    // Triage ran (1 call) + a deep pass for each route (2 calls each: thinking + coerce).
    const triageCalls = calls.filter((c) =>
      c.messages.some((m) => m.role === "system" && m.content.startsWith("You are triaging")),
    );
    expect(triageCalls).toHaveLength(1);
  });

  it("short-circuits on the triage 'no design changes' path — no deep pass", async () => {
    const routes = ["/pricing"];
    // A model that, if the deep pass ran, would emit findings — so a clean result
    // proves the deep pass never ran.
    const { factory, calls } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));

    // Triage short-circuits when every route is positively confirmed unchanged:
    // pHash match (baseline == current) AND tile-wise diff below threshold.
    const input = baseInput(routes, {
      routes: [
        {
          route: "/pricing",
          baselinePhash: "ffff",
          currentPhash: "ffff",
          tileScores: [{ ssim: 1, diffRatio: 0 }],
        },
      ],
    });

    const result = await runReview(input, {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    expect(result.grade).toBe("ship");
    expect(result.findings).toHaveLength(0);
    expect(result.overall).toMatch(/no design changes/i);
    // No model call at all (triage short-circuits before the model; deep skipped).
    expect(calls).toHaveLength(0);
  });

  it("propagates engine-side not-reviewed reasons through to the wire result", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "minor", "needs_work"));

    const result = await runReview(
      baseInput(routes, {
        notReviewed: ["route /checkout (no preview deployment matched the head SHA)"],
      }),
      { captureInSandbox: stubCapture(routes, ["#cta"]), modelFactory: factory },
    );

    expect(result.notReviewed).toContain("route /checkout (no preview deployment matched the head SHA)");
  });

  it("does not crash when a route's model output fails coercion (null)", async () => {
    const routes = ["/pricing", "/home"];
    // /home returns malformed JSON -> coercion fails -> null output, recorded as
    // notReviewed; /pricing still produces a finding.
    const { factory } = scriptedModel((route) =>
      route === "/pricing" ? critiqueFor("/pricing", "major", "needs_work") : { broken: true },
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    // /pricing's finding survives; /home is recorded as not reviewed, no crash.
    expect(result.findings.map((f) => f.route)).toEqual(["/pricing"]);
    expect(result.notReviewed.some((r) => r.includes("/home"))).toBe(true);
    expect(result.grade).toBe("needs_work");
  });

  it("returns a clean empty result when the capture produced no images", async () => {
    const routes = ["/pricing"];
    const { factory, calls } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { empty: true }),
      modelFactory: factory,
    });

    expect(result.grade).toBe("ship");
    expect(result.findings).toHaveLength(0);
    expect(result.notReviewed).toContain("no captured routes");
    expect(calls).toHaveLength(0); // no model call without images.
  });

  it("threads injected genome rules (#104) into the deep pass without crashing", async () => {
    const routes = ["/pricing"];
    const { factory, calls } = scriptedModel(() => critiqueFor("/pricing", "minor", "needs_work"));
    const genomeIndex = await buildGenomeIndex(
      "ui-dna@2026.06.12",
      [{ id: "r1", text: "Primary CTA must use the accent token", component: "button" }],
      fakeEmbedder,
    );

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
      genomeIndex,
      embedder: fakeEmbedder,
    });

    expect(result.findings).toHaveLength(1);
    // The deep-pass thinking prompt carried the genome rule block.
    const thinking = calls.find((c) => c.thinking);
    expect(thinking?.messages.some((m) => m.content.includes("Primary CTA must use the accent token"))).toBe(true);
  });

  it("applies the confidence ceiling when the capture is visually unstable (#70)", async () => {
    const routes = ["/pricing"];
    // Finding confidence 0.9; an unstable capture ceilings it to 0.5, which is
    // below the post-filter floor (0.55), so it is dropped.
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { unstable: true }),
      modelFactory: factory,
    });

    expect(result.findings).toHaveLength(0);
    // Grade floored to ship when no findings survive (#106).
    expect(result.grade).toBe("ship");
  });
});
