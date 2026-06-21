import { describe, expect, it } from "vitest";
import {
  CAPTURE_EPOCH_MS,
  PRELOAD_SKEW_MS,
  type PageClock,
  type CapturePhases,
  withDeterministicClock,
} from "../src/index.js";

/** Records every clock call and capture phase in the order they happen. */
function tracer() {
  const order: string[] = [];
  const clock: PageClock = {
    async install(opts) {
      order.push(`install@${opts.time}`);
    },
    async pauseAt(time) {
      order.push(`pauseAt@${time}`);
    },
  };
  const phases: CapturePhases = {
    goto: async () => void order.push("goto"),
    awaitReadiness: async () => void order.push("readiness"),
    scrollForLazyLoad: async () => void order.push("scroll"),
  };
  return { order, clock, phases };
}

describe("withDeterministicClock (#102)", () => {
  it("installs before goto, pins after readiness, and re-pins after scroll", async () => {
    const { order, clock, phases } = tracer();
    await withDeterministicClock(clock, phases);
    expect(order).toEqual([
      `install@${CAPTURE_EPOCH_MS - PRELOAD_SKEW_MS}`,
      "goto",
      "readiness",
      `pauseAt@${CAPTURE_EPOCH_MS}`,
      "scroll",
      `pauseAt@${CAPTURE_EPOCH_MS}`,
    ]);
  });

  it("installs slightly BEFORE the epoch so load timers run, then pins exactly at the epoch", async () => {
    const { order, clock, phases } = tracer();
    await withDeterministicClock(clock, phases);
    expect(order[0]).toBe(`install@${CAPTURE_EPOCH_MS - PRELOAD_SKEW_MS}`);
    expect(order.filter((o) => o === `pauseAt@${CAPTURE_EPOCH_MS}`)).toHaveLength(2);
    expect(PRELOAD_SKEW_MS).toBeGreaterThan(0);
  });

  it("pins to a deterministic constant epoch, NOT wall-clock now()", () => {
    // A fixed instant identical across baseline/head/re-captures (2025-01-01T00:00:00Z).
    expect(CAPTURE_EPOCH_MS).toBe(Date.UTC(2025, 0, 1, 0, 0, 0));
    expect(CAPTURE_EPOCH_MS).toBeLessThan(Date.now()); // not derived from now
  });

  it("installs before the page can hang on a timer (install precedes goto)", async () => {
    const { order, clock, phases } = tracer();
    await withDeterministicClock(clock, phases);
    expect(order.indexOf("install@" + (CAPTURE_EPOCH_MS - PRELOAD_SKEW_MS))).toBeLessThan(order.indexOf("goto"));
    expect(order.indexOf("readiness")).toBeLessThan(order.lastIndexOf(`pauseAt@${CAPTURE_EPOCH_MS}`));
  });
});
