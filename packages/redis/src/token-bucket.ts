/**
 * Global model-endpoint token-bucket (TRD §15/§16, #36). Caps model calls across
 * ALL tenants so one tenant's fan-out can't exhaust the DashScope account limit
 * or saturate the self-host pool. A denied consume returns `retryAfterMs` and the
 * orchestrator leaves the job queued (never drops it), so backpressure surfaces
 * as queue depth. This is the OUTER envelope; per-tenant quota + priority (#67)
 * compose on top.
 *
 * `refillAndConsume` is the pure algorithm; `InMemoryTokenBucket` exercises it in
 * tests; `RedisTokenBucket` runs the same logic atomically via a Lua script so it
 * is correct across orchestrator instances.
 */

export interface TokenBucketOptions {
  /** Max tokens (burst). */
  capacity: number;
  /** Steady-state refill rate (tokens per second). */
  refillPerSec: number;
}

export interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  /** When denied, ms until enough tokens refill for this cost (0 when allowed). */
  retryAfterMs: number;
}

/** Pure refill-then-consume. Refills by elapsed time, consumes `cost` if available. */
export function refillAndConsume(
  prev: TokenBucketState,
  opts: TokenBucketOptions,
  cost: number,
  now: number,
): { result: ConsumeResult; state: TokenBucketState } {
  const elapsedSec = Math.max(0, (now - prev.lastRefillMs) / 1000);
  const tokens = Math.min(opts.capacity, prev.tokens + elapsedSec * opts.refillPerSec);

  if (tokens >= cost) {
    const state = { tokens: tokens - cost, lastRefillMs: now };
    return { result: { allowed: true, remaining: state.tokens, retryAfterMs: 0 }, state };
  }
  const deficit = cost - tokens;
  const retryAfterMs = opts.refillPerSec > 0 ? Math.ceil((deficit / opts.refillPerSec) * 1000) : Infinity;
  return {
    result: { allowed: false, remaining: tokens, retryAfterMs },
    state: { tokens, lastRefillMs: now },
  };
}

export interface TokenBucketLimiter {
  /** Try to consume `cost` (default 1) tokens from the bucket at `key`. */
  tryConsume(key: string, cost?: number): Promise<ConsumeResult>;
}

/** In-memory limiter for tests / single-process use. Clock is injectable. */
export class InMemoryTokenBucket implements TokenBucketLimiter {
  private readonly state = new Map<string, TokenBucketState>();

  constructor(
    private readonly opts: TokenBucketOptions,
    private readonly now: () => number = Date.now,
  ) {}

  async tryConsume(key: string, cost = 1): Promise<ConsumeResult> {
    const prev = this.state.get(key) ?? { tokens: this.opts.capacity, lastRefillMs: this.now() };
    const { result, state } = refillAndConsume(prev, this.opts, cost, this.now());
    this.state.set(key, state);
    return result;
  }
}

/** Minimal Redis surface needed for the atomic Lua eval (decoupled from ioredis). */
export interface EvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Atomic refill-then-consume in Redis via Lua, so the bucket is correct across
 * all orchestrator instances (no read-modify-write race). Stores `tokens` and
 * `ts` (ms) in a hash at `key`. Mirrors `refillAndConsume`.
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
local elapsed = math.max(0, (now - ts) / 1000)
tokens = math.min(capacity, tokens + elapsed * refill)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil(((cost - tokens) / refill) * 1000)
end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
return { allowed, tostring(tokens), retry }
`;

export class RedisTokenBucket implements TokenBucketLimiter {
  constructor(
    private readonly client: EvalClient,
    private readonly opts: TokenBucketOptions,
    private readonly now: () => number = Date.now,
  ) {}

  async tryConsume(key: string, cost = 1): Promise<ConsumeResult> {
    const res = (await this.client.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      this.opts.capacity,
      this.opts.refillPerSec,
      cost,
      this.now(),
    )) as [number, string, number];
    return { allowed: res[0] === 1, remaining: Number(res[1]), retryAfterMs: Number(res[2]) };
  }
}
