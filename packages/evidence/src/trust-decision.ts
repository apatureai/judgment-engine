/**
 * `ArtifactTrustDecisionV1` (judgment-engine#156; SCITT architecture).
 *
 * A verified signature attests LINEAGE only — that these exact bytes were
 * produced by the named key. It is NOT semantic authority: a valid signature
 * alone must never create a finding, approve UI DNA, or make feedback
 * training-grade (SCITT explicitly separates statement provenance from statement
 * accuracy). This type records that separation as data: `lineageVerified` is the
 * cryptographic fact; `allowedUses` is a SEPARATE policy grant.
 *
 * The two use vocabularies are DISJOINT by construction — `AllowedUse` can never
 * contain a `ForbiddenBySignatureAlone` member — so it is impossible to express
 * "a signature authorizes publishing a finding".
 */

export const ARTIFACT_TRUST_DECISION_VERSION = "artifact-trust-decision/1" as const;

/**
 * What a lineage-verified artifact MAY be used for. Each is a downstream policy
 * grant, never implied by the signature itself.
 */
export type AllowedUse = "drift_analysis_input" | "grounding_context" | "audit_reference";

/**
 * Uses a signature ALONE can never authorize (provenance ≠ accuracy).
 * These are deliberately NOT part of `AllowedUse`, so a trust decision cannot
 * grant them.
 */
export type ForbiddenBySignatureAlone = "publish_finding" | "approve_ui_dna" | "training_grade_feedback";

export interface ArtifactTrustDecisionV1 {
  version: typeof ARTIFACT_TRUST_DECISION_VERSION;
  bundleId: string;
  keyId: string;
  /** The provenance fact: the bundle's signature + digest + identity binding all verified. */
  lineageVerified: boolean;
  /** Present iff NOT verified — the rejection reason from the acceptance gate. */
  lineageRejectionReason?: string;
  /** The policy-granted uses. ALWAYS empty when lineage is not verified. */
  allowedUses: readonly AllowedUse[];
  decidedAt: string;
}

export interface TrustDecisionInput {
  bundleId: string;
  keyId: string;
  lineageVerified: boolean;
  lineageRejectionReason?: string;
  /** The uses policy grants for a verified artifact. Ignored (forced empty) when unverified. */
  grantedUses?: readonly AllowedUse[];
  decidedAt: string;
}

/**
 * Build the trust decision. Without verified lineage, `allowedUses` is forced
 * empty — nothing is permitted. With verified lineage, only the explicitly
 * policy-granted `AllowedUse` set is permitted (deduped); a forbidden use is
 * unrepresentable in that set.
 */
export function decideArtifactTrust(input: TrustDecisionInput): ArtifactTrustDecisionV1 {
  const allowedUses = input.lineageVerified ? [...new Set(input.grantedUses ?? [])] : [];
  return {
    version: ARTIFACT_TRUST_DECISION_VERSION,
    bundleId: input.bundleId,
    keyId: input.keyId,
    lineageVerified: input.lineageVerified,
    ...(input.lineageVerified ? {} : { lineageRejectionReason: input.lineageRejectionReason ?? "lineage not verified" }),
    allowedUses,
    decidedAt: input.decidedAt,
  };
}

/** Whether a specific policy-granted use is permitted (requires verified lineage AND an explicit grant). */
export function isUsePermitted(decision: ArtifactTrustDecisionV1, use: AllowedUse): boolean {
  return decision.lineageVerified && decision.allowedUses.includes(use);
}

export class SemanticAuthorityError extends Error {
  constructor(use: ForbiddenBySignatureAlone) {
    super(`a verified signature is provenance, not authority: it can never authorize "${use}"`);
    this.name = "SemanticAuthorityError";
  }
}

/**
 * Fail closed if code asks a trust decision to authorize a use that a signature
 * can never grant. This is the runtime backstop for the compile-time disjointness
 * of `AllowedUse` and `ForbiddenBySignatureAlone`.
 */
export function assertNotSemanticAuthority(use: ForbiddenBySignatureAlone): never {
  throw new SemanticAuthorityError(use);
}
