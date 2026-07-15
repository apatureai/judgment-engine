/**
 * Critique output contract (TRD §2, §8). The engine's internal `Finding` is the
 * rich form (dimension, confidence, title/description, element_ref, introduced-by-this-PR);
 * consumers receive a projected, version-stamped result over the async job API.
 * The type package evolves additive-only behind `x-schema-version`.
 */

/** The 8-dimension design rubric (TRD §8, #30). */
export type Dimension =
  | "visual_hierarchy"
  | "spacing"
  | "color_contrast"
  | "typography"
  | "consistency"
  | "responsiveness"
  | "accessibility"
  | "brand";

export type Severity = "nit" | "minor" | "major" | "blocker";
export type Viewport = "mobile" | "tablet" | "desktop";
export type Grade = "ship" | "ship_with_nits" | "needs_work" | "blocked";

export type ConfidenceSource =
  | "raw_verbalized"
  | "post_hoc_isotonic"
  | "post_hoc_histogram"
  | "hidden_state_probe"
  | "ensemble";

/** Exact promoted calibration artifact that authorizes display confidence. */
export interface ConfidenceCalibrationReference {
  reportId: string;
  reportHash: `sha256:${string}`;
  calibrationVersion: string;
  confidenceSource: ConfidenceSource;
}

export type ConfidenceUnavailableReason =
  | "missing_calibration_report"
  | "invalid_calibration_report"
  | "mismatched_calibration_report"
  | "insufficient_evidence"
  | "unattested_calibration_report";

/**
 * Validated eval-owned binding injected into the critique package. The report
 * itself remains serializable and owned by `@engine/eval`; only this runtime
 * projection crosses into serving.
 */
export interface CalibrationRuntimeBinding {
  reference: ConfidenceCalibrationReference;
  identity: {
    model: string;
    promptVersion: string;
    engineVersion: string;
    captureVersion: string;
    rubricVersion: string;
  };
  promotionMode: "advisory" | "blocking";
  thresholds: {
    postFilterMinConfidence: number;
    blockingMinConfidence: number;
    unstableCaptureMaxConfidence: number;
  };
  calibrate(rawConfidence: number): number;
}

export interface Finding {
  dimension: Dimension;
  severity: Severity;
  /** Internal working confidence 0..1; calibrated when a runtime binding exists. */
  confidence: number;
  /** Restricted model-emitted confidence retained only after calibration. Never projected. */
  rawConfidence?: number;
  route: string;
  viewport: Viewport;
  /** Selector/role reference into the captured DOM geometry, or null. */
  elementRef: string | null;
  /** Concise human-readable summary of the finding (#100); projected to the wire `title`. */
  title: string;
  /** The grounded explanation of what was observed (anti-hallucination); projected to the wire `description`. */
  description: string;
  suggestion: string | null;
  /** Whether this PR introduced the issue (vs pre-existing). */
  introducedByThisPr: boolean;
}

/** Version stamp on every result (TRD §2, §14; #68). */
export interface ResultMetadata {
  engineVersion: string;
  model: string;
  promptVersion: string;
  captureVersion: string;
  /** Closed design-rubric identity used by the calibration report. */
  rubricVersion?: string;
  /** UI-DNA genome version the critique was grounded against, or null. */
  uiDnaVersion: string | null;
  /**
   * Publication-time evidence from UI-DNA's approval-authority log. Optional
   * only for legacy and ungrounded results; every newly grounded production
   * result carries it.
   */
  groundingAuthority?: GroundingAuthorityProvenance;
}

export type GroundingAuthorityPublicationStatus =
  | "effective"
  | "superseded"
  | "revoked"
  | "unknown";

export type GroundingAuthorityUnknownReason =
  | "missing"
  | "malformed"
  | "stale"
  | "unavailable"
  | "sequence_regression"
  | "conflicting_sequence"
  | "revocation_regression";

/** Authority evidence that governed the final publication decision (#175). */
export interface GroundingAuthorityProvenance {
  contractVersion: "uidna-authority/1";
  status: GroundingAuthorityPublicationStatus;
  /** Last trustworthy UI-DNA log position, or null when none was observed. */
  sequence: number | null;
  /** Last trustworthy UI-DNA log head, or null when none was observed. */
  headEventHash: `sha256:${string}` | null;
  /** When the mirrored evidence itself was checked; null when unavailable. */
  evidenceCheckedAt: string | null;
  /** When Judgment Engine performed the final pre-publication check. */
  publicationCheckedAt: string;
  /** Present only when status is unknown and blocking was suppressed. */
  reason?: GroundingAuthorityUnknownReason;
}

/** Validation metadata surfaced with the result (TRD §8). */
export interface ValidationMetadata {
  /** Findings dropped for unknown route/element_ref (hallucination metric, #32). */
  hallucinationDrops: number;
  /** True when the captured page was visually unstable (confidence-ceiling applied). */
  captureUnstable: boolean;
}

/** The full critique() output (TRD §2). */
export interface Critique {
  grade: Grade;
  overall: string;
  findings: Finding[];
  /** Routes/viewports skipped, with reasons. */
  notReviewed: string[];
  validation: ValidationMetadata;
  metadata: ResultMetadata;
  /** Present only when numeric confidence is backed by a validated promoted report. */
  calibration?: ConfidenceCalibrationReference;
  /** Blocking is an explicit promotion mode, never inferred from a score. */
  blockingEnabled?: boolean;
  /** Fail-closed explanation when display confidence is unavailable. */
  confidenceUnavailableReason?: ConfidenceUnavailableReason;
}
