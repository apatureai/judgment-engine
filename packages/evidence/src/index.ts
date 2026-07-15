/**
 * `@engine/evidence` — the producer of the signed `DerivedEvidenceBundleV1`
 * Entropy Engine's acceptance gate consumes (judgment-engine#156; ADR-0008).
 *
 * Judgment Engine owns checkout/capture, adapter authorization, artifact
 * custody, bundle identity, and signing. This package is contract-only wire +
 * a pure builder + an injected signer port — no network, model, browser, store,
 * or private key. The RFC 8785 canonicalizer is byte-identical to Entropy's
 * verifier so one golden verifies in both repositories.
 */

export * from "./bundle.js";
export { canonicalize, canonicalBytes, CanonicalizationError } from "./canonicalize.js";
export {
  buildDerivedEvidenceBundle,
  signDerivedEvidenceBundle,
  bundleCanonicalDigest,
  BundleIntegrityError,
  type Ed25519SignerPort,
  type BuildBundleInput,
} from "./producer.js";
export {
  ARTIFACT_TRUST_DECISION_VERSION,
  decideArtifactTrust,
  isUsePermitted,
  assertNotSemanticAuthority,
  SemanticAuthorityError,
  type AllowedUse,
  type ForbiddenBySignatureAlone,
  type ArtifactTrustDecisionV1,
  type TrustDecisionInput,
} from "./trust-decision.js";
