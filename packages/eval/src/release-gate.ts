import type { CalibrationReportV1 } from "./calibration-report.js";
import { DEFAULT_QUALITY_BARS, qualityGate, type QualityBars, type QualityGateInput, type QualityGateResult } from "./quality-gate.js";
import type { RegistryStamp } from "./registry.js";
import { DEFAULT_SLO_TARGETS, evaluateSlos, type SloCounts, type SloResult, type SloTargets } from "./slo.js";

/**
 * Release gate (#155; TRD §10/§13/§14).
 *
 * The single promote/block decision over a candidate (model, prompt, engine,
 * capture, rubric) triplet's frozen-set eval results. It composes the pieces
 * that already exist — the §10 quality gate, the gated SLOs, and the
 * CalibrationReportV1 contract — into ONE archived decision artifact that CI
 * enforces: a candidate that regresses the golden-set bars, breaches an SLO,
 * or (for blocking mode) lacks a current, matching, sufficient-evidence
 * calibration report whose false-block risk clears the E11 bar CANNOT be
 * promoted. The decision is pure and deterministic over the candidate
 * artifact, so the same JSON always yields the same verdict in CI, staging,
 * and an audit replay.
 *
 * This gate decides *eligibility*. The durable promotion record (and the
 * additional attestation checks for blocking mode) remain
 * `ModelPromptRegistry.promote` — run the gate first, then record.
 */

export interface ReleaseCandidateV1 {
  schemaVersion: "1";
  /** The exact version triplet under evaluation; must match the calibration report's identity. */
  stamp: RegistryStamp;
  /** Promotion target. Blocking mode adds the E11 calibration guard. */
  targetMode: "advisory" | "blocking";
  /** Frozen-set eval results (§10 bars) — capture flakiness excluded by construction. */
  quality: QualityGateInput;
  /** Gated SLO counts from the same eval batch (#72). */
  sloCounts: SloCounts;
  /** Required for blocking mode; advisory candidates may carry null. */
  calibrationReport: CalibrationReportV1 | null;
}

export interface BlockingGuardResult {
  /** Whether the guard applied (targetMode === "blocking"). */
  required: boolean;
  passed: boolean;
  reasons: string[];
}

export interface ReleaseDecisionV1 {
  schemaVersion: "1";
  promote: boolean;
  mode: "advisory" | "blocking";
  stamp: RegistryStamp;
  frozenCaptureSetId: string;
  quality: QualityGateResult;
  slo: SloResult;
  blockingGuard: BlockingGuardResult;
  /** Every reason the candidate was blocked; empty exactly when promote=true. */
  reasons: string[];
  decidedAt: string;
}

export interface ReleaseGateOptions {
  bars?: QualityBars;
  sloTargets?: SloTargets;
  now?: () => Date;
}

/**
 * The E11 severity-calibration guard for blocking mode: the report must exist,
 * carry sufficient evidence, be current, describe EXACTLY this candidate
 * triplet, and show the blocker false-positive rate within the declared
 * false-block target at the interval's UPPER bound (conservative: the risk we
 * can't rule out, not the point estimate, must clear the bar).
 */
function blockingGuard(
  candidate: ReleaseCandidateV1,
  now: Date,
): BlockingGuardResult {
  if (candidate.targetMode !== "blocking") return { required: false, passed: true, reasons: [] };

  const reasons: string[] = [];
  const report = candidate.calibrationReport;
  if (report === null) {
    return { required: true, passed: false, reasons: ["blocking mode requires a calibration report; none supplied"] };
  }
  if (report.evidenceStatus !== "sufficient_evidence") {
    reasons.push(`calibration evidence is ${report.evidenceStatus}`);
  }
  if (now.getTime() >= Date.parse(report.validUntil)) {
    reasons.push(`calibration report expired at ${report.validUntil}`);
  }
  for (const key of ["model", "promptVersion", "engineVersion", "captureVersion", "rubricVersion"] as const) {
    if (report.identity[key] !== candidate.stamp[key]) {
      reasons.push(`calibration identity ${key} "${report.identity[key]}" does not match candidate "${candidate.stamp[key]}"`);
    }
  }
  const bfpr = report.risk.blockerFalsePositiveRate;
  if (bfpr.upper > report.risk.falseBlockTarget) {
    reasons.push(
      `blocker false-positive rate upper bound ${bfpr.upper} exceeds the false-block target ${report.risk.falseBlockTarget} (E11)`,
    );
  }
  return { required: true, passed: reasons.length === 0, reasons };
}

/** Decide promote/block for a release candidate. Pure; same artifact, same verdict. */
export function releaseGate(
  candidate: ReleaseCandidateV1,
  options: ReleaseGateOptions = {},
): ReleaseDecisionV1 {
  const now = options.now ?? ((): Date => new Date());
  const quality = qualityGate(candidate.quality, options.bars ?? DEFAULT_QUALITY_BARS);
  const slo = evaluateSlos(candidate.sloCounts, options.sloTargets ?? DEFAULT_SLO_TARGETS);
  const guard = blockingGuard(candidate, now());

  const reasons: string[] = [
    ...quality.failedBars.map((bar) => `quality: ${bar}`),
    ...slo.breaches.map((breach) => `slo: ${breach}`),
    ...guard.reasons.map((reason) => `blocking-guard: ${reason}`),
  ];

  return {
    schemaVersion: "1",
    promote: quality.passed && slo.passed && guard.passed,
    mode: candidate.targetMode,
    stamp: candidate.stamp,
    frozenCaptureSetId: candidate.quality.frozenCaptureSetId,
    quality,
    slo,
    blockingGuard: guard,
    reasons,
    decidedAt: now().toISOString(),
  };
}

/** Structural check for CLI/CI inputs; returns a reason instead of throwing. */
export function parseReleaseCandidate(value: unknown): { ok: true; candidate: ReleaseCandidateV1 } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "candidate is not an object" };
  const c = value as Partial<ReleaseCandidateV1>;
  if (c.schemaVersion !== "1") return { ok: false, error: `unsupported candidate schemaVersion ${String(c.schemaVersion)}` };
  if (c.targetMode !== "advisory" && c.targetMode !== "blocking") return { ok: false, error: "targetMode must be advisory or blocking" };
  if (typeof c.stamp !== "object" || c.stamp === null) return { ok: false, error: "missing stamp" };
  if (typeof c.quality !== "object" || c.quality === null) return { ok: false, error: "missing quality input" };
  if (typeof c.sloCounts !== "object" || c.sloCounts === null) return { ok: false, error: "missing sloCounts" };
  if (c.calibrationReport === undefined) return { ok: false, error: "calibrationReport must be present (null for advisory)" };
  return { ok: true, candidate: c as ReleaseCandidateV1 };
}
