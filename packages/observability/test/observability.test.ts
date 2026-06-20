import { SpanStatusCode } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  type MetricData,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  EngineMetrics,
  initTelemetry,
  injectTraceContext,
  METRIC_NAMES,
  runWithTraceContext,
  setVersionAttributes,
  SPAN_NAMES,
  withSpan,
  type JobTraceCarrier,
  type Telemetry,
} from "../src/index.js";

const spanExporter = new InMemorySpanExporter();
let telemetry: Telemetry;

beforeAll(() => {
  telemetry = initTelemetry({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
});

afterAll(async () => {
  await telemetry.shutdown();
});

afterEach(() => {
  spanExporter.reset();
});

describe("pipeline spans", () => {
  it("emits a span per stage under one trace and stamps versions on critique", async () => {
    await withSpan(SPAN_NAMES.jobReceive, async () => {
      await withSpan(SPAN_NAMES.capture, async () => {});
      await withSpan(SPAN_NAMES.deep, async (span) => {
        setVersionAttributes(span, {
          engineVersion: "1.2.3",
          model: "qwen3-vl-plus",
          promptVersion: "p@1",
          captureVersion: "c@1",
        });
      });
    });

    const spans = spanExporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(
      expect.arrayContaining([SPAN_NAMES.jobReceive, SPAN_NAMES.capture, SPAN_NAMES.deep]),
    );
    // All stages share one trace per job.
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);

    const deep = spans.find((s) => s.name === SPAN_NAMES.deep);
    expect(deep?.attributes["engine.model"]).toBe("qwen3-vl-plus");
    expect(deep?.attributes["engine.engine_version"]).toBe("1.2.3");
  });

  it("records error status and re-throws", async () => {
    await expect(
      withSpan(SPAN_NAMES.capture, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const span = spanExporter.getFinishedSpans().find((s) => s.name === SPAN_NAMES.capture);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe("trace-context propagation via the job payload", () => {
  it("continues the same trace across the async boundary", async () => {
    let carrier: JobTraceCarrier = {};
    let parentTraceId = "";
    await withSpan(SPAN_NAMES.jobReceive, async (span) => {
      parentTraceId = span.spanContext().traceId;
      carrier = injectTraceContext();
    });

    expect(carrier.traceparent).toContain(parentTraceId);

    // Worker side: extract the carrier and run the pipeline under the parent.
    let childTraceId = "";
    await runWithTraceContext(carrier, async () => {
      await withSpan(SPAN_NAMES.capture, async (span) => {
        childTraceId = span.spanContext().traceId;
      });
    });

    expect(childTraceId).toBe(parentTraceId);
  });
});

function collectMetric(exporter: InMemoryMetricExporter, name: string): MetricData | undefined {
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const metric of sm.metrics) {
        if (metric.descriptor.name === name) return metric;
      }
    }
  }
  return undefined;
}

describe("EngineMetrics", () => {
  it("records SLO instruments and the queue-depth gauge", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const meterProvider = new MeterProvider({ readers: [reader] });

    const m = new EngineMetrics(meterProvider.getMeter("test"));
    m.recordHallucinationDrops(2);
    m.recordCaptureInstability(0.4);
    m.setQueueDepthProvider(() => 5);

    await meterProvider.forceFlush();

    expect(collectMetric(exporter, METRIC_NAMES.hallucinationDrops)).toBeDefined();
    const queueDepth = collectMetric(exporter, METRIC_NAMES.queueDepth);
    expect(queueDepth?.dataPoints[0]?.value).toBe(5);

    await meterProvider.shutdown();
  });
});
