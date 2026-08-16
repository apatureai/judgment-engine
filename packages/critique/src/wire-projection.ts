import { nothingReviewed } from "@engine/types";
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

/**
 * What a result says about itself when its coverage reports that no route
 * reached a judgment (#3).
 *
 * Three fields disagreed on that path. `coverage.routesReviewed` was empty,
 * `grade` was `ship` because a critique with no findings floors there, and
 * `overall` carried whatever prose the run had produced, which on the commonest
 * such path is the triage model's "Triage found no issues warranting a deep
 * review." Every consumer in this org checks coverage first and withholds both,
 * so the contradiction never reached a Check Run; it reached anyone who opened
 * `out/review.json`, which is a supported thing to do and the reason the file is
 * written at all.
 *
 * So the payload states it in the payload. `grade` cannot be nulled (see
 * `GradeUnavailableReason`), but the two prose fields can be made true, and the
 * model's own sentence is preserved rather than deleted, in the same field and
 * for the same reason as an ungrounded findings narrative.
 */
function nothingReviewedNarrative(critique: Critique, coverage: ReviewCoverage): {
  overall: string;
  ungroundedNarrative?: string;
} {
  const asked = coverage.routesRequested.length;
  const statement =
    `Nothing was reviewed: 0 of ${asked} requested route(s) reached a judgment in this run. ` +
    `The grade on this result is the value a review with no findings defaults to, not a verdict ` +
    `about this page.` +
    (critique.notReviewed.length > 0 ? " What was not reviewed, and why, is listed in notReviewed." : "");
  const prose = critique.overall.trim();
  // An existing `ungroundedNarrative` always wins: it was set because every
  // finding a narrative described was deleted, which is the more specific claim.
  if (critique.ungroundedNarrative !== undefined) {
    return { overall: statement, ungroundedNarrative: critique.ungroundedNarrative };
  }
  return prose.length === 0 ? { overall: statement } : { overall: statement, ungroundedNarrative: critique.overall };
}

/** Project the internal critique into the cross-repo wire result Gate consumes. */
export function toEngineReviewResult(critique: Critique, options: WireProjectionOptions): EngineReviewResult {
  const unreviewed =
    options.coverage && nothingReviewed(options.coverage)
      ? nothingReviewedNarrative(critique, options.coverage)
      : null;
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
    overall: unreviewed ? unreviewed.overall : critique.overall,
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
    // The grounding gate's drop count (#32) crosses the wire verbatim. It used
    // to stop here: the count was computed, logged, counted into an SLO and then
    // dropped at this projection, so a consumer holding the result could not tell
    // a clean page from three findings that could not be pointed at. Emitted even
    // when zero, because zero is the answer to the same question.
    hallucinationDrops: critique.validation.hallucinationDrops,
    // The model's prose, on a result where it is not a description of the page:
    // either every finding it was written about was deleted, or nothing was
    // reviewed at all. `overall` above carries the engine's statement in both
    // cases, so this is where the prose a reader may still want to see is kept.
    ...(unreviewed
      ? unreviewed.ungroundedNarrative !== undefined
        ? { ungroundedNarrative: unreviewed.ungroundedNarrative }
        : {}
      : critique.ungroundedNarrative !== undefined
        ? { ungroundedNarrative: critique.ungroundedNarrative }
        : {}),
    // Coverage (#165): emitted verbatim from what the orchestrator observed,
    // omitted entirely when the caller did not state it.
    ...(options.coverage ? { coverage: options.coverage } : {}),
    // The grade's retraction, for the raw artifact (#3). `grade` is a required
    // closed enum, so a run that judged nothing still carries `ship`; this says
    // in band that it is not a verdict. Emitted only from OBSERVED coverage: a
    // caller that did not state coverage cannot have this asserted on its behalf.
    ...(unreviewed ? { gradeUnavailableReason: "nothing_reviewed" as const } : {}),
  };
}
