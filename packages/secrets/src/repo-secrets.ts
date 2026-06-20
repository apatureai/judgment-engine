import { openForRepo, sealForRepo, type SealedSecret } from "./envelope.js";
import type { KmsKeyProvider } from "./kms.js";

/**
 * Per-repo secrets the capture sandbox needs (§11/§3.1): an origin-scoped
 * `storageState` (authenticated capture) and a `protectionBypass` token (preview
 * access). Both are envelope-encrypted with `sealForRepo` — a fresh per-repo DEK
 * wrapped under the tenant CMK — so they are stored KMS-encrypted and only
 * decryptable in their own repo + kind scope.
 */
export const REPO_SECRET_KINDS = ["storageState", "protectionBypass"] as const;
export type RepoSecretKind = (typeof REPO_SECRET_KINDS)[number];

export interface RepoSecretScope {
  cmkId: string;
  repoId: string;
}

/** Fold the secret kind into the repo scope so kinds can't be confused. */
function scopeFor(scope: RepoSecretScope, kind: RepoSecretKind) {
  return { cmkId: scope.cmkId, repoId: `${scope.repoId}#${kind}` };
}

/** Seal a per-repo secret of the given kind (KMS-encrypted at rest). */
export function sealRepoSecret(
  kind: RepoSecretKind,
  plaintext: string,
  scope: RepoSecretScope,
  kms: KmsKeyProvider,
): Promise<SealedSecret> {
  return sealForRepo(plaintext, scopeFor(scope, kind), kms);
}

/** Open a per-repo secret, asserting it was sealed for the requested kind. */
export async function openRepoSecret(
  kind: RepoSecretKind,
  sealed: SealedSecret,
  kms: KmsKeyProvider,
): Promise<string> {
  if (!sealed.repoId.endsWith(`#${kind}`)) {
    throw new Error(`sealed secret is not a ${kind} secret`);
  }
  return openForRepo(sealed, kms);
}
