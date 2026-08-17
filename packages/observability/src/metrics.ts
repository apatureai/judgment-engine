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
  /**
   * Runs where the engine measured a violation on a route it reviewed and the
   * judge returned nothing at all, so the grade was retracted.
   *
   * The reversal signal for the retraction itself. A rate above roughly 2% of
   * graded runs against a strong judge, or above 20% within any single repo,
   * means zero findings on a measured page is a NORMAL outcome of a competent
   * model on a mature design system rather than a judge failure, and the
   * retraction should be demoted to a rendered caveat. A value that tracks model
   * SIZE rather than page CONTENT means it is a model-capability detector rather
   * than a page review, and belongs in the eval harness instead.
   */
  measuredFactsUnjudged: "engine.critique.measured_facts_unjudged",
  /**
   * Results published with no `measurements` field at all, so nobody downstream
   * can infer "clean" from silence. Absence of a measurement is not a
   * measurement of absence, and this counts how often the distinction is live.
   */
  measurementsAbsent: "engine.critique.measurements_absent",
  /** Capture-instability ratio (0..1) feeding the confidence ceiling (#70/#72). */
  captureInstability: "engine.capture.instability",
  queueDepth: "engine.queue.depth",
  /** Times a model endpoint returned 429 / token-bucket denied (#36). */
  modelRateLimited: "engine.model.rate_limited",
  /** Prefix-cache hit ratio for the stable context block (#34). */
  cacheHit: "engine.critique.cache_hit",
  /** Model-reported cached input tokens per call; 0 means the prefix cache missed (#34). */
  cacheReadInputTokens: "engine.model.cache_read_input_tokens",
  /** Claims currently leased by live workers (#166). */
  activeLeases: "engine.job.active_leases",
  /** Age of the oldest running attempt; alert before Gate's 10-min deadline (#166). */
  oldestRunningMs: "engine.job.oldest_running_ms",
  /** Expired attempts recovered by the reaper, by outcome (#166). */
  leaseRecovered: "engine.job.lease_recovered",
  /** Publications/finalizations rejected by claim-generation fencing (#166). */
  fencedCompletions: "engine.job.fenced_completions",
  /** Attempts that failed terminally at the attempt budget after lease expiry (#166). */
  leaseTerminalFailures: "engine.job.lease_terminal_failures",
  /** Final UI-DNA authority lookup latency at publication (#175). */
  authorityLookupLatency: "engine.authority.lookup_latency_ms",
  /** Fail-closed UI-DNA authority checks, partitioned by bounded reason (#175). */
  authorityLookupFailures: "engine.authority.lookup_failures",
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
  private readonly measuredFactsUnjudged: Counter;
  private readonly measurementsAbsent: Counter;
  private readonly captureInstability: Histogram;
  private readonly modelRateLimited: Counter;
  private readonly cacheHit: Histogram;
  private readonly cacheReadInputTokens: Histogram;
  private readonly leaseRecovered: Counter;
  private readonly fencedCompletions: Counter;
  private readonly leaseTerminalFailures: Counter;
  private readonly authorityLookupLatency: Histogram;
  private readonly authorityLookupFailures: Counter;
  private queueDepthProvider: () => number = () => 0;
  private leaseStatsProvider: () => { activeLeases: number; oldestRunningMs: number | null } = () => ({
    activeLeases: 0,
    oldestRunningMs: null,
  });

  constructor(meter: Meter = metrics.getMeter(METER_NAME)) {
    this.jobLatency = meter.createHistogram(METRIC_NAMES.jobLatency, { unit: "ms" });
    this.captureLatency = meter.createHistogram(METRIC_NAMES.captureLatency, { unit: "ms" });
    this.critiqueLatency = meter.createHistogram(METRIC_NAMES.critiqueLatency, { unit: "ms" });
    this.hallucinationDrops = meter.createCounter(METRIC_NAMES.hallucinationDrops, {
      description: "Findings dropped by the post-parse hallucination gate.",
    });
    this.measuredFactsUnjudged = meter.createCounter(METRIC_NAMES.measuredFactsUnjudged, {
      description: "Runs whose grade was retracted because a measured page drew no finding at all.",
    });
    this.measurementsAbsent = meter.createCounter(METRIC_NAMES.measurementsAbsent, {
      description: "Results published with no measurements field, so 'clean' cannot be inferred.",
    });
    this.captureInstability = meter.createHistogram(METRIC_NAMES.captureInstability, {
      description: "Capture-instability ratio (0..1).",
    });
    this.modelRateLimited = meter.createCounter(METRIC_NAMES.modelRateLimited);
    this.cacheHit = meter.createHistogram(METRIC_NAMES.cacheHit, {
      description: "Prefix-cache hit ratio for the stable context block (0..1).",
    });
    this.cacheReadInputTokens = meter.createHistogram(METRIC_NAMES.cacheReadInputTokens, {
      description: "Model-reported cached input tokens per call; 0 indicates a prefix-cache miss.",
    });

    this.leaseRecovered = meter.createCounter(METRIC_NAMES.leaseRecovered, {
      description: "Expired attempts recovered by the lease reaper, by outcome.",
    });
    this.fencedCompletions = meter.createCounter(METRIC_NAMES.fencedCompletions, {
      description: "Publications rejected by claim-generation fencing.",
    });
    this.leaseTerminalFailures = meter.createCounter(METRIC_NAMES.leaseTerminalFailures, {
      description: "Attempts failed terminally at the attempt budget after lease expiry.",
    });
    this.authorityLookupLatency = meter.createHistogram(METRIC_NAMES.authorityLookupLatency, {
      unit: "ms",
      description: "Final UI-DNA authority lookup latency at result publication.",
    });
    this.authorityLookupFailures = meter.createCounter(METRIC_NAMES.authorityLookupFailures, {
      description: "Grounding-authority checks that failed closed before publication.",
    });

    meter
      .createObservableGauge(METRIC_NAMES.queueDepth, { description: "Pending review jobs." })
      .addCallback((observer: ObservableResult) => observer.observe(this.queueDepthProvider()));
    meter
      .createObservableGauge(METRIC_NAMES.activeLeases, { description: "Claims leased by live workers." })
      .addCallback((observer: ObservableResult) =>
        observer.observe(this.leaseStatsProvider().activeLeases),
      );
    meter
      .createObservableGauge(METRIC_NAMES.oldestRunningMs, {
        unit: "ms",
        description: "Age of the oldest running attempt.",
      })
      .addCallback((observer: ObservableResult) =>
        observer.observe(this.leaseStatsProvider().oldestRunningMs ?? 0),
      );
  }

  /** Count an expired attempt the reaper recovered ("requeued" | "failed" | "canceled"). */
  recordLeaseRecovered(outcome: string): void {
    this.leaseRecovered.add(1, { outcome });
    if (outcome === "failed") this.leaseTerminalFailures.add(1);
  }

  /** Count a publication/finalization rejected by claim-generation fencing. */
  recordFencedCompletion(): void {
    this.fencedCompletions.add(1);
  }

  recordAuthorityLookupLatency(ms: number, attributes?: Attributes): void {
    this.authorityLookupLatency.record(ms, attributes);
  }

  recordAuthorityLookupFailure(reason: string): void {
    this.authorityLookupFailures.add(1, { reason });
  }

  /** Register the callback the lease gauges (active, oldest-running age) read on collection. */
  setLeaseStatsProvider(
    provider: () => { activeLeases: number; oldestRunningMs: number | null },
  ): void {
    this.leaseStatsProvider = provider;
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

  /** The `measured_facts_unjudged` retraction fired on this run. */
  recordMeasuredFactsUnjudged(attributes?: Attributes): void {
    this.measuredFactsUnjudged.add(1, attributes);
  }

  /** This result carried no measurements at all, so silence is not cleanliness. */
  recordMeasurementsAbsent(attributes?: Attributes): void {
    this.measurementsAbsent.add(1, attributes);
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

  /** Record the model-reported cached input tokens for a call (0 = cache miss). */
  recordCacheReadInputTokens(tokens: number, attributes?: Attributes): void {
    this.cacheReadInputTokens.record(tokens, attributes);
  }

  /** Register a callback the queue-depth observable gauge reads on collection. */
  setQueueDepthProvider(provider: () => number): void {
    this.queueDepthProvider = provider;
  }
}
