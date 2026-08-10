import { canonicalBytes } from "./canonicalize.js";
import type { DerivedEvidenceBundleV1, UnsignedDerivedEvidenceBundle } from "./bundle.js";
import { signDerivedEvidenceBundle, type Ed25519SignerPort } from "./producer.js";

/**
 * Producer-side negative corpus (judgment-engine#156). Deterministically derive
 * the adversarial bundles Entropy's acceptance gate must reject, from one valid
 * bundle + a signer. Two families:
 *
 *   - IDENTITY mutations mutate a bound field BEFORE signing, so the signature is
 *     genuinely valid over the (wrong) bytes, so the gate must reject on the
 *     identity binding against the request, NOT on the signature. This is the
 *     interesting case a bare digest check would miss.
 *   - INTEGRITY mutations break the signature/digest (tamper-after-sign, forged
 *     value) or the schema (stale major, unsigned).
 *
 * The `expectedGateCode` on each result names the Entropy gate `RejectionCode`
 * the case targets, so a cross-repo integration test can assert the mapping.
 */

export type BundleMutation =
  | "wrong_tenant"
  | "wrong_repository"
  | "wrong_request"
  | "wrong_commit"
  | "wrong_dna_version"
  | "wrong_dna_digest"
  | "stale_major"
  | "tampered_after_signing"
  | "forged_signature"
  | "unsigned";

export interface CorruptBundle {
  mutation: BundleMutation;
  bundle: DerivedEvidenceBundleV1;
  /** The Entropy gate RejectionCode this case is expected to trigger. */
  expectedGateCode: string;
  /** Whether the signature is (still) cryptographically valid over the bundle bytes. */
  signatureValidOverBytes: boolean;
}

const IDENTITY_MUTATIONS: Partial<Record<BundleMutation, { apply: (b: UnsignedDerivedEvidenceBundle) => UnsignedDerivedEvidenceBundle; code: string }>> = {
  wrong_tenant: { apply: (b) => ({ ...b, tenantId: `${b.tenantId}-x` }), code: "tenant_mismatch" },
  wrong_repository: { apply: (b) => ({ ...b, repositoryId: `${b.repositoryId}-x` }), code: "repository_mismatch" },
  wrong_request: { apply: (b) => ({ ...b, requestId: `${b.requestId}-x` }), code: "request_mismatch" },
  wrong_commit: { apply: (b) => ({ ...b, commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }), code: "commit_mismatch" },
  wrong_dna_version: { apply: (b) => ({ ...b, uiDna: { ...b.uiDna, version: `${b.uiDna.version}-x` } }), code: "ui_dna_version_mismatch" },
  wrong_dna_digest: { apply: (b) => ({ ...b, uiDna: { ...b.uiDna, digest: "sha256:deadbeef" } }), code: "ui_dna_digest_mismatch" },
};

/**
 * Produce one corrupted, gate-rejectable bundle for `mutation` from a valid
 * unsigned bundle + a signer. Deterministic given the signer.
 */
export async function corruptBundle(
  unsigned: UnsignedDerivedEvidenceBundle,
  signer: Ed25519SignerPort,
  mutation: BundleMutation,
): Promise<CorruptBundle> {
  // Identity family: mutate then sign, giving a valid signature over wrong identity.
  const identity = IDENTITY_MUTATIONS[mutation];
  if (identity) {
    const bundle = await signDerivedEvidenceBundle(identity.apply(unsigned), signer);
    return { mutation, bundle, expectedGateCode: identity.code, signatureValidOverBytes: true };
  }

  if (mutation === "stale_major") {
    // Bump the major past what the consumer accepts, then sign; rejected before signature.
    const bundle = await signDerivedEvidenceBundle({ ...unsigned, schemaVersion: "2.0.0" }, signer);
    return { mutation, bundle, expectedGateCode: "unsupported_major", signatureValidOverBytes: true };
  }

  // Integrity family: sign the good bundle first, then break it.
  const signed = await signDerivedEvidenceBundle(unsigned, signer);

  if (mutation === "tampered_after_signing") {
    // Change a field AFTER signing: the signature is over the original bytes.
    return {
      mutation,
      bundle: { ...signed, commitSha: "0000000000000000000000000000000000000000" },
      expectedGateCode: "digest_mismatch",
      signatureValidOverBytes: false,
    };
  }
  if (mutation === "forged_signature") {
    // Keep the digest, replace the signature value with an unrelated one.
    const forged = Buffer.from(new Uint8Array(64).fill(7)).toString("base64");
    return {
      mutation,
      bundle: { ...signed, signature: { ...signed.signature, value: forged } },
      expectedGateCode: "signature_invalid",
      signatureValidOverBytes: false,
    };
  }
  // unsigned: an empty signature value cannot decode/verify.
  return {
    mutation,
    bundle: { ...signed, signature: { ...signed.signature, value: "" } },
    expectedGateCode: "signature_invalid",
    signatureValidOverBytes: false,
  };
}

export const ALL_BUNDLE_MUTATIONS: readonly BundleMutation[] = Object.freeze([
  "wrong_tenant",
  "wrong_repository",
  "wrong_request",
  "wrong_commit",
  "wrong_dna_version",
  "wrong_dna_digest",
  "stale_major",
  "tampered_after_signing",
  "forged_signature",
  "unsigned",
]);

/** Build the full negative corpus (one corrupt bundle per mutation). */
export async function buildNegativeCorpus(
  unsigned: UnsignedDerivedEvidenceBundle,
  signer: Ed25519SignerPort,
): Promise<CorruptBundle[]> {
  return Promise.all(ALL_BUNDLE_MUTATIONS.map((m) => corruptBundle(unsigned, signer, m)));
}

/** The canonical bytes of a bundle's signed content (signature stripped), for a mirror verify. */
export function signedContentBytes(bundle: DerivedEvidenceBundleV1): Uint8Array {
  const { signature: _omit, ...rest } = bundle;
  return canonicalBytes(rest);
}
