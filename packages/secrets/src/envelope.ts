import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KmsKeyProvider } from "./kms.js";

/** Identifies the CMK + repo a secret is sealed for. */
export interface RepoScope {
  /** Per-tenant (or shared) CMK id — the only key held in the managed KMS. */
  cmkId: string;
  /** Repo the data key is scoped to (`<owner>/<name>`). */
  repoId: string;
}

/**
 * Envelope-encrypted secret at rest (§11). The plaintext is encrypted with a
 * fresh per-repo data key (DEK, AES-256-GCM); the DEK is wrapped under the CMK
 * named by `cmkId`. The `repoId` is bound as additional authenticated data, so
 * a sealed secret can only be opened in the same repo scope — cross-repo reuse
 * fails authentication even though no per-repo KMS key exists. Only the envelope
 * is persisted; plaintext and the raw DEK exist only at point of use.
 */
export interface SealedSecret {
  cmkId: string;
  repoId: string;
  /** Base64 wrapped DEK. */
  wrappedDek: string;
  /** Base64 AES-GCM IV. */
  iv: string;
  /** Base64 AES-GCM auth tag. */
  authTag: string;
  /** Base64 ciphertext. */
  ciphertext: string;
}

function aad(scope: RepoScope): Buffer {
  return Buffer.from(`${scope.cmkId}:${scope.repoId}`, "utf8");
}

/** Seal a plaintext secret with a fresh per-repo DEK wrapped under the CMK. */
export async function sealForRepo(
  plaintext: string,
  scope: RepoScope,
  kms: KmsKeyProvider,
): Promise<SealedSecret> {
  const dek = randomBytes(32); // per-repo data key, never a KMS key
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(aad(scope));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrappedDek = await kms.wrapDataKey(dek, scope.cmkId);
  dek.fill(0); // best-effort scrub of the raw DEK

  return {
    cmkId: scope.cmkId,
    repoId: scope.repoId,
    wrappedDek: wrappedDek.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Open a `SealedSecret` back to plaintext at point of use. */
export async function openForRepo(sealed: SealedSecret, kms: KmsKeyProvider): Promise<string> {
  const dek = await kms.unwrapDataKey(Buffer.from(sealed.wrappedDek, "base64"), sealed.cmkId);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(aad({ cmkId: sealed.cmkId, repoId: sealed.repoId }));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } finally {
    dek.fill(0);
  }
}
