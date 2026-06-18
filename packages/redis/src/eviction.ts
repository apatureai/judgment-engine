/**
 * Eviction-policy guard (TRD §3/§11; architecture review E1).
 *
 * Redis must run `noeviction` so the token-bucket (#36) and per-tenant quota /
 * priority (#67) fairness state are never dropped under memory pressure —
 * eviction would silently reset rate limits and quotas, letting a tenant
 * exceed model-endpoint capacity. TTL counters expire on their own; eviction is
 * a different, unwanted failure mode.
 */
export const REQUIRED_MAXMEMORY_POLICY = "noeviction";

/** Minimal client surface needed to read the policy (decoupled from ioredis). */
export interface RedisConfigClient {
  config(command: "GET", parameter: string): Promise<string[]>;
}

/** Read the server's `maxmemory-policy`. */
export async function getMaxmemoryPolicy(client: RedisConfigClient): Promise<string> {
  const result = await client.config("GET", "maxmemory-policy");
  // CONFIG GET returns a flat [name, value] pair.
  return result[1] ?? "";
}

/** Throw unless the server is configured for `noeviction`. Call on startup. */
export async function assertNoEviction(client: RedisConfigClient): Promise<void> {
  const policy = await getMaxmemoryPolicy(client);
  if (policy !== REQUIRED_MAXMEMORY_POLICY) {
    throw new Error(
      `Redis maxmemory-policy is "${policy}", expected "${REQUIRED_MAXMEMORY_POLICY}": ` +
        "token-bucket/quota fairness state must never be evicted (TRD §3/§11).",
    );
  }
}
