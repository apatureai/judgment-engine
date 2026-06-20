/**
 * Eval-gated shadow promotion for the owned model (TRD §9/§10, #78). The ORPO
 * fine-tune (consuming the DVC dataset #75) and the shadow inference run are GPU
 * work (live); this is the engine-owned DECISION that gates a candidate
 * checkpoint: a candidate may be promoted behind the model adapter (#26) ONLY if
 *   (1) it passed the quality gate on the frozen golden+canary set (#48), AND
 *   (2) it BEATS the current production judge — improves the headline metric
 *       without regressing the trust metrics beyond tolerance.
 *
 * Pairing this with `ModelPromptRegistry.promote` (#71) means nothing reaches
 * production without a version bump + an eval pass + a measured win over today's
 * judge. Pure decision over already-computed scorecards.
 */

/** Headline + trust metrics for a judge on the frozen golden+canary set (#46/#47). */
export interface JudgeScorecard {
  /** Headline: fraction of true blockers caught (#46). */
  blockerRecall: number;
  /** Trust: fraction of emitted nits that are real (#46). */
  nitPrecision: number;
  /** Agreement with human grades (quadratic-weighted kappa, #46). */
  kappa: number;
  /** Hard safety bar: synthetic-canary recall (#44/#47). */
  canaryRecall: number;
}

export interface PromotionTolerances {
  /** Candidate must improve blocker recall by at least this much to count as a win. */
  minBlockerRecallGain: number;
  /** Trust metrics may dip by at most this much (noise tolerance), never more. */
  maxRegression: number;
}

export const DEFAULT_PROMOTION_TOLERANCES: PromotionTolerances = {
  minBlockerRecallGain: 0.01,
  maxRegression: 0.01,
};

/**
 * Does `candidate` beat `current`? Requires a real blocker-recall gain and no
 * material regression in nit precision, kappa, or canary recall. Returns the
 * decision plus the reasons it failed (empty when it wins).
 */
export function beatsCurrentJudge(
  candidate: JudgeScorecard,
  current: JudgeScorecard,
  tol: PromotionTolerances = DEFAULT_PROMOTION_TOLERANCES,
): { wins: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (candidate.blockerRecall < current.blockerRecall + tol.minBlockerRecallGain) {
    reasons.push(
      `blocker recall did not improve enough (${candidate.blockerRecall.toFixed(3)} vs ${current.blockerRecall.toFixed(3)}, need +${tol.minBlockerRecallGain})`,
    );
  }
  if (candidate.nitPrecision < current.nitPrecision - tol.maxRegression) {
    reasons.push(`nit precision regressed beyond tolerance`);
  }
  if (candidate.kappa < current.kappa - tol.maxRegression) {
    reasons.push(`kappa regressed beyond tolerance`);
  }
  if (candidate.canaryRecall < current.canaryRecall - tol.maxRegression) {
    reasons.push(`canary recall regressed beyond tolerance`);
  }

  return { wins: reasons.length === 0, reasons };
}

export interface ShadowPromotionInput {
  candidate: JudgeScorecard;
  /** The current production judge's scorecard, or null on first launch (no incumbent). */
  current: JudgeScorecard | null;
  /** Did the candidate pass the quality gate on the frozen set (#48)? */
  candidateGatePassed: boolean;
  tolerances?: PromotionTolerances;
}

export interface ShadowPromotionDecision {
  promote: boolean;
  reasons: string[];
}

/**
 * The eval-gated shadow-promotion decision (#78). Promote only when the quality
 * gate passed AND the candidate beats the incumbent. With no incumbent (first
 * model), a gate pass alone is sufficient.
 */
export function shadowPromotionDecision(input: ShadowPromotionInput): ShadowPromotionDecision {
  const reasons: string[] = [];

  if (!input.candidateGatePassed) {
    reasons.push("candidate did not pass the quality gate on the frozen golden+canary set");
  }

  if (input.current) {
    const cmp = beatsCurrentJudge(input.candidate, input.current, input.tolerances);
    if (!cmp.wins) reasons.push(...cmp.reasons);
  }

  return { promote: reasons.length === 0, reasons };
}
