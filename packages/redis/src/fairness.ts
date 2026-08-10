import { modelEndpointTokenBucketKey, tenantQuotaKey } from "./keys.js";
import type { TokenBucketLimiter } from "./token-bucket.js";

/**
 * Capacity & fairness gate (#67; architecture review E6). Composes two limiters:
 * a **per-tenant quota** (so one tenant's burst can't starve others) checked
 * first, then the **global model-endpoint token-bucket** (#36, the outer
 * envelope). A denied admission returns `retryAfterMs` (the 429 + Retry-After
 * backpressure signal); the orchestrator leaves the job queued, so work is
 * deferred, never dropped, and priority ordering (the `priority` column) decides
 * who runs first.
 */
export type FairnessReason = "tenant_quota" | "endpoint";

export interface FairnessDecision {
  admitted: boolean;
  retryAfterMs: number;
  reason?: FairnessReason;
}

export class FairnessGate {
  constructor(
    private readonly tenantQuota: TokenBucketLimiter,
    private readonly endpointBucket: TokenBucketLimiter,
  ) {}

  /**
   * Decide whether to dispatch a job for `installationId` against `endpoint`.
   * Tenant quota is checked first (fairness), then the shared endpoint cap. Note:
   * if the endpoint denies after a tenant token was taken, that token is not
   * refunded, a small, self-correcting over-count under heavy contention.
   */
  async admit(installationId: string, endpoint: string): Promise<FairnessDecision> {
    const tenant = await this.tenantQuota.tryConsume(tenantQuotaKey(installationId));
    if (!tenant.allowed) {
      return { admitted: false, retryAfterMs: tenant.retryAfterMs, reason: "tenant_quota" };
    }
    const endpointResult = await this.endpointBucket.tryConsume(modelEndpointTokenBucketKey(endpoint));
    if (!endpointResult.allowed) {
      return { admitted: false, retryAfterMs: endpointResult.retryAfterMs, reason: "endpoint" };
    }
    return { admitted: true, retryAfterMs: 0 };
  }
}
