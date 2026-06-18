import {
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  metrics,
  type ObservableResult,
} from "@opentelemetry/api";

export const METER_NAME = "engine";

export const METRIC_NAMES = {
  jobLatency: "engine.job.latency_ms",
  captureLatency: "engine.capture.latency_ms",
  critiqueLatency: "engine.critique.latency_ms",
  /** Findings dropped by the post-parse hallucination gate (#32/#72 SLO). */
  hallucinationDrops: "engine.critique.hallucination_drops",
  /** Capture-instability ratio (0..1) feeding the confidence ceiling (#70/#72). */
  captureInstability: "engine.capture.instability",
  queueDepth: "engine.queue.depth",
  /** Times a model endpoint returned 429 / token-bucket denied (#36). */
  modelRateLimited: "engine.model.rate_limited",
  /** Prefix-cache hit ratio for the stable context block (#34). */
  cacheHit: "engine.critique.cache_hit",
} as const;

/**
 * Typed facade over the engine metric instruments (TRD §14; architecture review
 * E6). Build it from a Meter; in production the global meter is wired by
 * `initTelemetry`. These feed the SLO gates (#72) and Grafana dashboards (#9).
 */
export class EngineMetrics {
  private readonly jobLatency: Histogram;
  private readonly captureLatency: Histogram;
  private readonly critiqueLatency: Histogram;
  private readonly hallucinationDrops: Counter;
  private readonly captureInstability: Histogram;
  private readonly modelRateLimited: Counter;
  private readonly cacheHit: Histogram;
  private queueDepthProvider: () => number = () => 0;

  constructor(meter: Meter = metrics.getMeter(METER_NAME)) {
    this.jobLatency = meter.createHistogram(METRIC_NAMES.jobLatency, { unit: "ms" });
    this.captureLatency = meter.createHistogram(METRIC_NAMES.captureLatency, { unit: "ms" });
    this.critiqueLatency = meter.createHistogram(METRIC_NAMES.critiqueLatency, { unit: "ms" });
    this.hallucinationDrops = meter.createCounter(METRIC_NAMES.hallucinationDrops, {
      description: "Findings dropped by the post-parse hallucination gate.",
    });
    this.captureInstability = meter.createHistogram(METRIC_NAMES.captureInstability, {
      description: "Capture-instability ratio (0..1).",
    });
    this.modelRateLimited = meter.createCounter(METRIC_NAMES.modelRateLimited);
    this.cacheHit = meter.createHistogram(METRIC_NAMES.cacheHit, {
      description: "Prefix-cache hit ratio for the stable context block (0..1).",
    });

    meter
      .createObservableGauge(METRIC_NAMES.queueDepth, { description: "Pending review jobs." })
      .addCallback((observer: ObservableResult) => observer.observe(this.queueDepthProvider()));
  }

  recordJobLatency(ms: number, attributes?: Attributes): void {
    this.jobLatency.record(ms, attributes);
  }

  recordCaptureLatency(ms: number, attributes?: Attributes): void {
    this.captureLatency.record(ms, attributes);
  }

  recordCritiqueLatency(ms: number, attributes?: Attributes): void {
    this.critiqueLatency.record(ms, attributes);
  }

  recordHallucinationDrops(count: number, attributes?: Attributes): void {
    this.hallucinationDrops.add(count, attributes);
  }

  recordCaptureInstability(ratio: number, attributes?: Attributes): void {
    this.captureInstability.record(ratio, attributes);
  }

  recordModelRateLimited(attributes?: Attributes): void {
    this.modelRateLimited.add(1, attributes);
  }

  recordCacheHit(ratio: number, attributes?: Attributes): void {
    this.cacheHit.record(ratio, attributes);
  }

  /** Register a callback the queue-depth observable gauge reads on collection. */
  setQueueDepthProvider(provider: () => number): void {
    this.queueDepthProvider = provider;
  }
}
