/**
 * Gated SLO metrics (TRD §9/§14, #72). The hallucination-drop rate (findings
 * dropped by the #32 gate for unknown route/element_ref) and the capture-
 * instability rate (#15) are made FIRST-CLASS gated SLOs, not just logs: each has
 * a target, a breach is a gate signal that blocks promotion (composes with the
 * eval gate #47/#48), and both are already surfaced on the Grafana SLO dashboard
 * + alerts (#9). This module is the pure target check over computed rates.
 */
export interface SloTargets {
  /** Max fraction of findings dropped by the hallucination gate. */
  maxHallucinationDropRate: number;
  /** Max fraction of captures flagged visually unstable. */
  maxCaptureInstabilityRate: number;
}

export const DEFAULT_SLO_TARGETS: SloTargets = {
  maxHallucinationDropRate: 0.1,
  maxCaptureInstabilityRate: 0.05,
};

export interface SloCounts {
  /** Findings dropped by the #32 gate. */
  hallucinationDrops: number;
  /** Total findings produced before the gate. */
  totalFindings: number;
  /** Captures flagged unstable by #15. */
  unstableCaptures: number;
  /** Total captures. */
  totalCaptures: number;
}

export interface SloResult {
  passed: boolean;
  hallucinationDropRate: number;
  captureInstabilityRate: number;
  breaches: string[];
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Check the SLO rates against their targets; a breach is a gate/alert signal. */
export function evaluateSlos(counts: SloCounts, targets: SloTargets = DEFAULT_SLO_TARGETS): SloResult {
  const hallucinationDropRate = rate(counts.hallucinationDrops, counts.totalFindings);
  const captureInstabilityRate = rate(counts.unstableCaptures, counts.totalCaptures);
  const breaches: string[] = [];

  if (hallucinationDropRate > targets.maxHallucinationDropRate) {
    breaches.push(
      `hallucination-drop rate ${hallucinationDropRate.toFixed(3)} > target ${targets.maxHallucinationDropRate}`,
    );
  }
  if (captureInstabilityRate > targets.maxCaptureInstabilityRate) {
    breaches.push(
      `capture-instability rate ${captureInstabilityRate.toFixed(3)} > target ${targets.maxCaptureInstabilityRate}`,
    );
  }

  return { passed: breaches.length === 0, hallucinationDropRate, captureInstabilityRate, breaches };
}
