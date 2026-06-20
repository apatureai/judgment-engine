import { describe, expect, it } from "vitest";
import {
  assertNoEviction,
  buildConnectionOptions,
  getMaxmemoryPolicy,
  modelEndpointCircuitBreakerKey,
  modelEndpointTokenBucketKey,
  REDIS_NAMESPACES,
  tenantPriorityKey,
  tenantQuotaKey,
  type RedisConfigClient,
} from "../src/index.js";

describe("key namespaces", () => {
  it("namespaces the global model-endpoint token-bucket under tb:", () => {
    expect(modelEndpointTokenBucketKey("qwen3-vl-plus")).toBe("tb:model:qwen3-vl-plus");
  });

  it("namespaces per-tenant quota and priority distinctly", () => {
    expect(tenantQuotaKey("t_1")).toBe("quota:t_1");
    expect(tenantPriorityKey("t_1")).toBe("pq:t_1");
    // quota vs priority-queue namespaces never collide.
    expect(REDIS_NAMESPACES.quota).not.toBe(REDIS_NAMESPACES.priority);
  });

  it("namespaces circuit-breaker state per model endpoint", () => {
    expect(modelEndpointCircuitBreakerKey("qwen3-vl-flash")).toBe("cb:model:qwen3-vl-flash");
  });
});

describe("buildConnectionOptions", () => {
  it("never silently drops commands and keeps reconnecting", () => {
    const opts = buildConnectionOptions();
    expect(opts.maxRetriesPerRequest).toBeNull();
    const retry = opts.retryStrategy as (times: number) => number;
    expect(retry(1)).toBe(200);
    expect(retry(100)).toBe(5000); // capped at 5s
  });

  it("allows overrides without losing the resilient defaults", () => {
    const opts = buildConnectionOptions({ enableReadyCheck: false });
    expect(opts.enableReadyCheck).toBe(false);
    expect(opts.maxRetriesPerRequest).toBeNull();
  });
});

describe("assertNoEviction", () => {
  const clientWithPolicy = (policy: string): RedisConfigClient => ({
    config: async () => ["maxmemory-policy", policy],
  });

  it("reads the configured policy", async () => {
    expect(await getMaxmemoryPolicy(clientWithPolicy("noeviction"))).toBe("noeviction");
  });

  it("passes when noeviction", async () => {
    await expect(assertNoEviction(clientWithPolicy("noeviction"))).resolves.toBeUndefined();
  });

  it("throws on an evicting policy (protects fairness state)", async () => {
    await expect(assertNoEviction(clientWithPolicy("allkeys-lru"))).rejects.toThrow(/noeviction/);
  });
});
