import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseReleaseCandidate,
  releaseGate,
  type ReleaseCandidateV1,
} from "../src/index.js";
import { sampleCalibrationReport } from "./calibration-report-fixture.js";

const fixture = (name: string): ReleaseCandidateV1 =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/release/${name}`, import.meta.url)), "utf8"),
  ) as ReleaseCandidateV1;

const NOW = new Date("2026-07-14T00:00:00.000Z");
const opts = { now: () => NOW };

/** The blocking-mode candidate: the passing fixture + a matching, current report. */
function blockingCandidate(overrides: Partial<ReleaseCandidateV1> = {}): ReleaseCandidateV1 {
  return {
    ...fixture("passing.advisory.json"),
    targetMode: "blocking",
    calibrationReport: sampleCalibrationReport(),
    ...overrides,
  };
}

describe("releaseGate (#155)", () => {
  it("promotes the passing advisory candidate with an archived, stamped decision", () => {
    const decision = releaseGate(fixture("passing.advisory.json"), opts);
    expect(decision.promote).toBe(true);
    expect(decision.reasons).toEqual([]);
    expect(decision.stamp.model).toBe("qwen3-vl");
    expect(decision.frozenCaptureSetId).toBe("frozen_2026_07_a");
    expect(decision.decidedAt).toBe(NOW.toISOString());
    expect(decision.blockingGuard).toEqual({ required: false, passed: true, reasons: [] });
  });

  it("BLOCKS a candidate that regresses the golden-set gate (the #155 deliberate-regression proof)", () => {
    const decision = releaseGate(fixture("regressed.blocked.json"), opts);
    expect(decision.promote).toBe(false);
    expect(decision.reasons.some((r) => r.startsWith("quality: blocker recall"))).toBe(true);
  });

  it("blocks on an SLO breach even when quality passes", () => {
    const candidate = fixture("passing.advisory.json");
    candidate.sloCounts = { hallucinationDrops: 20, totalFindings: 100, unstableCaptures: 0, totalCaptures: 40 };
    const decision = releaseGate(candidate, opts);
    expect(decision.promote).toBe(false);
    expect(decision.reasons.some((r) => r.startsWith("slo:"))).toBe(true);
  });

  it("same artifact, same verdict (deterministic for CI + audit replay)", () => {
    const a = releaseGate(fixture("passing.advisory.json"), opts);
    const b = releaseGate(fixture("passing.advisory.json"), opts);
    expect(a).toEqual(b);
  });
});

describe("blocking-mode guard (E11, #155)", () => {
  it("blocking without any calibration report is blocked", () => {
    const decision = releaseGate(
      { ...fixture("passing.advisory.json"), targetMode: "blocking", calibrationReport: null },
      opts,
    );
    expect(decision.promote).toBe(false);
    expect(decision.blockingGuard).toMatchObject({ required: true, passed: false });
    expect(decision.reasons[0]).toContain("requires a calibration report");
  });

  it("a current, matching, sufficient-evidence report within the E11 bar promotes", () => {
    const report = sampleCalibrationReport();
    const decision = releaseGate(blockingCandidate({ calibrationReport: report }), opts);
    expect(decision.blockingGuard.passed).toBe(true);
    expect(decision.promote).toBe(true);
    expect(decision.mode).toBe("blocking");
  });

  it("blocks when the blocker false-positive UPPER bound exceeds the false-block target", () => {
    const report = sampleCalibrationReport();
    report.risk.blockerFalsePositiveRate = { estimate: 0.02, lower: 0.01, upper: 0.04, confidenceLevel: 0.95 };
    report.risk.falseBlockTarget = 0.025;
    const decision = releaseGate(blockingCandidate({ calibrationReport: report }), opts);
    expect(decision.promote).toBe(false);
    expect(decision.reasons.some((r) => r.includes("E11"))).toBe(true);
  });

  it("blocks an expired report and an identity mismatch", () => {
    const expired = sampleCalibrationReport();
    expired.validUntil = "2026-07-01T00:00:00.000Z";
    expect(releaseGate(blockingCandidate({ calibrationReport: expired }), opts).promote).toBe(false);

    const mismatched = sampleCalibrationReport();
    mismatched.identity.promptVersion = "gate-design-review@8";
    const decision = releaseGate(blockingCandidate({ calibrationReport: mismatched }), opts);
    expect(decision.promote).toBe(false);
    expect(decision.reasons.some((r) => r.includes("promptVersion"))).toBe(true);
  });

  it("blocks an insufficient-evidence report", () => {
    const report = sampleCalibrationReport();
    report.evidenceStatus = "insufficient_evidence";
    const decision = releaseGate(blockingCandidate({ calibrationReport: report }), opts);
    expect(decision.promote).toBe(false);
    expect(decision.reasons.some((r) => r.includes("insufficient_evidence"))).toBe(true);
  });
});

describe("parseReleaseCandidate (CLI/CI input hardening)", () => {
  it("accepts the checked-in fixtures and rejects malformed inputs with reasons", () => {
    expect(parseReleaseCandidate(fixture("passing.advisory.json")).ok).toBe(true);
    expect(parseReleaseCandidate(null)).toMatchObject({ ok: false });
    expect(parseReleaseCandidate({ schemaVersion: "2" })).toMatchObject({ ok: false, error: expect.stringContaining("schemaVersion") });
    expect(parseReleaseCandidate({ schemaVersion: "1", targetMode: "yolo" })).toMatchObject({ ok: false, error: expect.stringContaining("targetMode") });
    const noReport = { ...fixture("passing.advisory.json") } as Record<string, unknown>;
    delete noReport["calibrationReport"];
    expect(parseReleaseCandidate(noReport)).toMatchObject({ ok: false, error: expect.stringContaining("calibrationReport") });
  });
});
