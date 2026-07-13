import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ConfidenceCalibrationReference,
  ConfidenceUnavailableReason,
  ResultMetadata,
} from "./findings.js";

/**
 * Consumer-facing wire result returned over the async job API — the projection of
 * the internal `Critique` that crosses the repo boundary. It MUST stay identical
 * to Gate's `GateReviewResult` (TRD §2, §3); the shared golden fixture
 * (`fixtures/gate-review-result.golden.json`, copied from apatureai/gate) is the
 * cross-repo contract anchor, and `x-schema-version` guards additive evolution.
 */
export const SCHEMA_VERSION = "1";

export type WireGrade = "ship" | "ship_with_nits" | "needs_work" | "blocked";

/** The 8-dimension design rubric on the wire — the closed enum, mirrored from the internal `Dimension` (#159). */
export type WireDimension =
  | "visual_hierarchy"
  | "spacing"
  | "color_contrast"
  | "typography"
  | "consistency"
  | "responsiveness"
  | "accessibility"
  | "brand";

export interface WireFinding {
  id: string;
  /**
   * The rubric dimension the engine selected for this finding (#159). Emitted
   * DIRECTLY from the validated internal finding — never derived from title,
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
  viewport: "mobile" | "tablet" | "desktop";
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
