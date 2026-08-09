import type { DerivedEvidenceBundleV1, UnsignedDerivedEvidenceBundle } from "./bundle.js";

/**
 * `EvidenceRequestV1` — the producer-owned request a `DerivedEvidenceBundleV1`
 * is produced FOR and must bind to (TRD §3.2). The consumer's
 * acceptance gate re-checks this identity binding against the originating
 * request; mirroring it producer-side lets Judgment Engine prove a bundle binds
 * before it is ever returned. The binding fields match Entropy's analysis-request
 * profile 1:1 (tenant/repo/request/commit/UI-DNA).
 */

export const EVIDENCE_REQUEST_SCHEMA_VERSION = "1.0.0" as const;

export interface EvidenceRequestUiDnaRef {
  version: string;
  digest: string;
  approvalState?: string;
}

export interface EvidenceRequestV1 {
  schemaVersion: string;
  requestId: string;
  tenantId: string;
  repositoryId: string;
  commitSha: string;
  uiDna: EvidenceRequestUiDnaRef;
}

/** The identity fields a bundle must carry to bind to a request. */
export interface BundleBinding {
  tenantId: string;
  repositoryId: string;
  requestId: string;
  commitSha: string;
  uiDna: { version: string; digest: string };
}

/** Project the binding a bundle must stamp so it binds to `request`. */
export function bindingFieldsFromRequest(request: EvidenceRequestV1): BundleBinding {
  return {
    tenantId: request.tenantId,
    repositoryId: request.repositoryId,
    requestId: request.requestId,
    commitSha: request.commitSha,
    uiDna: { version: request.uiDna.version, digest: request.uiDna.digest },
  };
}

export interface BindingCheck {
  bound: boolean;
  /** The binding fields that differ from the request (empty when bound). */
  mismatches: readonly string[];
}

/**
 * Whether a bundle binds to the request that authorized it — the SAME identity
 * check the acceptance gate enforces (tenant/repo/request/commit/UI-DNA
 * version+digest). Naming the mismatched fields makes a wrong-identity bundle
 * observable producer-side, before it is returned.
 */
export function bundleBindsToRequest(
  bundle: Pick<DerivedEvidenceBundleV1, "tenantId" | "repositoryId" | "requestId" | "commitSha" | "uiDna">,
  request: EvidenceRequestV1,
): BindingCheck {
  const mismatches: string[] = [];
  if (bundle.tenantId !== request.tenantId) mismatches.push("tenantId");
  if (bundle.repositoryId !== request.repositoryId) mismatches.push("repositoryId");
  if (bundle.requestId !== request.requestId) mismatches.push("requestId");
  if (bundle.commitSha !== request.commitSha) mismatches.push("commitSha");
  if (bundle.uiDna.version !== request.uiDna.version) mismatches.push("uiDna.version");
  if (bundle.uiDna.digest !== request.uiDna.digest) mismatches.push("uiDna.digest");
  return { bound: mismatches.length === 0, mismatches };
}

export class RequestBindingError extends Error {
  constructor(readonly mismatches: readonly string[]) {
    super(`bundle does not bind to its request; mismatched fields: ${mismatches.join(", ")}`);
    this.name = "RequestBindingError";
  }
}

/** Fail closed unless the (unsigned) bundle binds to `request` — a producer-side guard before signing. */
export function assertBundleBindsToRequest(bundle: UnsignedDerivedEvidenceBundle, request: EvidenceRequestV1): UnsignedDerivedEvidenceBundle {
  const check = bundleBindsToRequest(bundle, request);
  if (!check.bound) throw new RequestBindingError(check.mismatches);
  return bundle;
}
