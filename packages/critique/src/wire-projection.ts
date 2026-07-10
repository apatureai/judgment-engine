import type { Critique, EngineReviewResult, Finding, WireFinding } from "@engine/types";

/**
 * Project the engine's internal `Critique` into the consumer-facing wire result
 * `EngineReviewResult` (TRD §2/§8). This IS the cross-repo contract boundary with
 * Gate: the async job API returns this shape, and it must stay byte-compatible
 * with `fixtures/gate-review-result.golden.json`. The internal `Finding` is the
 * rich form (dimension/confidence/introducedByThisPr) — dimension and
 * introducedByThisPr are DROPPED here (internal-only), while `confidence`
 * passes through per finding since #150 (it is the engine's calibrated,
 * ceiling-capped signal; consumers like MCP Review must not fabricate one).
 * The wire form stays the projected, stable subset Gate renders.
 *
 * Pure. The screenshot-id and artifact-URL resolution are injected (the worker
 * binds them to the captured-image set + the object-store signed-URL base);
 * absent ⇒ no annotated screenshot for that finding.
 *
 * The model emits a dedicated `title` + `description` per finding (#100); the
 * projection passes them through. `deriveTitle` remains only as a DEFENSIVE
 * fallback for a finding whose title is empty/whitespace — it derives one from
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
  /** Screenshot retention seconds (tier retention policy, #51). */
  screenshotRetentionSeconds: number;
}

/** Project one internal finding to its wire form (internal-only fields dropped). */
function toWireFinding(finding: Finding, index: number, options: WireProjectionOptions): WireFinding {
  const screenshotId = options.screenshotIdFor?.(finding, index) ?? null;
  return {
    id: wireFindingId(index),
    severity: finding.severity,
    // Pass the model-emitted title through; fall back to a derived one only if blank.
    title: finding.title.trim().length > 0 ? finding.title : deriveTitle(finding.description),
    description: finding.description,
    route: finding.route,
    viewport: finding.viewport,
    element: finding.elementRef,
    screenshotId,
    suggestion: finding.suggestion,
    // Already ceiling-capped upstream (#70); passed through, never recomputed (#150).
    confidence: finding.confidence,
  };
}

/**
 * Result-level confidence (#150): the minimum over finding confidences — the
 * result is only as trustworthy as its least-confident finding — and `1` for a
 * clean no-findings result. Defined HERE, once, so no consumer invents its own
 * aggregate.
 */
function resultConfidence(findings: readonly Finding[]): number {
  return findings.reduce((least, f) => Math.min(least, f.confidence), 1);
}

/** Project the internal critique into the cross-repo wire result Gate consumes. */
export function toEngineReviewResult(critique: Critique, options: WireProjectionOptions): EngineReviewResult {
  const findings = critique.findings.map((f, i) => toWireFinding(f, i, options));

  const annotatedScreenshots = findings
    .filter((f): f is WireFinding & { screenshotId: string } => f.screenshotId !== null)
    .map((f) => ({
      findingId: f.id,
      url: options.artifactUrlFor ? options.artifactUrlFor(f.screenshotId) : f.screenshotId,
    }));

  return {
    grade: critique.grade,
    overall: critique.overall,
    confidence: resultConfidence(critique.findings),
    findings,
    notReviewed: critique.notReviewed,
    artifacts: {
      annotatedScreenshots,
      // engineDebugUrl is optional on the wire — only set it when present.
      ...(options.engineDebugUrl !== undefined ? { engineDebugUrl: options.engineDebugUrl } : {}),
      // Page-health footnote (#20) — only when capture reported something; a
      // clean page omits the field so the wire result stays byte-compatible.
      ...(options.pageHealthFootnote ? { pageHealthFootnote: options.pageHealthFootnote } : {}),
    },
    screenshotRetentionSeconds: options.screenshotRetentionSeconds,
    metadata: critique.metadata,
  };
}
