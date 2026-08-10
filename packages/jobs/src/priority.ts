/**
 * Job priority for fair scheduling (#67; architecture review E6). Lower number =
 * higher priority. Gate's blocking PR reviews outrank Gate's background/recheck
 * work, which outranks other consumers, so one consumer's burst can't starve
 * the interactive path. The value is stored on the job row and the claim orders
 * by (priority, created_at).
 */
export const JOB_PRIORITY = {
  gateBlocking: 0,
  gateBackground: 10,
  other: 20,
} as const;

/** Compute a job's scheduling priority from its consumer + intent. */
export function jobPriority(consumer: string, intentType: string): number {
  if (consumer === "gate") {
    return /background|recheck/i.test(intentType) ? JOB_PRIORITY.gateBackground : JOB_PRIORITY.gateBlocking;
  }
  return JOB_PRIORITY.other;
}
