import { createHash } from "node:crypto";

import { canonicalBytes } from "./canonicalize.js";
import {
  DERIVED_EVIDENCE_BUNDLE_SCHEMA_VERSION,
  type BundleExecution,
  type DerivedEvidenceBundleV1,
  type EvidenceArtifactRef,
  type EvidenceCoverage,
  type AdapterDiagnostic,
  type BundleUiDnaRef,
  type UnsignedDerivedEvidenceBundle,
} from "./bundle.js";

/**
 * The signed `DerivedEvidenceBundleV1` producer (judgment-engine#156;
 * TRD §3.2). A pure deterministic builder assembles the bundle; an injected
 * Ed25519 signer (KMS/HSM/local) signs the RFC 8785 canonical bytes. NO private
 * key lives in source or config — the signer is a port.
 *
 * The canonicalizer is byte-identical to Entropy's verifier (`canonicalize.ts`
 * is the same file), so the digest a producer computes here equals the digest
 * Entropy's gate recomputes: one golden verifies in both repositories.
 */

/** Injected Ed25519 signing port. Backed by KMS/HSM in production; a raw key in tests. */
export interface Ed25519SignerPort {
  /** The producer key id stamped into `signature.keyId`. */
  readonly keyId: string;
  /** Sign the message bytes with the Ed25519 private key (one-shot). */
  sign(message: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export class BundleIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleIntegrityError";
  }
}

export interface BuildBundleInput {
  bundleId: string;
  requestId: string;
  tenantId: string;
  repositoryId: string;
  commitSha: string;
  uiDna: BundleUiDnaRef;
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
  producerVersion: string;
  producerRegion?: string;
}

/**
 * Assemble an unsigned bundle from authorized capture/extraction outputs. Pure
 * and deterministic: the canonical bytes are the identity, and since the
 * canonicalizer sorts keys, input field order never affects identity (display
 * metadata cannot change the digest). Enforces the static-only invariant.
 */
export function buildDerivedEvidenceBundle(input: BuildBundleInput): UnsignedDerivedEvidenceBundle {
  if (!input.execution.repositoryCodeExecuted && input.execution.executedInputs.length > 0) {
    throw new BundleIntegrityError("executedInputs must be empty when repositoryCodeExecuted is false (static-only)");
  }
  return {
    schemaVersion: DERIVED_EVIDENCE_BUNDLE_SCHEMA_VERSION,
    bundleId: input.bundleId,
    requestId: input.requestId,
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    commitSha: input.commitSha,
    uiDna: input.uiDna,
    producer: {
      service: "judgment-engine",
      version: input.producerVersion,
      ...(input.producerRegion !== undefined ? { region: input.producerRegion } : {}),
    },
    execution: input.execution,
    repositoryManifestRef: input.repositoryManifestRef,
    repositoryManifestHash: input.repositoryManifestHash,
    evidenceIrRef: input.evidenceIrRef,
    evidenceIrHash: input.evidenceIrHash,
    uiGraphSnapshotRefs: input.uiGraphSnapshotRefs,
    artifactRefs: input.artifactRefs,
    coverage: input.coverage,
    diagnostics: input.diagnostics,
    generatedAt: input.generatedAt,
  };
}

/** The RFC 8785 canonical digest (`sha256:<hex>`) of an unsigned bundle — the signed bytes' fingerprint. */
export function bundleCanonicalDigest(unsigned: UnsignedDerivedEvidenceBundle): string {
  return `sha256:${createHash("sha256").update(canonicalBytes(unsigned)).digest("hex")}`;
}

/**
 * Attach a detached Ed25519 signature: canonicalize the unsigned bundle, set
 * `digest` to its `sha256:<hex>` and `value` to the base64 Ed25519 signature
 * over the same canonical bytes. Mirrors the producer side of TRD §3.2 exactly,
 * so Entropy's gate verifies a genuine signature.
 */
export async function signDerivedEvidenceBundle(
  unsigned: UnsignedDerivedEvidenceBundle,
  signer: Ed25519SignerPort,
): Promise<DerivedEvidenceBundleV1> {
  const canonical = canonicalBytes(unsigned);
  const digest = `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  const value = Buffer.from(await signer.sign(canonical)).toString("base64");
  return {
    ...unsigned,
    signature: { algorithm: "Ed25519", keyId: signer.keyId, canonicalization: "RFC8785", digest, value },
  };
}
