import type {
  Critique,
  EngineReviewResult,
  Finding,
  ReviewCoverage,
  WireFinding,
} from "@engine/types";

/**
 * Project the engine's internal `Critique` into the consumer-facing wire result
 * `EngineReviewResult` (TRD §2/§8). This IS the cross-repo contract boundary with
 * Gate: the async job API returns this shape, and it must stay byte-compatible
 * with `fixtures/gate-review-result.golden.json`. The internal `Finding` is the
 * rich form (dimension/confidence/introducedByThisPr). `introducedByThisPr` is
 * DROPPED here (internal-only), while `confidence` (since #150) and `dimension`
 * (since #159) pass through per finding: consumers like Bastion group outcomes
 * by the calibrated confidence + rubric dimension and must not fabricate either.
 * The wire form stays the projected, stable subset Gate renders.
 *
 * Pure. The screenshot-id and artifact-URL resolution are injected (the worker
 * binds them to the captured-image set + the object-store signed-URL base);
 * absent ⇒ no annotated screenshot for that finding.
 *
 * The model emits a dedicated `title` + `description` per finding (#100); the
 * projection passes them through. `deriveTitle` remains only as a DEFENSIVE
 * fallback for a finding whose title is empty/whitespace; it derives one from
 * the description so a malformed model row can never yield a blank wire title.
 */

const MAX_TITLE_LEN = 80;

/** Derive a concise title from a description (defensive fallback for a blank title). */
export function deriveTitle(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length === 0) return "Design finding";
  // First sentence, if it is short enough to read as a title.
  const sentenceEnd = trimmed.search(/[.!?](\s|$)/);
  const firstSentence = sentenceEnd >= 0 ? trimmed.slice(0, sentenceEnd) : trimmed;
  if (firstSentence.length <= MAX_TITLE_LEN) return firstSentence;
  // Otherwise cap at a word boundary under the limit and ellipsize.
  const capped = firstSentence.slice(0, MAX_TITLE_LEN);
  const lastSpace = capped.lastIndexOf(" ");
  return `${(lastSpace > 0 ? capped.slice(0, lastSpace) : capped).trimEnd()}…`;
}

/** Stable, 1-based finding id: f_001, f_002, … (order-deterministic). */
export function wireFindingId(index: number): string {
  return `f_${String(index + 1).padStart(3, "0")}`;
}

export interface WireProjectionOptions {
  /**
   * Resolve the annotated-screenshot id for a finding (route+viewport → the
   * captured shot), or null when none. Defaults to null for every finding.
   */
  screenshotIdFor?: (finding: Finding, index: number) => string | null;
  /** Build the public artifact URL for a screenshot id (object-store signed URL). */
  artifactUrlFor?: (screenshotId: string) => string;
  /** Engine debug URL for this run, omitted from the wire result when absent. */
  engineDebugUrl?: string;
  /**
   * Page-health footnote (#20): the rendered console-error/failed-request/
   * blocked-font note from `pageHealthFootnote(capture.pageHealth)`, or
   * null/undefined when the page was clean. Surfaced in `artifacts` and never
   * mixed into `findings`. Omitted from the wire result when absent, so a clean
   * page leaves the result byte-identical to before.
   */
  pageHealthFootnote?: string | null;
  /**
   * What the run actually looked at (#165). Supplied by the ORCHESTRATOR, which
   * is the only stage that knows which routes reached a judgment and which
   * viewports were captured for them; the projector is one stage earlier than
   * that knowledge and must never synthesize it from the critique (a critique
   * with zero findings says nothing about whether anything was reviewed, which
   * is the whole reason this field exists). Omitted from the wire result when
   * absent, so a producer that cannot answer honestly says nothing rather than
   * claiming full coverage.
   */
  coverage?: ReviewCoverage;
  /** Screenshot retention seconds (tier retention policy, #51). */
  screenshotRetentionSeconds: number;
}

/** Project one internal finding to its wire form (internal-only fields dropped). */
function toWireFinding(
  finding: Finding,
  index: number,
  options: WireProjectionOptions,
  confidenceAvailable: boolean,
): WireFinding {
  const screenshotId = options.screenshotIdFor?.(finding, index) ?? null;
  return {
    id: wireFindingId(index),
    // #159: the validated internal rubric dimension crosses the wire verbatim,
    // never derived from severity/title. Consumers group outcomes by it.
    dimension: finding.dimension,
    severity: finding.severity,
    // Pass the model-emitted title through; fall back to a derived one only if blank.
    title: finding.title.trim().length > 0 ? finding.title : deriveTitle(finding.description),
    description: finding.description,
    route: finding.route,
    viewport: finding.viewport,
    element: finding.elementRef,
    screenshotId,
    suggestion: finding.suggestion,
    // Raw model confidence never crosses the wire. Emit only after report binding.
    ...(confidenceAvailable ? { confidence: finding.confidence } : {}),
  };
}

/**
 * Result-level confidence (#150): the minimum over calibrated finding
 * confidences. A clean result has no raw score to transform, so it has no
 * numeric confidence; the old synthetic `1` is deliberately retired by #160.
 */
function resultConfidence(findings: readonly Finding[]): number {
  if (findings.length === 0) throw new Error("cannot aggregate confidence without calibrated findings");
  return Math.min(...findings.map((finding) => finding.confidence));
}

/** Project the internal critique into the cross-repo wire result Gate consumes. */
export function toEngineReviewResult(critique: Critique, options: WireProjectionOptions): EngineReviewResult {
  const confidenceAvailable = critique.calibration !== undefined && critique.findings.length > 0;
  const findings = critique.findings.map((f, i) => toWireFinding(f, i, options, confidenceAvailable));

  const annotatedScreenshots = findings
    .filter((f): f is WireFinding & { screenshotId: string } => f.screenshotId !== null)
    .map((f) => ({
      findingId: f.id,
      url: options.artifactUrlFor ? options.artifactUrlFor(f.screenshotId) : f.screenshotId,
    }));

  return {
    grade: critique.grade,
    overall: critique.overall,
    ...(confidenceAvailable ? { confidence: resultConfidence(critique.findings) } : {}),
    ...(critique.calibration ? { calibration: critique.calibration } : {}),
    blockingEnabled: critique.blockingEnabled === true,
    ...(critique.calibration === undefined
      ? { confidenceUnavailableReason: critique.confidenceUnavailableReason ?? "missing_calibration_report" }
      : {}),
    findings,
    notReviewed: critique.notReviewed,
    artifacts: {
      annotatedScreenshots,
      // engineDebugUrl is optional on the wire, so only set it when present.
      ...(options.engineDebugUrl !== undefined ? { engineDebugUrl: options.engineDebugUrl } : {}),
      // Page-health footnote (#20), only when capture reported something; a
      // clean page omits the field so the wire result stays byte-compatible.
      ...(options.pageHealthFootnote ? { pageHealthFootnote: options.pageHealthFootnote } : {}),
    },
    screenshotRetentionSeconds: options.screenshotRetentionSeconds,
    metadata: critique.metadata,
    // Coverage (#165): emitted verbatim from what the orchestrator observed,
    // omitted entirely when the caller did not state it.
    ...(options.coverage ? { coverage: options.coverage } : {}),
  };
}
