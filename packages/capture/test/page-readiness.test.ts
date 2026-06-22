import { describe, expect, it } from "vitest";
import {
  GOTO_BUDGET_MS,
  READY_WAIT_UNTIL,
  awaitPageReady,
  recheckFontsAfterScroll,
  type ReadinessOps,
} from "../src/index.js";

/** Records every readiness op in call order, with the goto args it saw. */
function tracer() {
  const order: string[] = [];
  let gotoArgs: { waitUntil: string; timeoutMs: number } | null = null;
  let layoutArgs: { quietMs: number; timeoutMs: number } | null = null;
  let lastSelector: string | null = null;
  const ops: ReadinessOps = {
    async goto(opts) {
      gotoArgs = opts;
      order.push(`goto:${opts.waitUntil}`);
    },
    async waitForSelector(selector) {
      lastSelector = selector;
      order.push("selector");
    },
    async waitForFontsReady() {
      order.push("fonts");
    },
    async waitForLayoutStable(opts) {
      layoutArgs = opts;
      order.push("layout");
    },
  };
  return { order, ops, getGoto: () => gotoArgs, getLayout: () => layoutArgs, getSelector: () => lastSelector };
}

describe("awaitPageReady (#12)", () => {
  it("gotos with domcontentloaded + a 30s budget and NEVER networkidle", async () => {
    const t = tracer();
    await awaitPageReady(t.ops);
    expect(READY_WAIT_UNTIL).toBe("domcontentloaded");
    expect(t.getGoto()).toEqual({ waitUntil: "domcontentloaded", timeoutMs: GOTO_BUDGET_MS });
    expect(GOTO_BUDGET_MS).toBe(30_000);
    // networkidle is never an op the protocol can emit.
    expect(JSON.stringify(t.getGoto())).not.toContain("networkidle");
  });

  it("waits on fonts.ready and a no-layout-shift idle window, in order, after goto", async () => {
    const t = tracer();
    await awaitPageReady(t.ops);
    expect(t.order).toEqual(["goto:domcontentloaded", "fonts", "layout"]);
    expect(t.getLayout()).toEqual({ quietMs: 500, timeoutMs: 10_000 });
  });

  it("honors a ready_selector override, awaited after goto and before fonts/layout", async () => {
    const t = tracer();
    await awaitPageReady(t.ops, { readySelector: "#app-ready" });
    expect(t.order).toEqual(["goto:domcontentloaded", "selector", "fonts", "layout"]);
    expect(t.getSelector()).toBe("#app-ready");
  });

  it("skips the selector wait when no override (or an empty one) is given", async () => {
    const t = tracer();
    await awaitPageReady(t.ops, { readySelector: "" });
    expect(t.order).not.toContain("selector");
  });

  it("respects custom budgets/windows", async () => {
    const t = tracer();
    await awaitPageReady(t.ops, { gotoBudgetMs: 15_000, layoutQuietMs: 750, layoutTimeoutMs: 5_000 });
    expect(t.getGoto()!.timeoutMs).toBe(15_000);
    expect(t.getLayout()).toEqual({ quietMs: 750, timeoutMs: 5_000 });
  });
});

describe("recheckFontsAfterScroll (#12)", () => {
  it("re-checks fonts.ready once after the scroll step", async () => {
    let fontChecks = 0;
    await recheckFontsAfterScroll({ waitForFontsReady: async () => void fontChecks++ });
    expect(fontChecks).toBe(1);
  });
});
