import type { Critique, EngineReviewResult, Finding, WireFinding } from "@engine/types";

/**
 * Project the engine's internal `Critique` into the consumer-facing wire result
 * `EngineReviewResult` (TRD §2/§8). This IS the cross-repo contract boundary with
 * Gate: the async job API returns this shape, and it must stay byte-compatible
 * with `fixtures/gate-review-result.golden.json`. The internal `Finding` is the
 * rich form (dimension/confidence/evidence/introducedByThisPr) — those internal
 * fields are DROPPED here; the wire form is the projected, stable subset Gate
 * renders.
 *
 * Pure. The screenshot-id and artifact-URL resolution are injected (the worker
 * binds them to the captured-image set + the object-store signed-URL base);
 * absent ⇒ no annotated screenshot for that finding.
 *
 * NOTE (interim): the model output schema (#31) carries a single `evidence`
 * string, not a separate `title`/`description`. Here `description = evidence` and
 * `title` is a concise summary derived from it. A dedicated model-emitted title
 * is the faithful fix (needs a frozen-prompt version bump + eval) — tracked
 * separately; deriving keeps the wire shape correct in the meantime.
 */

const MAX_TITLE_LEN = 80;

/** Derive a concise finding title from its evidence (interim — see module note). */
export function deriveTitle(evidence: string): string {
  const trimmed = evidence.trim();
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
  /** Screenshot retention seconds (tier retention policy, #51). */
  screenshotRetentionSeconds: number;
}

/** Project one internal finding to its wire form (internal-only fields dropped). */
function toWireFinding(finding: Finding, index: number, options: WireProjectionOptions): WireFinding {
  const screenshotId = options.screenshotIdFor?.(finding, index) ?? null;
  return {
    id: wireFindingId(index),
    severity: finding.severity,
    title: deriveTitle(finding.evidence),
    description: finding.evidence,
    route: finding.route,
    viewport: finding.viewport,
    element: finding.elementRef,
    screenshotId,
    suggestion: finding.suggestion,
  };
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
    findings,
    notReviewed: critique.notReviewed,
    artifacts: {
      annotatedScreenshots,
      // engineDebugUrl is optional on the wire — only set it when present.
      ...(options.engineDebugUrl !== undefined ? { engineDebugUrl: options.engineDebugUrl } : {}),
    },
    screenshotRetentionSeconds: options.screenshotRetentionSeconds,
    metadata: critique.metadata,
  };
}
