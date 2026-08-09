import { PIXEL_BUDGETS, pageHealthFootnote } from "@engine/capture";
import type {
  CalibrationRuntimeBinding,
  CaptureContext,
  CaptureImage,
  CaptureInSandbox,
  ConfidenceUnavailableReason,
  GeometryRect,
} from "@engine/types";
import {
  buildContextBlock,
  retrieveGenomeRules,
  type ContextBlockInput,
  type Embedder,
  type GenomeIndex,
} from "@engine/context";
import {
  assembleCritique,
  buildSystemPrompt,
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
import type { Critique, EngineReviewResult, PreviewBuildFact } from "@engine/types";

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
  /**
   * The capture seam (#11/#22). `createBrowserCapture` from `@engine/capture`
   * is the live Chromium implementation; tests inject a stub.
   */
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
  /** Validated promoted report projection; absent means advisory/no display score. */
  calibration?: CalibrationRuntimeBinding;
  confidenceUnavailableReason?: ConfidenceUnavailableReason;
  /**
   * Observer for the assembled internal `Critique`, called once immediately
   * before the wire projection drops the internal-only fields. This is the seam
   * for `validation.hallucinationDrops` (#32) — the drop COUNT is an SLO input
   * and is deliberately not part of the consumer wire contract, so a metrics
   * emitter (or a CLI that wants to report it) reads it here. Never mutates the
   * result; throwing from it is the caller's problem, not the review's.
   */
  onCritique?: (critique: Critique) => void;
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
  /** Explicit instability supplied by an upstream capture adapter. */
  captureUnstable?: boolean;
  /** Wire-projection seams: screenshot-id/artifact-URL resolution + retention (#51). */
  wireOptions: WireProjectionOptions;
  /** Self-host single-call guided decoding (#76) instead of the DashScope two-step. */
  guidedDecoding?: boolean;
  /** Max concurrent deep-pass routes (#29, default 3). */
  concurrency?: number;
}

/**
 * Build the frozen system prompt for this review from the resolved repo context.
 *
 * The rubric, the grounding rules and the instruction-hierarchy defense against
 * prompt injection all live in `buildSystemPrompt` (`@engine/critique`); the
 * orchestrator's job is only to derive its two inputs from the context block, so
 * both stay in lockstep: the brand dimension is scored exactly when a brand block
 * was extracted, and every detected component library contributes its rubric
 * addendum. Deterministic — the same context yields the same prompt bytes, which
 * is what keeps the prefix cache warm.
 */
export function reviewSystemPrompt(context: ContextBlockInput): string {
  const componentAddenda = context.componentLibraries
    .map((library) => library.rubricAddendum)
    .filter((addendum) => addendum.trim().length > 0);
  return buildSystemPrompt({
    brandPresent: context.brand !== null,
    ...(componentAddenda.length > 0 ? { componentAddenda } : {}),
  });
}

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

  // 2. Capture (#11, injected). Chromium in `@engine/capture` is the live
  //    implementation; tests inject a stub so this composes without a browser.
  const capture = await deps.captureInSandbox(input.url, input.captureContext);
  const selectors = geometrySelectors(capture.geometry);

  // A capture that produced no images can't ground any finding — short out to a
  // clean "nothing reviewed" result rather than running the model on nothing.
  if (capture.images.length === 0) {
    return emptyFindingsResult(input, deps, capture.captureVersion, {
      extraNotReviewed: ["no captured routes"],
    });
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
    return emptyFindingsResult(input, deps, capture.captureVersion, { overall: triage.summary });
  }

  // 4. Deep pass (#29) over the SUSPECT routes only. Thread the route's
  //    deterministic facts (#19), retrieved genome rules (#104), build facts
  //    (#98), page text (#53), and feedback digest (#41).
  const suspect = new Set(triage.suspectRoutes);
  const routesToReview = input.routes.filter((r) => suspect.has(r.route));
  const byRoute = new Map(input.routes.map((r) => [r.route, r]));

  // Routes we'll actually deep-review (have a captured image), in deterministic order.
  const reviewable = routesToReview.filter((r) => modelImagesFor(r.route, capture.images).length > 0);

  // Batch the genome retrieval: embed every route's query in ONE embedder call
  // (the Embedder takes a batch), then rank per route against the prebuilt index.
  // Identical result to embedding each query separately — just one round-trip on
  // the critical path instead of N serial ones (#113). Determinism preserved.
  const genomeRulesByRoute = await selectGenomeRulesBatched(reviewable, deps);

  const deepRoutes: DeepPassRoute[] = [];
  for (const r of reviewable) {
    const images = modelImagesFor(r.route, capture.images);
    const cfg = byRoute.get(r.route);
    const genomeRules = genomeRulesByRoute.get(r.route) ?? [];
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
      systemPrompt: reviewSystemPrompt(input.context),
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
    // #160: the capture contributes only the instability fact; the validated
    // promoted report owns the numeric ceiling and post-filter threshold.
    captureUnstable: input.captureUnstable === true || capture.pageHealth.unstable,
    ...(deps.calibration ? { calibration: deps.calibration } : {}),
    ...(deps.confidenceUnavailableReason
      ? { confidenceUnavailableReason: deps.confidenceUnavailableReason }
      : {}),
    notReviewed: [...(input.notReviewed ?? []), ...uncapturedNotReviewed],
    model: deepConfig.model,
    captureVersion: capture.captureVersion,
    uiDnaVersion: input.context.uiDnaVersion,
  });

  // 6. Project to the cross-repo wire result Gate consumes (golden-shape). The
  //    page-health footnote (#20) — console errors / failed requests / blocked
  //    fonts gathered during capture — is surfaced in `artifacts`, never mixed
  //    into findings; a clean page yields null and omits the field (golden-safe).
  deps.onCritique?.(critique);
  return toEngineReviewResult(critique, {
    ...input.wireOptions,
    pageHealthFootnote: input.wireOptions.pageHealthFootnote ?? pageHealthFootnote(capture.pageHealth),
  });
}

/**
 * Batch the per-route genome retrieval (#104, #113). The `Embedder` accepts a
 * batch, so all route queries are embedded in ONE call, then each route is ranked
 * against the prebuilt index. This is identical to calling `selectGenomeRules`
 * per route (same query, same index, same deterministic ranking) but collapses N
 * serial embedding round-trips on the critical path into one. Returns an empty map
 * when no genome index + embedder are injected (the no-genome path).
 */
async function selectGenomeRulesBatched(
  routes: ReviewRoute[],
  deps: ReviewDeps,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const { genomeIndex, embedder } = deps;
  if (!genomeIndex || !embedder || genomeIndex.rules.length === 0 || routes.length === 0) {
    return out;
  }
  // Query = the route itself (components/diff would extend this; route alone is a
  // sound, deterministic query for the retrieval seam). One batched embed call.
  const queries = routes.map((r) => r.route);
  const vectors = await embedder(queries);
  routes.forEach((r, i) => {
    const queryVector = vectors[i];
    if (!queryVector) return;
    out.set(r.route, retrieveGenomeRules(genomeIndex, queryVector).map((g) => g.rule.text));
  });
  return out;
}

/**
 * A clean wire result for a review that produced no findings — both the empty
 * capture and the triage short-circuit. Routed through the SAME builders as the
 * main path (`assembleCritique` with no routes -> `toEngineReviewResult`) so it
 * inherits the #68 non-empty version-stamp assertion and can't drift from the
 * contract. The model is the resolved DEEP-pass model (passModels-aware), matching
 * what the main path reports (#113).
 */
function emptyFindingsResult(
  input: ReviewInput,
  deps: ReviewDeps,
  captureVersion: string,
  options: { overall?: string; extraNotReviewed?: string[] } = {},
): EngineReviewResult {
  const deepConfig = resolvePassModel("deep", deps.passModels);
  const critique = assembleCritique([], {
    capturedRoutes: [],
    notReviewed: [...(input.notReviewed ?? []), ...(options.extraNotReviewed ?? [])],
    model: deepConfig.model,
    captureVersion,
    uiDnaVersion: input.context.uiDnaVersion,
    ...(deps.calibration ? { calibration: deps.calibration } : {}),
    ...(deps.confidenceUnavailableReason
      ? { confidenceUnavailableReason: deps.confidenceUnavailableReason }
      : {}),
  });
  // assembleCritique derives `overall` from route outputs (empty here); for the
  // short-circuit we carry the triage summary through verbatim.
  const stamped = options.overall !== undefined ? { ...critique, overall: options.overall } : critique;
  deps.onCritique?.(stamped);
  return toEngineReviewResult(stamped, input.wireOptions);
}
