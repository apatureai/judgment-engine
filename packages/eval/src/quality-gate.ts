import { canaryRecall, type CanaryEvalInput } from "./regression-gate.js";

/**
 * Go/no-go quality gate (TRD §13/§10/§14, #48). On a FROZEN capture set (so
 * capture flakiness is excluded from the judgment), the critique must clear the
 * §10 bars before any surface/delivery work begins: canary recall ~100% (#44),
 * plus blocker-recall, nit-precision, and grade-agreement (kappa, #46) bars on
 * the golden set. Produces a documented sign-off record; surface work is
 * unblocked only after a passing sign-off.
 *
 * Pure decision over already-computed eval results (the frozen-set batch run is
 * the live seam). Default bars are configurable.
 */
export interface QualityBars {
  canaryRecallTarget: number;
  blockerRecallMin: number;
  nitPrecisionMin: number;
  kappaMin: number;
}

export const DEFAULT_QUALITY_BARS: QualityBars = {
  canaryRecallTarget: 0.99,
  blockerRecallMin: 0.85,
  nitPrecisionMin: 0.75,
  kappaMin: 0.6,
};

export interface QualityGateInput {
  /** Frozen capture set id this ran against (excludes capture flakiness). */
  frozenCaptureSetId: string;
  /** Canary predictions for recall (#44/#47). */
  canary: CanaryEvalInput;
  /** Golden-set metrics computed via #46. */
  blockerRecall: number;
  nitPrecision: number;
  /** Model-vs-human grade agreement (quadratic-weighted kappa / #84). */
  kappa: number;
  /** Who signed off (recorded; null = unsigned). */
  signoffBy?: string;
}

export interface QualityGateResult {
  passed: boolean;
  metrics: { canaryRecall: number; blockerRecall: number; nitPrecision: number; kappa: number };
  failedBars: string[];
  signoff: { frozenCaptureSetId: string; by: string | null; passed: boolean };
}

export function qualityGate(
  input: QualityGateInput,
  bars: QualityBars = DEFAULT_QUALITY_BARS,
): QualityGateResult {
  const recall = canaryRecall(input.canary);
  const metrics = {
    canaryRecall: recall,
    blockerRecall: input.blockerRecall,
    nitPrecision: input.nitPrecision,
    kappa: input.kappa,
  };

  const failedBars: string[] = [];
  if (recall < bars.canaryRecallTarget) failedBars.push(`canary recall ${recall.toFixed(3)} < ${bars.canaryRecallTarget}`);
  if (input.blockerRecall < bars.blockerRecallMin) failedBars.push(`blocker recall ${input.blockerRecall.toFixed(3)} < ${bars.blockerRecallMin}`);
  if (input.nitPrecision < bars.nitPrecisionMin) failedBars.push(`nit precision ${input.nitPrecision.toFixed(3)} < ${bars.nitPrecisionMin}`);
  if (input.kappa < bars.kappaMin) failedBars.push(`kappa ${input.kappa.toFixed(3)} < ${bars.kappaMin}`);

  const passed = failedBars.length === 0;
  return {
    passed,
    metrics,
    failedBars,
    signoff: { frozenCaptureSetId: input.frozenCaptureSetId, by: input.signoffBy ?? null, passed },
  };
}
