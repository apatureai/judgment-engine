/**
 * Critique output contract (TRD §2, §8). The engine's internal `Finding` is the
 * rich form (dimension, confidence, evidence, element_ref, introduced-by-this-PR);
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

export interface Finding {
  dimension: Dimension;
  severity: Severity;
  /** Model confidence 0..1; capped by the capture confidence ceiling (TRD §5). */
  confidence: number;
  route: string;
  viewport: Viewport;
  /** Selector/role reference into the captured DOM geometry, or null. */
  elementRef: string | null;
  /** What was observed (grounds the finding; anti-hallucination). */
  evidence: string;
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
  /** UI-DNA genome version the critique was grounded against, or null. */
  uiDnaVersion: string | null;
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
}
