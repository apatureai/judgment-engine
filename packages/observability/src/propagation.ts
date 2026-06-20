import { context, propagation } from "@opentelemetry/api";

/**
 * W3C trace-context carrier embedded in the job payload so the trace started at
 * job submission continues across the async boundary (queue -> worker). The
 * orchestrator injects on enqueue; the worker extracts and runs the pipeline
 * under the same trace (criterion: trace id propagates via the queue payload).
 */
export interface JobTraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

/** Capture the active trace context into a carrier to store on the job payload. */
export function injectTraceContext(carrier: JobTraceCarrier = {}): JobTraceCarrier {
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Run `fn` with the trace context extracted from a job carrier as the parent. */
export function runWithTraceContext<T>(carrier: JobTraceCarrier, fn: () => T): T {
  const ctx = propagation.extract(context.active(), carrier);
  return context.with(ctx, fn);
}
