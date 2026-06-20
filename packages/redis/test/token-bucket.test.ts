import { describe, expect, it } from "vitest";
import {
  InMemoryTokenBucket,
  modelEndpointTokenBucketKey,
  refillAndConsume,
  RedisTokenBucket,
  type EvalClient,
} from "../src/index.js";

describe("refillAndConsume", () => {
  it("consumes when tokens are available and refills over time", () => {
    const opts = { capacity: 10, refillPerSec: 1 };
    const start = { tokens: 5, lastRefillMs: 0 };
    const consumed = refillAndConsume(start, opts, 3, 0);
    expect(consumed.result.allowed).toBe(true);
    expect(consumed.result.remaining).toBe(2);

    // 4s later -> +4 tokens (capped at capacity).
    const later = refillAndConsume(consumed.state, opts, 1, 4000);
    expect(later.result.allowed).toBe(true);
    expect(later.result.remaining).toBeCloseTo(2 + 4 - 1, 5);
  });

  it("denies with a retry-after when under-provisioned", () => {
    const { result } = refillAndConsume({ tokens: 0, lastRefillMs: 0 }, { capacity: 5, refillPerSec: 2 }, 1, 0);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(500); // 1 token at 2/sec
  });
});

describe("InMemoryTokenBucket (global model-endpoint cap)", () => {
  it("caps bursts at capacity then denies with backpressure", async () => {
    let now = 0;
    const bucket = new InMemoryTokenBucket({ capacity: 2, refillPerSec: 1 }, () => now);
    const key = modelEndpointTokenBucketKey("qwen3-vl-plus");

    expect((await bucket.tryConsume(key)).allowed).toBe(true);
    expect((await bucket.tryConsume(key)).allowed).toBe(true);
    const denied = await bucket.tryConsume(key);
    expect(denied.allowed).toBe(false); // over the endpoint limit -> deny (job stays queued)
    expect(denied.retryAfterMs).toBeGreaterThan(0);

    // After 1s, one token refills.
    now = 1000;
    expect((await bucket.tryConsume(key)).allowed).toBe(true);
  });

  it("buckets are independent per endpoint key", async () => {
    const bucket = new InMemoryTokenBucket({ capacity: 1, refillPerSec: 0 });
    expect((await bucket.tryConsume("tb:model:a")).allowed).toBe(true);
    expect((await bucket.tryConsume("tb:model:a")).allowed).toBe(false);
    expect((await bucket.tryConsume("tb:model:b")).allowed).toBe(true); // separate bucket
  });
});

describe("RedisTokenBucket", () => {
  it("passes capacity/refill/cost/now to the atomic Lua eval and parses the result", async () => {
    const calls: Array<(string | number)[]> = [];
    const client: EvalClient = {
      eval: async (_script, _numKeys, ...args) => {
        calls.push(args);
        return [1, "4", 0];
      },
    };
    const bucket = new RedisTokenBucket(client, { capacity: 5, refillPerSec: 2 }, () => 1234);
    const result = await bucket.tryConsume("tb:model:x", 1);

    expect(result).toEqual({ allowed: true, remaining: 4, retryAfterMs: 0 });
    expect(calls[0]).toEqual(["tb:model:x", 5, 2, 1, 1234]);
  });
});
