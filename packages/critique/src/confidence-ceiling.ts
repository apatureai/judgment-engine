import type { Finding } from "@engine/types";

/**
 * Confidence-ceiling propagation (TRD §5, #70). When the capture stability gate
 * (#15) flags a page as visually unstable, every finding's confidence is capped
 * at the ceiling so an unreliable render can't yield high-confidence findings;
 * the result also carries `validation.captureUnstable = true`. The cap runs
 * before the post-filter (#33), and the ceiling (0.6) sits above the 0.55 floor,
 * so capped findings still surface — just with lowered trust.
 */
export function applyConfidenceCeiling(findings: Finding[], ceiling: number): Finding[] {
  return findings.map((f) => (f.confidence > ceiling ? { ...f, confidence: ceiling } : f));
}
