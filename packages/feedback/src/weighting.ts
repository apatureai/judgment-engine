import type { FeedbackRecord, FeedbackSignal, RaterPermission } from "./store.js";

/**
 * Rater-permission down-weighting (TRD §8, #42). Collaborator verdicts
 * (owner/write) are the training-grade signal; drive-by thumbs from
 * non-collaborators (read/public) are heavily down-weighted so they inform but
 * don't dominate aggregation or the preference dataset (#43/#85).
 */
export const RATER_WEIGHTS: Record<RaterPermission, number> = {
  owner: 1,
  write: 1,
  read: 0.1,
  public: 0.1,
};

/** Aggregation weight for a rater's permission. */
export function raterWeight(permission: RaterPermission): number {
  return RATER_WEIGHTS[permission];
}

/** Collaborators (owner/write) produce training-grade verdicts. */
export function isTrainingGrade(permission: RaterPermission): boolean {
  return permission === "owner" || permission === "write";
}

/**
 * Signal polarity: +1 endorses the finding, -1 dismisses it, 0 neutral. Single
 * source of truth — consumed by `weightedConsensus` here and the memory digest
 * (#41) so the two can't silently disagree on how a signal scores.
 */
export const SIGNAL_POLARITY: Record<FeedbackSignal, number> = {
  thumbs_up: 1,
  applied: 1,
  // A recheck where the fix resolved the finding = strong positive (real + actionable).
  // Unresolved is ambiguous (bad finding or bad fix) -> neutral.
  recheck_resolved: 1,
  recheck_unresolved: 0,
  thumbs_down: -1,
  ignore: -1,
  merged_blockers_unresolved: -1,
  recheck: 0,
};

export interface WeightedConsensus {
  /** Permission-weighted net score over all signals (>0 endorsed, <0 dismissed). */
  score: number;
  /** Count of training-grade (collaborator) signals. */
  trainingGradeCount: number;
}

/** Aggregate feedback into a permission-weighted consensus for a finding. */
export function weightedConsensus(
  feedback: Pick<FeedbackRecord, "signal" | "raterPermission">[],
): WeightedConsensus {
  let score = 0;
  let trainingGradeCount = 0;
  for (const f of feedback) {
    score += SIGNAL_POLARITY[f.signal] * raterWeight(f.raterPermission);
    if (isTrainingGrade(f.raterPermission)) trainingGradeCount++;
  }
  return { score, trainingGradeCount };
}
