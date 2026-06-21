import { PIXEL_BUDGETS } from "@engine/capture";
import type { CaptureContext, CaptureImage, CaptureInSandbox, GeometryRect } from "@engine/types";
import {
  buildContextBlock,
  selectGenomeRules,
  type ContextBlockInput,
  type Embedder,
  type GenomeIndex,
} from "@engine/context";
import {
  assembleCritique,
  ENGINE_VERSION,
  PROMPT_VERSION,
  resolvePassModel,
  runDeepPass,
  runTriage,
  toEngineReviewResult,
  defaultModelFactory,
  type DeepPassRoute,
  type ModelClientFactory,
  type PassModelOverrides,
  type TriageRoute,
  type WireProjectionOptions,
} from "@engine/critique";
import type { ModelImage } from "@engine/critique";
import type { EngineReviewResult, PreviewBuildFact } from "@engine/types";

/**
 * End-to-end review orchestrator (TRD §6, #109): the keystone that composes the
 * engine's individually-built, individually-tested pure pieces into ONE review
 * pipeline. Until this, nothing sequenced them — the async job API shipped the
 * EM0 `defaultProcessor` stub whose comment promised "EM2 replaces this with the
 * real capture + critique pipeline".
 *
 * The flow (each stage's real API verified, see imports):
 *   buildContextBlock (#63) + optional genome index (#104)
 *     -> captureInSandbox (#11/#22 live seam, INJECTED)
 *     -> runTriage (#28): short-circuit to "no design changes" when unchanged
 *     -> else runDeepPass (#29) over the suspect routes, threading deterministic
 *        facts (#19), retrieved genome rules (#104), and build facts (#98)
 *     -> assembleCritique (#106): the global validation tail (gate #32 / ceiling
 *        #70 / post-filter #33 / reconcileGrade / version stamp #68)
 *     -> toEngineReviewResult: the cross-repo wire projection.
 *
 * EVERY live I/O is injected: the model client factory, the capture sandbox seam,
 * and the genome embedder. In tests these are stubs + the mock model — a real
 * model / sandbox / browser / GPU is NEVER called. Pure + deterministic given
 * deterministic deps; the output is byte-compatible with the Gate golden wire
 * fixture shape.
 */

/** Per-route inputs the orchestrator threads into capture + triage + the deep pass. */
export interface ReviewRoute {
  /** Route path, e.g. "/pricing". */
  route: string;
  /** Cached baseline perceptual hash (#34/#41), if any. */
  baselinePhash?: string;
  /** Current perceptual hash from this capture. */
  currentPhash?: string;
  /**
   * Per-tile change-sensitive scores (#17/#89) used to CONFIRM a pHash match
   * before the triage short-circuit. Absent ⇒ a pHash match alone can't
   * short-circuit (fails open to a deep review).
   */
  tileScores?: TriageRoute["tileScores"];
  /** Deterministic breakage facts (#19) — forces a deep review when present. */
  deterministicBreakage?: string[];
  /** Deterministic facts (contrast/overflow/touch-target, #19) for the deep prompt. */
  facts?: string[];
  /** Untrusted page DOM text (#53), fenced in the deep prompt. */
  pageText?: string;
  /** Per-repo memory digest suffix (#41). */
  feedbackDigest?: string;
}

/** Live I/O seams — all injected so the orchestrator is fully testable with stubs. */
export interface ReviewDeps {
  /** The capture sandbox seam (#11/#22). Real Firecracker/Playwright is live-deferred. */
  captureInSandbox: CaptureInSandbox;
  /** Per-pass model client factory (#27). Tests pass the mock model. */
  modelFactory?: ModelClientFactory;
  /** Per-pass model config overrides (model id / backend / thinking). */
  passModels?: PassModelOverrides;
  /**
   * Resolved UI-DNA genome index (#104), prebuilt by the caller via
   * `buildGenomeIndex(version, rules, embedder)`. Absent ⇒ no genome grounding
   * (the deep prompt is byte-identical to the no-genome case).
   */
  genomeIndex?: GenomeIndex;
  /** Embedder for the per-route genome query (#104); required iff `genomeIndex` is set. */
  embedder?: Embedder;
  /** Cooperative-cancellation signal (#66) threaded into every model call. */
  signal?: AbortSignal;
}

export interface ReviewInput {
  /** The preview URL to capture. */
  url: string;
  /** Review depth (triage vs deep budget/model). */
  depth: "triage" | "deep";
  /** Context-block inputs (#63): tokens, brand, component libs, uiDnaVersion, routes. */
  context: ContextBlockInput;
  /** Capture context (#4): viewports, dark mode, auth/fork flags, routes. */
  captureContext: CaptureContext;
  /** Per-route triage/deep inputs (baseline hashes, facts, page text). */
  routes: ReviewRoute[];
  /** PR-level build/runtime facts from Gate's preview supervisor (#98). */
  previewBuildFacts?: PreviewBuildFact[];
  /**
   * Engine-side not-reviewed reasons to carry through (fork skip, off-domain,
   * routes with no preview deployment). Surfaced in the wire result verbatim.
   */
  notReviewed?: string[];
  /** Confidence ceiling applied when the capture is visually unstable (#70). */
  confidenceCeiling?: number;
  /** Wire-projection seams: screenshot-id/artifact-URL resolution + retention (#51). */
  wireOptions: WireProjectionOptions;
  /** Self-host single-call guided decoding (#76) instead of the DashScope two-step. */
  guidedDecoding?: boolean;
  /** Max concurrent deep-pass routes (#29, default 3). */
  concurrency?: number;
}

const SYSTEM_PROMPT = "Apature design reviewer.";

/** Valid elementRef selectors from the geometry map (#18), for the #32 element_ref drop. */
function geometrySelectors(geometry: GeometryRect[]): Set<string> {
  return new Set(geometry.map((g) => g.selector));
}

/** All captured route ids — the hallucination gate (#32) drops findings off these. */
function capturedRoutes(images: CaptureImage[]): string[] {
  return [...new Set(images.map((i) => i.route))];
}

/** Project captured images for one route into the model-image shape (#16/#17 seam). */
function modelImagesFor(route: string, images: CaptureImage[]): ModelImage[] {
  return images
    .filter((i) => i.route === route)
    .map((i) => ({ objectKey: i.objectKey, route: i.route, viewport: i.viewport }));
}

/**
 * Run one end-to-end review. Pure given deterministic deps. Sequences context →
 * capture → triage → (deep pass | short-circuit) → assemble → wire projection.
 */
export async function runReview(input: ReviewInput, deps: ReviewDeps): Promise<EngineReviewResult> {
  const modelFactory = deps.modelFactory ?? defaultModelFactory;
  const maxPixels = PIXEL_BUDGETS[input.depth];

  // 1. Resolve the deterministic, content-hashed context block (#63). It's the
  //    prefix-cache anchor placed first in the deep prompt; the genome index
  //    (#104) is resolved by the caller and injected.
  const contextBlock = buildContextBlock(input.context);

  // 2. Capture (#11/#22 live seam, injected). Real Firecracker/Playwright is
  //    deferred; the stub returns a deterministic shape so this composes in CI.
  const capture = await deps.captureInSandbox(input.url, input.captureContext);
  const selectors = geometrySelectors(capture.geometry);

  // A capture that produced no images can't ground any finding — short out to a
  // clean "nothing reviewed" result rather than running the model on nothing.
  if (capture.images.length === 0) {
    return emptyResult(input, capture.captureVersion, "no captured routes");
  }

  // 3. Triage (#28). Short-circuits (no deep model call) when every captured
  //    route is positively confirmed unchanged (pHash match + tile-wise diff).
  const triageRoutes: TriageRoute[] = input.routes.map((r) => ({
    route: r.route,
    ...(r.baselinePhash !== undefined ? { baselinePhash: r.baselinePhash } : {}),
    currentPhash: r.currentPhash ?? "",
    ...(r.tileScores !== undefined ? { tileScores: r.tileScores } : {}),
    aboveFoldImages: modelImagesFor(r.route, capture.images),
    ...(r.deterministicBreakage !== undefined ? { deterministicBreakage: r.deterministicBreakage } : {}),
  }));

  const triageConfig = resolvePassModel("triage", deps.passModels);
  const triage = await runTriage(
    {
      client: modelFactory(triageConfig),
      model: triageConfig.model,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    triageRoutes,
  );

  const deepConfig = resolvePassModel("deep", deps.passModels);

  // 3a. Short-circuit: no design changes -> emit the triage result, no deep pass.
  if (!triage.needsDeepReview) {
    return shortCircuitResult(input, capture.captureVersion, deepConfig.model, triage.summary);
  }

  // 4. Deep pass (#29) over the SUSPECT routes only. Thread the route's
  //    deterministic facts (#19), retrieved genome rules (#104), build facts
  //    (#98), page text (#53), and feedback digest (#41).
  const suspect = new Set(triage.suspectRoutes);
  const routesToReview = input.routes.filter((r) => suspect.has(r.route));
  const byRoute = new Map(input.routes.map((r) => [r.route, r]));

  const deepRoutes: DeepPassRoute[] = [];
  for (const r of routesToReview) {
    const images = modelImagesFor(r.route, capture.images);
    if (images.length === 0) continue; // can't review a route with no captured image.
    const cfg = byRoute.get(r.route);
    const genomeRules = await selectGenomeRulesFor(r, deps);
    deepRoutes.push({
      route: r.route,
      images,
      ...(cfg?.facts && cfg.facts.length > 0 ? { facts: cfg.facts } : {}),
      ...(genomeRules.length > 0 ? { genomeRules } : {}),
      ...(cfg?.pageText ? { pageText: cfg.pageText } : {}),
      ...(cfg?.feedbackDigest ? { feedbackDigest: cfg.feedbackDigest } : {}),
    });
  }

  const deepResults = await runDeepPass(
    {
      client: modelFactory(deepConfig),
      model: deepConfig.model,
      systemPrompt: SYSTEM_PROMPT,
      contextBlock: contextBlock.serialized,
      maxPixels,
      concurrency: input.concurrency ?? 3,
      ...(input.guidedDecoding !== undefined ? { guidedDecoding: input.guidedDecoding } : {}),
      ...(input.previewBuildFacts ? { buildFacts: input.previewBuildFacts } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    deepRoutes,
  );

  // Routes triage suspected but that had no captured image are recorded as
  // not-reviewed so the wire result is honest about coverage.
  const reviewedRoutes = new Set(deepRoutes.map((r) => r.route));
  const uncapturedNotReviewed = routesToReview
    .filter((r) => !reviewedRoutes.has(r.route))
    .map((r) => `route ${r.route} (no captured image)`);

  // 5. Assemble (#106): the global validation tail (gate #32 / ceiling #70 /
  //    post-filter #33 / reconcileGrade / stamp #68) over ALL merged findings.
  const critique = assembleCritique(deepResults, {
    capturedRoutes: capturedRoutes(capture.images),
    geometrySelectors: selectors,
    ...(input.confidenceCeiling !== undefined || capture.pageHealth.unstable
      ? { confidenceCeiling: input.confidenceCeiling ?? 0.5 }
      : {}),
    notReviewed: [...(input.notReviewed ?? []), ...uncapturedNotReviewed],
    model: deepConfig.model,
    captureVersion: capture.captureVersion,
    uiDnaVersion: input.context.uiDnaVersion,
  });

  // 6. Project to the cross-repo wire result Gate consumes (golden-shape).
  return toEngineReviewResult(critique, input.wireOptions);
}

/** Retrieve the route's top-k genome rules (#104), if a genome index + embedder are injected. */
async function selectGenomeRulesFor(route: ReviewRoute, deps: ReviewDeps): Promise<string[]> {
  if (!deps.genomeIndex || !deps.embedder) return [];
  // Query = the route itself (components/diff would extend this; route alone is
  // a sound, deterministic query for the retrieval seam).
  return selectGenomeRules(deps.genomeIndex, route.route, deps.embedder);
}

/** A clean wire result for a review that produced no findings (capture/short-circuit). */
function emptyResult(input: ReviewInput, captureVersion: string, reason: string): EngineReviewResult {
  return {
    grade: "ship",
    overall: "",
    findings: [],
    notReviewed: [...new Set([...(input.notReviewed ?? []), reason])],
    artifacts: { annotatedScreenshots: [] },
    screenshotRetentionSeconds: input.wireOptions.screenshotRetentionSeconds,
    metadata: {
      engineVersion: ENGINE_VERSION,
      model: resolvePassModel(input.depth, undefined).model,
      promptVersion: PROMPT_VERSION,
      captureVersion,
      uiDnaVersion: input.context.uiDnaVersion,
    },
  };
}

/** The triage short-circuit result: "no design changes", no deep pass spent. */
function shortCircuitResult(
  input: ReviewInput,
  captureVersion: string,
  model: string,
  summary: string,
): EngineReviewResult {
  return {
    grade: "ship",
    overall: summary,
    findings: [],
    notReviewed: [...new Set(input.notReviewed ?? [])],
    artifacts: { annotatedScreenshots: [] },
    screenshotRetentionSeconds: input.wireOptions.screenshotRetentionSeconds,
    metadata: {
      engineVersion: ENGINE_VERSION,
      model,
      promptVersion: PROMPT_VERSION,
      captureVersion,
      uiDnaVersion: input.context.uiDnaVersion,
    },
  };
}
