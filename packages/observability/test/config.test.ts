import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const observabilityDir = fileURLToPath(new URL("../../../observability/", import.meta.url));
const alerts = readFileSync(`${observabilityDir}alerts.yaml`, "utf8");
const dashboard = JSON.parse(readFileSync(`${observabilityDir}dashboard.json`, "utf8")) as {
  panels: Array<{ title: string; targets: Array<{ expr: string }> }>;
};

describe("alert config", () => {
  it("fires when a repo's cache-hit rate drops", () => {
    expect(alerts).toContain("EngineRepoCacheHitRateDrop");
    expect(alerts).toContain("engine_critique_cache_hit_sum");
  });

  it("fires on cache_read_input_tokens == 0", () => {
    expect(alerts).toContain("EngineCacheReadInputTokensZero");
    expect(alerts).toMatch(/engine_model_cache_read_input_tokens_sum\[15m\]\)\s*==\s*0/);
  });

  it("covers the hallucination-drop and queue-depth SLOs", () => {
    expect(alerts).toContain("engine_critique_hallucination_drops_total");
    expect(alerts).toContain("engine_queue_depth");
  });
});

describe("dashboard config", () => {
  it("covers queue depth, per-stage latency, warm-pool, cache-hit, and hallucination-drop", () => {
    const titles = dashboard.panels.map((p) => p.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Queue depth",
        "Per-stage latency (p95)",
        "Warm-pool utilization",
        "Cache-hit rate",
        "Hallucination-drop rate",
      ]),
    );

    const exprs = dashboard.panels.flatMap((p) => p.targets.map((t) => t.expr)).join("\n");
    expect(exprs).toContain("engine_queue_depth");
    expect(exprs).toContain("engine_capture_latency_ms_bucket");
    expect(exprs).toContain("engine_warm_pool_utilization");
    expect(exprs).toContain("engine_critique_cache_hit_sum");
    expect(exprs).toContain("engine_critique_hallucination_drops_total");
  });
});
