import type { Finding } from "@engine/types";

/**
 * Trust-budget post-filter (TRD §6.5, #33). After the hallucination gate (#32):
 *   1. drop findings below the confidence floor (0.55),
 *   2. dedupe by `elementRef` + `dimension` across viewports (the same issue seen
 *      on mobile and desktop is one finding — keep the highest-confidence one),
 *   3. cap at 1 blocker + 6 other findings, with deterministic ordering, so the
 *      reviewer's trust budget isn't blown by a wall of low-value nits.
 */
export interface PostFilterOptions {
  minConfidence?: number;
  maxBlockers?: number;
  maxOthers?: number;
}

const SEVERITY_RANK: Record<Finding["severity"], number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

/** Stable ordering: severity, then confidence desc, then route/dimension for determinism. */
function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.confidence - a.confidence ||
    a.route.localeCompare(b.route) ||
    a.dimension.localeCompare(b.dimension) ||
    (a.elementRef ?? "").localeCompare(b.elementRef ?? "")
  );
}

export function postFilter(findings: Finding[], options: PostFilterOptions = {}): Finding[] {
  const minConfidence = options.minConfidence ?? 0.55;
  const maxBlockers = options.maxBlockers ?? 1;
  const maxOthers = options.maxOthers ?? 6;

  // 1. confidence floor
  const confident = findings.filter((f) => f.confidence >= minConfidence);

  // 2. dedupe by elementRef + dimension across viewports (keep highest confidence)
  const best = new Map<string, Finding>();
  for (const f of confident) {
    const key = `${f.dimension}|${f.elementRef ?? ""}`;
    const existing = best.get(key);
    if (!existing || f.confidence > existing.confidence) best.set(key, f);
  }
  const deduped = [...best.values()].sort(compareFindings);

  // 3. cap: 1 blocker + 6 others, deterministic.
  const blockers = deduped.filter((f) => f.severity === "blocker").slice(0, maxBlockers);
  const others = deduped.filter((f) => f.severity !== "blocker").slice(0, maxOthers);
  return [...blockers, ...others].sort(compareFindings);
}
