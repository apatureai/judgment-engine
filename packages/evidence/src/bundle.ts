/**
 * `DerivedEvidenceBundleV1`: the producer-owned contract for the signed
 * evidence package Judgment Engine returns for an `EvidenceRequestV1` (core
 * TRD §3.2). It is the ONLY door evidence enters through, so it is
 * fail-closed on identity + integrity: tenant/repo/request/commit/UI-DNA bind to
 * the originating request, and the RFC 8785 canonical digest + Ed25519 signature
 * verify. Entropy Engine's `EvidenceAcceptanceGate` is the consumer; this shape
 * maps 1:1 to Entropy's read profile so one golden verifies byte-for-byte in
 * both repositories.
 *
 * Provenance is not authority (SCITT): a valid signature attests
 * lineage only; it never creates a finding, approves UI DNA, or makes feedback
 * training-grade. That decision is the consumer's, downstream of this bundle.
 */

/** The `major.minor.patch` this producer emits; Entropy accepts any matching major. */
export const DERIVED_EVIDENCE_BUNDLE_SCHEMA_VERSION = "1.0.0" as const;

export type AdapterRunStatus = "complete" | "partial" | "unsupported" | "failed";

export interface AdapterRun {
  adapterId: string;
  version: string;
  artifactDigest: string;
  status: AdapterRunStatus;
  capabilities: string[];
  parserVersions: Record<string, string>;
}

/** A configuration input that was executed in the Judgment Engine sandbox. */
export interface ExecutedInput {
  kind: "configuration";
  path: string;
  contentHash: string;
}

export interface BundleExecution {
  profileId: string;
  profileVersion: string;
  sandboxProfile: string;
  /** When false, `executedInputs` must be empty (static-only default). */
  repositoryCodeExecuted: boolean;
  executedInputs: ExecutedInput[];
  adapterRuns: AdapterRun[];
}

export type EvidenceArtifactKind =
  | "source_excerpt"
  | "screenshot"
  | "screenshot_crop"
  | "ui_graph"
  | "repository_manifest"
  | "evidence_ir"
  | "ownership"
  | "change_history";

export type RedactionState = "none" | "redacted" | "withheld";

export interface EvidenceArtifactRef {
  artifactRef: string;
  kind: EvidenceArtifactKind;
  contentHash: string;
  redactionState: RedactionState;
  retentionClass: string;
  expiresAt?: string;
}

export type CoverageStatus = "complete" | "partial" | "unsupported" | "not_requested";

export interface EvidenceCoverage {
  capability: string;
  scope?: string;
  status: CoverageStatus;
  reason?: string;
}

export interface AdapterDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
}

export interface BundleProducer {
  service: "judgment-engine";
  version: string;
  region?: string;
}

export interface BundleUiDnaRef {
  version: string;
  digest: string;
}

/**
 * Detached Ed25519 signature (TRD §3.2). Constructed by removing this whole
 * `signature` object, RFC 8785-canonicalizing the rest, setting `digest` to
 * `sha256:<hex>` of those bytes and `value` to the base64 Ed25519 signature over
 * them.
 */
export interface BundleSignature {
  algorithm: "Ed25519";
  keyId: string;
  canonicalization: "RFC8785";
  digest: string;
  value: string;
}

export interface DerivedEvidenceBundleV1 {
  schemaVersion: string;
  bundleId: string;
  requestId: string;
  tenantId: string;
  repositoryId: string;
  commitSha: string;
  uiDna: BundleUiDnaRef;
  producer: BundleProducer;
  execution: BundleExecution;
  repositoryManifestRef: string;
  repositoryManifestHash: string;
  evidenceIrRef: string;
  evidenceIrHash: string;
  uiGraphSnapshotRefs: string[];
  artifactRefs: EvidenceArtifactRef[];
  coverage: EvidenceCoverage[];
  diagnostics: AdapterDiagnostic[];
  generatedAt: string;
  signature: BundleSignature;
}

/** The bundle before its detached signature is attached. */
export type UnsignedDerivedEvidenceBundle = Omit<DerivedEvidenceBundleV1, "signature">;
