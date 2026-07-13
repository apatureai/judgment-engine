import type {
  CalibrationRuntimeBinding,
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
import { assertVersionStamped } from "@engine/critique";
import { loadGoldenResult } from "@engine/types";
import { describe, expect, it } from "vitest";
import {
  runReview as runReviewRaw,
  type ReviewDeps,
  type ReviewInput,
} from "../src/index.js";

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

const TEST_CALIBRATION: CalibrationRuntimeBinding = {
  reference: {
    reportId: "calibration_qwen3vl_2026_07",
    reportHash: "sha256:675dcd6a31db1157aa84fce80a00d1dd2a591e15877226697134b79269a9ac08",
    calibrationVersion: "isotonic@1",
    confidenceSource: "post_hoc_isotonic",
  },
  identity: {
    model: "qwen3-vl-plus",
    promptVersion: "system-prompt@v3",
    engineVersion: "0.0.0",
    captureVersion: "stub-capture@1",
    rubricVersion: "design-rubric@1",
  },
  promotionMode: "blocking",
  thresholds: {
    postFilterMinConfidence: 0.55,
    blockingMinConfidence: 0.8,
    unstableCaptureMaxConfidence: 0.6,
  },
  calibrate: (raw) => raw,
};

function runReview(input: ReviewInput, deps: ReviewDeps) {
  return runReviewRaw(input, { calibration: TEST_CALIBRATION, ...deps });
}

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
function stubCapture(
  routes: string[],
  selectors: string[],
  opts: { unstable?: boolean; empty?: boolean; consoleErrors?: number; failedRequests?: number } = {},
): CaptureInSandbox {
  return async (_url: string, _ctx: CaptureContext): Promise<Capture> => ({
    images: opts.empty ? [] : captureImagesFor(routes),
    geometry: opts.empty ? [] : geometryFor(routes, selectors),
    pageHealth: {
      consoleErrors: opts.consoleErrors ?? 0,
      failedRequests: opts.failedRequests ?? 0,
      unstable: opts.unstable ?? false,
    },
    captureVersion: "stub-capture@1",
  });
}

/** Deterministic bag-of-tokens embedder — no model. */
function embedVectors(texts: readonly string[]): number[][] {
  return texts.map((t) => {
    const lower = t.toLowerCase();
    return [
      lower.includes("pricing") ? 1 : 0,
      lower.includes("home") ? 1 : 0,
      lower.includes("button") || lower.includes("cta") ? 1 : 0,
      lower.length % 7,
    ];
  });
}

const fakeEmbedder: Embedder = async (texts) => embedVectors(texts);

/** A spy embedder that records each batch it was asked to embed (for call-count asserts). */
function spyEmbedder(): { embedder: Embedder; batches: readonly string[][] } {
  const batches: string[][] = [];
  const embedder: Embedder = async (texts) => {
    batches.push([...texts]);
    return embedVectors(texts);
  };
  return { embedder, batches };
}

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

  it("caps confidence on an unstable capture but keeps the finding (#70: ceiling 0.6 ≥ floor 0.55)", async () => {
    const routes = ["/pricing"];
    // Finding confidence 0.9; an unstable capture (no explicit ceiling) caps it to
    // the default UNSTABLE_CONFIDENCE_CEILING (0.6), which is ABOVE the post-filter
    // floor (0.55) — so a REAL finding still SURFACES with lowered trust. It must
    // NOT be silently dropped (a flaky page with a real blocker would otherwise
    // return ship/[]).
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { unstable: true }),
      modelFactory: factory,
    });

    // Survives the ceiling+filter; grade reflects the surviving major finding.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.route).toBe("/pricing");
    expect(result.grade).toBe("needs_work");
  });

  it("drops findings when the promoted unstable ceiling is below its post-filter floor", async () => {
    const routes = ["/pricing"];
    // A caller may pass a stricter ceiling; 0.5 < the 0.55 floor drops the finding.
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes, { captureUnstable: true }), {
      captureInSandbox: stubCapture(routes, ["#cta"], { unstable: true }),
      modelFactory: factory,
      calibration: {
        ...TEST_CALIBRATION,
        thresholds: { ...TEST_CALIBRATION.thresholds, unstableCaptureMaxConfidence: 0.5 },
      },
    });

    expect(result.findings).toHaveLength(0);
    // Grade floored to ship when no findings survive (#106).
    expect(result.grade).toBe("ship");
  });

  // -------------------------------------------------------------------------
  // #20: page-health footnote surfaced in delivery (artifacts), not findings
  // -------------------------------------------------------------------------

  it("#20: surfaces console-error/failed-request page health as an artifacts footnote, not a finding", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { consoleErrors: 2, failedRequests: 1 }),
      modelFactory: factory,
    });

    expect(result.artifacts.pageHealthFootnote).toBe(
      "Page health: 2 console error(s), 1 failed request(s).",
    );
    // It rode in as a footnote, never as a design finding.
    expect(result.findings.every((f) => !/console error|failed request/i.test(f.description))).toBe(true);
  });

  it("#20: omits the page-health footnote when the page is clean (golden-safe)", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"]),
      modelFactory: factory,
    });

    expect(result.artifacts).not.toHaveProperty("pageHealthFootnote");
  });

  it("#20: an unstable capture footnotes the instability for delivery", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "needs_work"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { unstable: true }),
      modelFactory: factory,
    });

    expect(result.artifacts.pageHealthFootnote).toContain("page visually unstable during capture");
  });

  // -------------------------------------------------------------------------
  // #113: quality follow-ups (model attribution, version-stamp routing, batch embed)
  // -------------------------------------------------------------------------

  it("#113: empty-capture result reports the resolved deep-pass model + a valid version stamp", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));

    // depth: "triage" — the OLD emptyResult stamped resolvePassModel("triage") and
    // would have reported the triage model here. It must report the deep-pass model
    // (the model the rest of the pipeline reports), regardless of depth.
    const result = await runReview(baseInput(routes, { depth: "triage" }), {
      captureInSandbox: stubCapture(routes, ["#cta"], { empty: true }),
      modelFactory: factory,
    });

    expect(result.grade).toBe("ship");
    expect(result.notReviewed).toContain("no captured routes");
    // Same model the main deep path reports (see the golden-shape test above).
    expect(result.metadata.model).toBe("qwen3-vl-plus");
    // Routed through buildResultMetadata: a valid, non-empty #68 version stamp.
    expect(() => assertVersionStamped(result.metadata)).not.toThrow();
    expect(result.metadata.captureVersion).toBe("stub-capture@1");
    expect(result.metadata.uiDnaVersion).toBe("ui-dna@2026.06.12");
  });

  it("#113: empty-capture model honours passModels overrides (passModels-aware)", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta"], { empty: true }),
      modelFactory: factory,
      passModels: { deep: { model: "custom-deep-model" } },
    });

    expect(result.metadata.model).toBe("custom-deep-model");
    expect(() => assertVersionStamped(result.metadata)).not.toThrow();
  });

  it("#113: short-circuit result routes through the shared builders (golden-shape + valid stamp)", async () => {
    const routes = ["/pricing"];
    const { factory } = scriptedModel(() => critiqueFor("/pricing", "major", "blocked"));
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
    expect(result.overall).toMatch(/no design changes/i);
    // Same top-level + metadata keys as the cross-repo golden anchor, except a
    // clean short-circuit has no raw finding score and therefore no synthetic
    // numeric confidence (#160).
    const golden = loadGoldenResult();
    expect(Object.keys(result).sort()).toEqual(Object.keys(golden).filter((key) => key !== "confidence").sort());
    expect(result).not.toHaveProperty("confidence");
    expect(Object.keys(result.metadata).sort()).toEqual(Object.keys(golden.metadata).sort());
    // Routed through buildResultMetadata: the #68 version stamp is present + valid.
    expect(() => assertVersionStamped(result.metadata)).not.toThrow();
    expect(result.metadata.model).toBe("qwen3-vl-plus");
  });

  it("#113: genome embedding is invoked ONCE (batched) across routes, not per route", async () => {
    const routes = ["/pricing", "/home"];
    const { factory } = scriptedModel((route) =>
      route === "/pricing"
        ? critiqueFor("/pricing", "major", "needs_work", { dimension: "color_contrast", elementRef: "#cta" })
        : critiqueFor("/home", "nit", "ship_with_nits", { dimension: "spacing", elementRef: "#hero" }),
    );
    const { embedder, batches } = spyEmbedder();
    const genomeIndex = await buildGenomeIndex(
      "ui-dna@2026.06.12",
      [{ id: "r1", text: "Primary CTA must use the accent token", component: "button" }],
      embedder,
    );
    // buildGenomeIndex embeds the rules once; reset so we measure only the review.
    const buildCalls = batches.length;

    const result = await runReview(baseInput(routes), {
      captureInSandbox: stubCapture(routes, ["#cta", "#hero"]),
      modelFactory: factory,
      genomeIndex,
      embedder,
    });

    // Both routes reviewed (the batched retrieval did not change results).
    expect(result.findings.map((f) => f.route).sort()).toEqual(["/home", "/pricing"]);
    // Exactly ONE embedder call for the two routes' queries — not N serial calls.
    const reviewBatches = batches.slice(buildCalls);
    expect(reviewBatches).toHaveLength(1);
    expect(reviewBatches[0]).toEqual(["/pricing", "/home"]);
  });

  it("#113: batched genome retrieval yields identical rules to per-route selection", async () => {
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
    // The genome rule still reaches the deep-pass thinking prompt (unchanged behaviour).
    const thinking = calls.find((c) => c.thinking);
    expect(thinking?.messages.some((m) => m.content.includes("Primary CTA must use the accent token"))).toBe(true);
  });
});
