import { type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";

export const TRACER_NAME = "engine";

/**
 * Span taxonomy covering the full review path inside the engine (TRD §14):
 * job receive -> capture -> context extraction -> triage pass -> deep pass ->
 * validation -> persist. Every stage runs under one trace per job, with the
 * parent propagated from the job payload (see `propagation.ts`).
 */
export const SPAN_NAMES = {
  jobReceive: "engine.job.receive",
  capture: "engine.capture",
  context: "engine.context",
  triage: "engine.critique.triage",
  deep: "engine.critique.deep",
  validate: "engine.critique.validate",
  persist: "engine.persist",
} as const;

export type SpanName = (typeof SPAN_NAMES)[keyof typeof SPAN_NAMES];

/** Version stamp carried on critique spans + the wire result (#68). */
export interface VersionStamp {
  engineVersion: string;
  model: string;
  promptVersion: string;
  captureVersion: string;
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Annotate a span with the engine version stamp so traces can be filtered and
 * regressions attributed to a specific model/prompt/capture revision (#68).
 */
export function setVersionAttributes(span: Span, stamp: VersionStamp): void {
  span.setAttributes({
    "engine.engine_version": stamp.engineVersion,
    "engine.model": stamp.model,
    "engine.prompt_version": stamp.promptVersion,
    "engine.capture_version": stamp.captureVersion,
  });
}

/**
 * Run `fn` inside an active span, recording success/error status and ending the
 * span. Errors are recorded and re-thrown so callers keep normal control flow.
 */
export async function withSpan<T>(
  name: SpanName,
  fn: (span: Span) => Promise<T>,
  tracer: Tracer = getTracer(),
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof Error) span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}
