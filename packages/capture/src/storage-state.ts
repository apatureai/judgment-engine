/**
 * storageState injection policy (TRD §4.3/§4.4/§11). Auth state is decrypted
 * only inside the microVM (via the #7 envelope helper) and injected ONLY when
 * safe: scoped to the exact preview origin (never org-wide SSO cookies) and
 * fully disabled on fork PRs, where attacker code + real auth cookies is the
 * danger case. Routes that would have needed auth are then listed not-reviewed.
 *
 * The KMS decrypt + Playwright context injection are the worker seam; this is
 * the pure gating + origin-scoping decision.
 */

export interface StorageStateDecisionInput {
  /** True for PRs from forks (untrusted). */
  isFork: boolean;
  /** Whether a storageState secret is configured for this repo. */
  hasStorageState: boolean;
  /** Routes that were requested for capture. */
  routes: string[];
}

export interface StorageStateDecision {
  inject: boolean;
  /** Not-reviewed markers for routes skipped because auth was disabled on a fork. */
  notReviewed: string[];
}

/** Decide whether to inject storageState and which routes go not-reviewed. */
export function decideStorageState(input: StorageStateDecisionInput): StorageStateDecision {
  const inject = input.hasStorageState && !input.isFork;
  const notReviewed =
    input.hasStorageState && input.isFork
      ? input.routes.map((r) => `${r}: not-reviewed-fork-PR`)
      : [];
  return { inject, notReviewed };
}

export interface Cookie {
  name: string;
  /** Cookie domain, possibly with a leading dot for parent-domain scope. */
  domain: string;
  path?: string;
}

/** The host an origin URL resolves to (`https://preview.x.com/p` -> `preview.x.com`). */
export function originHost(origin: string): string {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
}

/**
 * Keep only cookies bound to the EXACT preview origin host. Parent-domain
 * cookies (e.g. `.example.com`, `.okta.com`) are org-wide SSO and are dropped —
 * they must never ride along into a per-PR preview capture.
 */
export function scopeCookiesToOrigin(cookies: Cookie[], origin: string): Cookie[] {
  const host = originHost(origin);
  return cookies.filter((c) => c.domain.replace(/^\./, "").toLowerCase() === host);
}
