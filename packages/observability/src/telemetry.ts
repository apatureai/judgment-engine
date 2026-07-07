import { metrics, propagation } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, type MetricReader } from "@opentelemetry/sdk-metrics";
import { NodeTracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface TelemetryOptions {
  serviceName?: string;
  serviceVersion?: string;
  /** Metric readers (e.g. an OTLP PeriodicExportingMetricReader, or in-memory in tests). */
  metricReaders?: MetricReader[];
  /** Span processors (e.g. a BatchSpanProcessor wrapping an OTLP exporter). */
  spanProcessors?: SpanProcessor[];
}

export interface Telemetry {
  meterProvider: MeterProvider;
  tracerProvider: NodeTracerProvider;
  shutdown(): Promise<void>;
}

/**
 * Wire OpenTelemetry providers and register them globally. Exporters are
 * injected (or wired from OTEL_* env by the runtime) so this package stays
 * exporter-agnostic and testable with in-memory readers. The W3C propagator is
 * registered so trace context survives the job-payload hop (`propagation.ts`).
 */
export function initTelemetry(options: TelemetryOptions = {}): Telemetry {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName ?? "engine",
    [ATTR_SERVICE_VERSION]: options.serviceVersion ?? "0.0.0",
  });

  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const meterProvider = new MeterProvider({ resource, readers: options.metricReaders ?? [] });
  metrics.setGlobalMeterProvider(meterProvider);

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: options.spanProcessors ?? [],
  });
  tracerProvider.register();

  return {
    meterProvider,
    tracerProvider,
    async shutdown() {
      await Promise.all([meterProvider.shutdown(), tracerProvider.shutdown()]);
    },
  };
}
