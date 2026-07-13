import {
  calibrationAttestedPayloadHash,
  type CalibrationReportV1,
  type IntervalEstimateV1,
} from "../src/index.js";

const interval = (estimate: number, lower: number, upper: number): IntervalEstimateV1 => ({
  estimate,
  lower,
  upper,
  confidenceLevel: 0.95,
});

export function sampleCalibrationReport(options: {
  attested?: boolean;
  overrides?: Partial<CalibrationReportV1>;
} = {}): CalibrationReportV1 {
  const report: CalibrationReportV1 = {
    schemaVersion: "1",
    reportId: "calibration_qwen3vl_2026_07",
    calibrationVersion: "isotonic@1",
    confidenceSource: "post_hoc_isotonic",
    identity: {
      model: "qwen3-vl",
      promptVersion: "gate-design-review@7",
      engineVersion: "2026.06.0",
      captureVersion: "playwright-capture@3",
      rubricVersion: "design-rubric@1",
    },
    manifests: {
      fitManifestHash: `sha256:${"1".repeat(64)}`,
      evalManifestHash: `sha256:${"2".repeat(64)}`,
    },
    splitPolicy: {
      repository: "held-out repository groups; no repository crosses fit/eval",
      team: "held-out teams with per-team lower bounds",
      time: "forward-only evaluation window after fit cutoff",
      requiredCohorts: ["visual_text_conflict"],
    },
    sampleCounts: {
      fit: 120,
      evaluation: 80,
      byCohort: { visual_text_conflict: 20 },
    },
    reliability: {
      bins: [
        { lower: 0, upper: 0.5, count: 40, predictedMean: 0.3, empiricalRate: 0.25 },
        { lower: 0.5, upper: 1, count: 40, predictedMean: 0.8, empiricalRate: 0.775 },
      ],
      ece: interval(0.0375, 0.02, 0.06),
      brier: interval(0.14, 0.11, 0.18),
    },
    risk: {
      aurc: interval(0.09, 0.07, 0.12),
      coverageAtFalseBlockTarget: interval(0.72, 0.65, 0.78),
      blockerFalsePositiveRate: interval(0.01, 0, 0.025),
      precision: interval(0.94, 0.9, 0.97),
      validReferenceRate: interval(0.998, 0.995, 1),
      falseBlockTarget: 0.025,
      cohorts: [
        {
          cohort: "visual_text_conflict",
          samples: 20,
          ece: interval(0.05, 0.02, 0.1),
          brier: interval(0.16, 0.1, 0.23),
          blockerFalsePositiveRate: interval(0, 0, 0.05),
          validReferenceRate: interval(1, 0.95, 1),
          status: "pass",
        },
      ],
    },
    thresholds: {
      postFilterMinConfidence: 0.62,
      blockingMinConfidence: 0.9,
      unstableCaptureMaxConfidence: 0.58,
    },
    transform: {
      kind: "isotonic_v1",
      knots: [
        { raw: 0, calibrated: 0.05 },
        { raw: 0.5, calibrated: 0.4 },
        { raw: 0.8, calibrated: 0.7 },
        { raw: 1, calibrated: 0.93 },
      ],
    },
    evidenceStatus: "sufficient_evidence",
    createdAt: "2026-07-12T00:00:00.000Z",
    validUntil: "2027-01-12T00:00:00.000Z",
    attestation: null,
    ...options.overrides,
  };
  if (options.attested) {
    report.attestation = {
      algorithm: "ed25519",
      keyId: "release-key-2026-07",
      signedPayloadHash: calibrationAttestedPayloadHash(report),
      signature: "fixture-signature",
    };
  }
  return report;
}
