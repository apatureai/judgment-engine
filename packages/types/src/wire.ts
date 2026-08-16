import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ConfidenceCalibrationReference,
  ConfidenceUnavailableReason,
  ResultMetadata,
} from "./findings.js";
import type { JudgmentProvenance } from "./provenance.js";

/**
 * Consumer-facing wire result returned over the async job API: the projection of
 * the internal `Critique` that crosses the repo boundary. It MUST stay identical
 * to Gate's `GateReviewResult` (TRD §2, §3); the shared golden fixture
 * (`fixtures/gate-review-result.golden.json`, copied from apatureai/gate) is the
 * cross-repo contract anchor, and `x-schema-version` guards additive evolution.
 */
export const SCHEMA_VERSION = "1";

export type WireGrade = "ship" | "ship_with_nits" | "needs_work" | "blocked";

/** The 8-dimension design rubric on the wire: the closed enum, mirrored from the internal `Dimension` (#159). */
export type WireDimension =
  | "visual_hierarchy"
  | "spacing"
  | "color_contrast"
  | "typography"
  | "consistency"
  | "responsiveness"
  | "accessibility"
  | "brand";

/** The viewport identifiers on the wire: the closed enum shared by findings and coverage. */
export type WireViewport = "mobile" | "tablet" | "desktop";

/**
 * What this run actually looked at (#165).
 *
 * A wire result always carries a `grade`, and a result with zero findings always
 * grades `ship` (`gradeFromFindings`: no surviving finding implies nothing to
 * report). That is correct for a clean page and indistinguishable, field for
 * field, from three runs that judged nothing at all: a capture that produced no
 * images, a run where every route's critique failed coercion, and a route set
 * that was never reachable. A consumer that gates a merge on the grade publishes
 * a green tick for all four.
 *
 * `notReviewed` cannot close that gap. It is free prose, a producer may leave it
 * empty, and a NON-empty `notReviewed` is perfectly compatible with a real,
 * clean, partial review (the golden fixture is exactly that: `/checkout` and the
 * tablet viewport skipped, real findings on what was reviewed). So coverage is
 * stated structurally instead, in identifiers rather than counts, so a consumer
 * can name what was skipped rather than only count it.
 *
 * The contract every producer follows: populate these from WHAT HAPPENED, never
 * from configuration. `routesRequested` is what the review was asked to cover;
 * `routesReviewed` is the subset this run actually formed a judgment about.
 * `routesReviewed` empty means nothing was reviewed, and a consumer is entitled
 * to treat the accompanying grade as meaningless.
 *
 * Additive + optional on schema v1 (`x-schema-version` unchanged), like
 * `dimension`, `pageHealthFootnote` and `provenance`: an older consumer parses a
 * result carrying it, and a consumer must read ABSENT as "this producer does not
 * report coverage", never as "everything was reviewed".
 */
export interface ReviewCoverage {
  /** Routes the review was asked to cover. */
  routesRequested: string[];
  /** Routes this run actually formed a judgment about. Empty ⇒ nothing was reviewed. */
  routesReviewed: string[];
  /** Viewports the review was asked to cover. */
  viewportsRequested: WireViewport[];
  /** Viewports actually captured and judged, across the reviewed routes. */
  viewportsReviewed: WireViewport[];
}

/**
 * True when the run this coverage describes judged nothing at all. Deliberately
 * keyed on routes: a viewport is only ever reviewed as part of a route, so an
 * empty reviewed-route set is the complete statement of "nothing was reviewed".
 */
export function nothingReviewed(coverage: ReviewCoverage): boolean {
  return coverage.routesReviewed.length === 0;
}

/**
 * Why a result's `grade` is not a verdict about the page.
 *
 * `nothing_reviewed` is the only value today, and it is exactly the condition
 * `nothingReviewed(coverage)` reports: no route reached a judgment, so the grade
 * is the value a critique over zero routes defaults to.
 */
export type GradeUnavailableReason = "nothing_reviewed";

export interface WireFinding {
  id: string;
  /**
   * The rubric dimension the engine selected for this finding (#159). Emitted
   * DIRECTLY from the validated internal finding, never derived from title,
   * severity, or prose. Additive + optional (schema v1, x-schema-version, like
   * `confidence` in #150): the projection always emits it going forward; it is
   * optional only so results stored before the field existed still type-check.
   * Consumers must not synthesize a value when absent (legacy = explicitly
   * unavailable, never a fake dimension).
   */
  dimension?: WireDimension;
  severity: "nit" | "minor" | "major" | "blocker";
  title: string;
  description: string;
  route: string;
  viewport: WireViewport;
  element: string | null;
  screenshotId: string | null;
  suggestion: string | null;
  /**
   * Engine-produced display confidence 0..1. It is authoritative only when the
   * containing result carries `calibration`; historical raw values without that
   * reference remain parseable but MUST be treated as unavailable.
   */
  confidence?: number;
}

export interface EngineReviewResult {
  grade: WireGrade;
  overall: string;
  /**
   * Result-level calibrated confidence 0..1. Authoritative only with the exact
   * `calibration` reference below; historical raw values remain parseable but
   * are not displayable.
   */
  confidence?: number;
  /** Exact report provenance for every numeric confidence in this result. */
  calibration?: ConfidenceCalibrationReference;
  /** Whether this promoted report may drive a blocking outcome. */
  blockingEnabled?: boolean;
  /** Why confidence was withheld on a current fail-closed result. */
  confidenceUnavailableReason?: ConfidenceUnavailableReason;
  findings: WireFinding[];
  notReviewed: string[];
  artifacts: {
    annotatedScreenshots: Array<{ findingId: string; url: string }>;
    engineDebugUrl?: string;
    /**
     * Page-health footnote (#20): console errors / failed requests / blocked
     * web fonts gathered during capture, surfaced as a delivery footnote and
     * deliberately kept OUT of `findings` (an app-health signal, not a design
     * critique). Additive + optional (schema v1, x-schema-version): omitted when
     * the page was clean, so the golden wire result stays byte-compatible.
     */
    pageHealthFootnote?: string;
  };
  screenshotRetentionSeconds: number;
  metadata: ResultMetadata;
  /**
   * What this run actually looked at (#165). Additive + optional on schema v1.
   * Absent means the producer does not report coverage, never "everything was
   * reviewed". See `ReviewCoverage`.
   */
  coverage?: ReviewCoverage;
  /**
   * How many findings the grounding gate deleted for citing a route that was
   * never captured or an element that is not in the geometry map (#32).
   * Additive + optional on schema v1, alongside `coverage`.
   *
   * Without it, "the page is clean" and "the model produced three findings and
   * not one of them could be pointed at" are the same payload: zero findings, a
   * `ship` grade, and the count known only to a log line and an SLO counter. The
   * second of those is the most useful sentence this engine can say about its
   * own model, so it travels with the result.
   *
   * `0` is a statement ("nothing was dropped"), which is why it is emitted even
   * then. ABSENT means the producer does not report drops, never "none were
   * dropped": a consumer must not read a missing field as a clean gate.
   *
   * It is a count, not a reconciliation. The narrative that was written before
   * the gate ran is settled separately, in `overall` itself: see
   * `ungroundedNarrative`.
   */
  hallucinationDrops?: number;
  /**
   * The model's own prose, verbatim, on a result where it is not a description
   * of the page. Additive + optional on schema v1, like `coverage` and
   * `hallucinationDrops`. Two conditions produce it, and they are the same
   * condition: the prose survived something the findings did not.
   *
   *   - Every finding the summary was written about was deleted by the
   *     validation tail, so it describes findings that could not be pointed at.
   *   - Nothing was reviewed at all (`coverage.routesReviewed` empty), so
   *     whatever sentence the run produced describes no judgment.
   *
   * When it is present, `overall` is NOT the model's prose: it is this engine's
   * statement of what happened. The prose is kept because knowing what the model
   * claimed is the most useful thing this engine can say about its own judge,
   * and it is what an operator debugging a bad capture needs. It is moved out of
   * `overall` because a reader must not mistake it for a conclusion about their
   * page.
   *
   * ABSENT is the normal case and means only that this reconciliation did not
   * fire. It never means "the narrative is grounded": a producer that does not
   * report the field says nothing either way.
   */
  ungroundedNarrative?: string;
  /**
   * Why the `grade` on this result is not a verdict about the page.
   *
   * `grade` is required by this contract and its enum is closed, so a result
   * that judged nothing still has to carry one of the four values, and a result
   * with no findings floors to `ship`. That is how a raw `review.json` from a run
   * that reviewed nothing came to read `"grade": "ship"` to anyone opening the
   * file. Every consumer in this org checks `coverage` first and withholds the
   * grade, but the file itself still stated a conclusion it had not reached.
   *
   * This is that statement's retraction, in band and machine-readable, on the
   * same fail-closed pattern as `confidenceUnavailableReason`: present means the
   * grade is not usable and the reason is given; absent means the producer
   * asserts nothing beyond the grade itself. A consumer that reads `grade` must
   * check this field, exactly as a consumer that reads `confidence` must check
   * `calibration`.
   *
   * `grade` is deliberately NOT nulled or omitted instead: the field is a
   * required closed enum in the cross-repo contract, and Gate's parser rejects a
   * result that violates it, which would turn today's honest neutral Check Run
   * into a blocked publish.
   */
  gradeUnavailableReason?: GradeUnavailableReason;
  /**
   * Whether anything judged this page, stated in the payload itself. Additive +
   * optional (schema v1, x-schema-version), like `dimension` and
   * `pageHealthFootnote`.
   *
   * A wire result always carries a `grade`, including on the paths where the
   * critique came from the mock or canned client rather than from a model. The
   * CLI's terminal report refuses to print a grade in that state; a caller of
   * the job API never sees that report, so the fact travels here instead.
   * Absent means the producer did not attest, which a consumer must read as
   * "unknown", never as "a model judged it".
   */
  provenance?: JudgmentProvenance;
}

/** Path to the shared golden wire result (the cross-repo contract anchor). */
export const GOLDEN_RESULT_PATH = fileURLToPath(
  new URL("../fixtures/gate-review-result.golden.json", import.meta.url),
);

/** Historical result with numeric fields but no report provenance. */
export const PRE_CALIBRATION_RESULT_PATH = fileURLToPath(
  new URL("../fixtures/gate-review-result.pre-calibration.json", import.meta.url),
);

/** Load the golden wire result the engine serializer must reproduce. */
export function loadGoldenResult(): EngineReviewResult {
  return JSON.parse(readFileSync(GOLDEN_RESULT_PATH, "utf8")) as EngineReviewResult;
}

/** Load the deploy-skew/legacy counterexample used by all wire consumers. */
export function loadPreCalibrationResult(): EngineReviewResult {
  return JSON.parse(readFileSync(PRE_CALIBRATION_RESULT_PATH, "utf8")) as EngineReviewResult;
}

/**
 * The only safe display-confidence guard. A legacy number without report
 * provenance is deliberately rejected, as is a partially populated result.
 */
export function hasDisplayableConfidence(
  result: EngineReviewResult,
): result is EngineReviewResult & {
  confidence: number;
  calibration: ConfidenceCalibrationReference;
  findings: Array<WireFinding & { confidence: number }>;
} {
  const calibration = result.calibration;
  return (
    calibration != null &&
    typeof calibration.reportId === "string" &&
    calibration.reportId.length > 0 &&
    typeof calibration.reportHash === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(calibration.reportHash) &&
    typeof calibration.calibrationVersion === "string" &&
    calibration.calibrationVersion.length > 0 &&
    typeof calibration.confidenceSource === "string" &&
    ["raw_verbalized", "post_hoc_isotonic", "post_hoc_histogram", "hidden_state_probe", "ensemble"]
      .includes(calibration.confidenceSource) &&
    Array.isArray(result.findings) &&
    result.findings.length > 0 &&
    typeof result.confidence === "number" &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0 &&
    result.confidence <= 1 &&
    result.findings.every(
      (finding) =>
        finding !== null &&
        typeof finding === "object" &&
        typeof finding.confidence === "number" &&
        Number.isFinite(finding.confidence) &&
        finding.confidence >= 0 &&
        finding.confidence <= 1,
    )
  );
}
