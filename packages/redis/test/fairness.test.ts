import { describe, expect, it } from "vitest";
import { FairnessGate, InMemoryTokenBucket } from "../src/index.js";

describe("FairnessGate (#67)", () => {
  it("admits within both tenant quota and endpoint cap", async () => {
    const gate = new FairnessGate(
      new InMemoryTokenBucket({ capacity: 5, refillPerSec: 0 }),
      new InMemoryTokenBucket({ capacity: 5, refillPerSec: 0 }),
    );
    const decision = await gate.admit("inst_1", "qwen3-vl-plus");
    expect(decision).toEqual({ admitted: true, retryAfterMs: 0 });
  });

  it("denies (tenant_quota) when one tenant exceeds its quota, protecting others", async () => {
    const gate = new FairnessGate(
      new InMemoryTokenBucket({ capacity: 1, refillPerSec: 0 }), // per-tenant quota = 1
      new InMemoryTokenBucket({ capacity: 100, refillPerSec: 0 }), // endpoint has room
    );
    expect((await gate.admit("greedy", "ep")).admitted).toBe(true);
    const second = await gate.admit("greedy", "ep");
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe("tenant_quota");
    // A different tenant is unaffected (independent quota bucket).
    expect((await gate.admit("other", "ep")).admitted).toBe(true);
  });

  it("denies (endpoint) when the shared endpoint cap is exhausted", async () => {
    const gate = new FairnessGate(
      new InMemoryTokenBucket({ capacity: 100, refillPerSec: 0 }),
      new InMemoryTokenBucket({ capacity: 1, refillPerSec: 1 }), // endpoint = 1, refills
    );
    expect((await gate.admit("t1", "ep")).admitted).toBe(true);
    const denied = await gate.admit("t2", "ep");
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toBe("endpoint");
    expect(denied.retryAfterMs).toBeGreaterThan(0); // Retry-After backpressure, job stays queued
  });
});
