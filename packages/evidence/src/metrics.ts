/**
 * DLP-safe evidence-producer metrics (judgment-engine#156; TRD §18).
 *
 * The producer emits operational metrics for build/sign/verify latency, bundle
 * size, capability gaps, and rejection reasons, but NEVER raw page text,
 * prompts, screenshots, or secrets. Every metric event is a fixed catalog name
 * plus a strictly-allowlisted set of enum/id/hash labels; `assertEvidenceMetricSafe`
 * fails closed on an off-catalog name, an off-allowlist label key, or a
 * content-shaped label value (the same DLP posture as the metrics-catalog and
 * tracing contracts elsewhere in the org).
 */

export const EVIDENCE_METRICS_VERSION = "evidence-metrics/1" as const;

export type EvidenceMetricUnit = "milliseconds" | "bytes" | "count";

export type EvidenceMetricName =
  | "evidence_build_latency_ms"
  | "evidence_sign_latency_ms"
  | "evidence_verify_latency_ms"
  | "evidence_bundle_bytes"
  | "evidence_capability_gap_count"
  | "evidence_rejection_total";

export interface EvidenceMetricDef {
  name: EvidenceMetricName;
  unit: EvidenceMetricUnit;
  description: string;
}

export const EVIDENCE_METRICS: readonly EvidenceMetricDef[] = Object.freeze([
  { name: "evidence_build_latency_ms", unit: "milliseconds", description: "Deterministic bundle assembly time." },
  { name: "evidence_sign_latency_ms", unit: "milliseconds", description: "Ed25519 sign (incl. KMS round-trip) time." },
  { name: "evidence_verify_latency_ms", unit: "milliseconds", description: "Digest + signature verification time." },
  { name: "evidence_bundle_bytes", unit: "bytes", description: "Canonical bundle size." },
  { name: "evidence_capability_gap_count", unit: "count", description: "Optional capabilities not `complete`." },
  { name: "evidence_rejection_total", unit: "count", description: "Bundles rejected, by reason." },
]);

const CATALOG_NAMES: ReadonlySet<string> = new Set(EVIDENCE_METRICS.map((m) => m.name));

/**
 * Rejection reasons, mirroring the downstream consumer's gate `RejectionCode`
 * vocabulary, so producer rejection metrics use the SAME reason names the
 * consumer emits.
 */
export type EvidenceRejectionReason =
  | "schema_invalid"
  | "unsupported_major"
  | "tenant_mismatch"
  | "repository_mismatch"
  | "request_mismatch"
  | "commit_mismatch"
  | "ui_dna_version_mismatch"
  | "ui_dna_digest_mismatch"
  | "unknown_key"
  | "key_not_yet_valid"
  | "key_expired"
  | "key_revoked"
  | "key_tenant_mismatch"
  | "key_region_mismatch"
  | "digest_mismatch"
  | "signature_invalid"
  | "required_capability_incomplete"
  | "artifact_missing_content_hash"
  | "artifact_not_authorized"
  | "execution_policy_mismatch"
  | "undisclosed_execution"
  | "stale_generated_at";

/** DLP-safe labels: enum/id/hash only. There is structurally no field for content. */
export interface EvidenceMetricLabels {
  outcome?: "built" | "signed" | "verified" | "rejected";
  rejectionReason?: EvidenceRejectionReason;
  /** Opaque ids (never a name or content). */
  keyId?: string;
  tenantId?: string;
  producerVersion?: string;
  /** A capability id, e.g. `storybook.metadata`. */
  capability?: string;
}

export const ALLOWED_EVIDENCE_LABEL_KEYS: ReadonlySet<string> = new Set<keyof EvidenceMetricLabels>([
  "outcome",
  "rejectionReason",
  "keyId",
  "tenantId",
  "producerVersion",
  "capability",
]);

export interface EvidenceMetricEvent {
  name: EvidenceMetricName;
  value: number;
  at: string;
  labels?: EvidenceMetricLabels;
}

export class EvidenceMetricDlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceMetricDlpError";
  }
}

const MAX_LABEL_LENGTH = 128;

/**
 * A label value is "content-shaped" if it contains any control character (the
 * C0 range \u0000-\u001F, which includes \n \r \t \v \f; or DEL \u007F) or a
 * Unicode line/paragraph separator (\u2028 / \u2029). An id/enum never does;
 * raw text / prompts / secrets do. Checking only `\n` would let `\r`-delimited
 * or control-laden content slip past the DLP filter.
 */
// eslint-disable-next-line no-control-regex -- control chars are exactly what we reject
const CONTENT_SHAPED_LABEL = /[\u0000-\u001F\u007F\u2028\u2029]/;

export function isEvidenceMetric(name: string): boolean {
  return CATALOG_NAMES.has(name);
}

/**
 * Fail closed unless a metric event is DLP-safe: a known catalog metric, a
 * finite value, only whitelisted label keys, and every string label single-line
 * and short (an id/enum, never raw text/prompt/screenshot/secret).
 */
export function assertEvidenceMetricSafe(event: EvidenceMetricEvent): EvidenceMetricEvent {
  if (!isEvidenceMetric(event.name)) throw new EvidenceMetricDlpError(`unknown evidence metric "${event.name}"`);
  if (!Number.isFinite(event.value)) throw new EvidenceMetricDlpError("metric value must be finite");
  for (const [key, value] of Object.entries(event.labels ?? {})) {
    if (!ALLOWED_EVIDENCE_LABEL_KEYS.has(key)) {
      throw new EvidenceMetricDlpError(`label "${key}" is not a DLP-safe evidence-metric label`);
    }
    if (typeof value === "string" && (CONTENT_SHAPED_LABEL.test(value) || value.length > MAX_LABEL_LENGTH)) {
      throw new EvidenceMetricDlpError(`label "${key}" looks like content (control chars / line breaks or > ${MAX_LABEL_LENGTH} chars), not an id`);
    }
  }
  return event;
}
