import { describe, expect, it } from "vitest";
import {
  assertEvidenceMetricSafe,
  EVIDENCE_METRICS,
  EVIDENCE_METRICS_VERSION,
  EvidenceMetricDlpError,
  isEvidenceMetric,
  type EvidenceMetricEvent,
} from "../src/index.js";

describe("evidence metric catalog (#156, TRD §18)", () => {
  it("every metric has a name + unit; the version is stable", () => {
    expect(EVIDENCE_METRICS_VERSION).toBe("evidence-metrics/1");
    for (const m of EVIDENCE_METRICS) {
      expect(m.unit).toBeTruthy();
      expect(isEvidenceMetric(m.name)).toBe(true);
    }
    expect(isEvidenceMetric("made_up")).toBe(false);
  });
});

describe("DLP-safe evidence metrics — nothing sensitive in telemetry (#156)", () => {
  const base: EvidenceMetricEvent = {
    name: "evidence_sign_latency_ms",
    value: 12,
    at: "2026-07-16T00:00:00Z",
    labels: { outcome: "signed", keyId: "je-key-1", producerVersion: "1.4.0" },
  };

  it("accepts allowlisted id/enum labels, including a rejection reason mirroring the gate vocab", () => {
    expect(assertEvidenceMetricSafe(base)).toBe(base);
    const rejected: EvidenceMetricEvent = {
      name: "evidence_rejection_total",
      value: 1,
      at: base.at,
      labels: { outcome: "rejected", rejectionReason: "signature_invalid", tenantId: "t1" },
    };
    expect(assertEvidenceMetricSafe(rejected)).toBe(rejected);
  });

  it("rejects an off-catalog metric name and a non-finite value", () => {
    expect(() => assertEvidenceMetricSafe({ ...base, name: "leak_metric" as never })).toThrow(EvidenceMetricDlpError);
    expect(() => assertEvidenceMetricSafe({ ...base, value: Number.NaN })).toThrow(/finite/);
  });

  it("rejects an off-allowlist label key (e.g. page text / prompt / screenshot)", () => {
    expect(() => assertEvidenceMetricSafe({ ...base, labels: { pageText: "the whole page" } as never })).toThrow(EvidenceMetricDlpError);
    expect(() => assertEvidenceMetricSafe({ ...base, labels: { prompt: "system: ..." } as never })).toThrow(/DLP-safe/);
  });

  it("rejects a content-shaped value smuggled into an allowlisted id label", () => {
    expect(() => assertEvidenceMetricSafe({ ...base, labels: { keyId: "line1\nline2" } })).toThrow(/content/);
    expect(() => assertEvidenceMetricSafe({ ...base, labels: { capability: "x".repeat(200) } })).toThrow(EvidenceMetricDlpError);
  });

  it("rejects non-\\n line breaks and control chars (not just \\n) in a label value", () => {
    // \r-delimited or control-laden content under 128 chars must not slip past the DLP filter.
    expect(() => assertEvidenceMetricSafe({ ...base, labels: { keyId: "line1\rline2" } })).toThrow(/content/);
    expect(() => assertEvidenceMetricSafe({ ...base, labels: { keyId: "line1\r\nline2" } })).toThrow(/content/);
    expect(() => assertEvidenceMetricSafe({ ...base, labels: { tenantId: "a\tb" } })).toThrow(/content/);
    expect(() => assertEvidenceMetricSafe({ ...base, labels: { capability: "a\u2028b" } })).toThrow(/content/); // line separator
    expect(() => assertEvidenceMetricSafe({ ...base, labels: { producerVersion: "a\u0000b" } })).toThrow(/content/); // NUL
  });

  it("still admits legitimate single-line ids (no false positives)", () => {
    const ok = {
      ...base,
      labels: {
        keyId: "sha256:0f1e2d",
        tenantId: "550e8400-e29b-41d4-a716-446655440000",
        capability: "storybook.metadata",
        producerVersion: "evidence-producer/1",
      },
    };
    expect(assertEvidenceMetricSafe(ok)).toBe(ok);
  });
});
