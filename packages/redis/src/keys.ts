/**
 * Redis key namespaces for the engine orchestrator hot paths (TRD §3/§11/§13).
 *
 * Per the architecture review (E1), the durable job store and dispatch live in
 * **Postgres + pg_notify** (#65) — NOT Redis. Redis holds only the fairness and
 * rate-limit state that must be fast and shared across orchestrator instances:
 *
 * - `tb:`    — global model-endpoint token-bucket (#36), keyed by endpoint.
 * - `quota:` — per-tenant quota counters (#67), TTL windows.
 * - `pq:`    — per-tenant priority-queue depth/markers for fair scheduling (#67).
 * - `cb:`    — circuit-breaker state, e.g. `cb:model:<endpoint>`.
 */
export const REDIS_NAMESPACES = {
  tokenBucket: "tb:",
  quota: "quota:",
  priority: "pq:",
  circuitBreaker: "cb:",
} as const;

/** Global model-endpoint token-bucket key: `tb:model:<endpoint>` (#36). */
export function modelEndpointTokenBucketKey(endpoint: string): string {
  return `${REDIS_NAMESPACES.tokenBucket}model:${endpoint}`;
}

/** Per-tenant quota counter key: `quota:<tenantId>` (#67). */
export function tenantQuotaKey(tenantId: string): string {
  return `${REDIS_NAMESPACES.quota}${tenantId}`;
}

/** Per-tenant priority-queue marker key: `pq:<tenantId>` (#67). */
export function tenantPriorityKey(tenantId: string): string {
  return `${REDIS_NAMESPACES.priority}${tenantId}`;
}

/** Circuit-breaker state key for a model endpoint: `cb:model:<endpoint>`. */
export function modelEndpointCircuitBreakerKey(endpoint: string): string {
  return `${REDIS_NAMESPACES.circuitBreaker}model:${endpoint}`;
}
