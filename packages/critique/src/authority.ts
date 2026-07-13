import type { Critique, Grade } from "@engine/types";

/**
 * Approval-authority (revocation) enforcement — the Judgment Engine consumer
 * side of ui-dna#64.
 *
 * A critique is grounded on an approved UI-DNA genome version
 * (`metadata.uiDnaVersion`). UI-DNA is the sole approval authority; the engine
 * MIRRORS the status and enforces it at result assembly. If the grounding
 * version was REVOKED before publish (bad sign-off, compromised account,
 * sensitive anchor, standard withdrawal), the engine must not let that critique
 * drive a BLOCKING release: blocking is suppressed and a `blocked` grade is
 * floored to `needs_work`, exactly as when blocking was never promoted.
 *
 * This is not deletion: the findings and their provenance stay intact and the
 * result remains advisory, so historical judgment is preserved and auditable.
 * The suppression is DISCLOSED — the withdrawn version is named in
 * `notReviewed` — never silent. The engine never creates or mutates authority.
 */

/** The engine's mirrored view of a genome version's approval authority. */
export type AuthorityStatus = "effective" | "revoked";

export interface AuthorityStatusRef {
  status: AuthorityStatus;
  /** The UI-DNA authority head-event hash this mirror pins, for audit lineage. */
  headEventHash?: string;
}

export type GroundingAuthorization = { allowed: true } | { allowed: false; reason: "revoked" };

/** Whether a critique grounded on this version may drive a blocking release. */
export function authorizeGrounding(ref: AuthorityStatusRef): GroundingAuthorization {
  if (ref.status === "revoked") return { allowed: false, reason: "revoked" };
  return { allowed: true };
}

function withNote(notReviewed: readonly string[], note: string): string[] {
  return notReviewed.includes(note) ? [...notReviewed] : [...notReviewed, note];
}

/**
 * Enforce the grounding version's authority on an assembled critique. An
 * `effective` version passes through unchanged. A `revoked` version suppresses
 * the blocking teeth — `blockingEnabled → false`, a `blocked` grade floored to
 * `needs_work` — while preserving every finding advisorily and disclosing the
 * withdrawn version in `notReviewed`. Idempotent.
 */
export function enforceGroundingAuthority(critique: Critique, ref: AuthorityStatusRef): Critique {
  if (ref.status !== "revoked") return critique;
  const version = critique.metadata.uiDnaVersion ?? "unknown";
  const flooredGrade: Grade = critique.grade === "blocked" ? "needs_work" : critique.grade;
  return {
    ...critique,
    grade: flooredGrade,
    blockingEnabled: false,
    notReviewed: withNote(
      critique.notReviewed,
      `grounding withheld: UI-DNA version ${version} was revoked before publish; blocking suppressed (advisory only)`,
    ),
  };
}

/** An in-memory authority mirror keyed by UI-DNA genome version. Unlisted ⇒ effective. */
export function inMemoryGroundingAuthority(
  entries: readonly { uiDnaVersion: string; status: AuthorityStatus; headEventHash?: string }[] = [],
): { statusFor(uiDnaVersion: string | null): AuthorityStatusRef } {
  const byVersion = new Map<string, AuthorityStatusRef>();
  for (const e of entries) byVersion.set(e.uiDnaVersion, { status: e.status, headEventHash: e.headEventHash });
  return {
    statusFor(uiDnaVersion) {
      if (uiDnaVersion === null) return { status: "effective" };
      return byVersion.get(uiDnaVersion) ?? { status: "effective" };
    },
  };
}
