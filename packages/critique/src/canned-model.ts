import { z } from "zod";
import type {
  ModelBackend,
  ModelCallOptions,
  ModelClient,
  ModelRequest,
  ModelResponse,
} from "./model.js";

/**
 * Replay model client: answers the pipeline's calls from a recorded/authored
 * script instead of a network round-trip.
 *
 * This exists so the whole pipeline — capture, grounding, the drop-and-count
 * hallucination gate, grade reconciliation, the wire projection — can be
 * exercised end to end with no API key. It is NOT a model and makes no attempt
 * to be one: it does not look at the images, and whatever the script says is
 * what it says. The engine's validation tail then treats that output exactly as
 * it treats a real model's, which is the point: a scripted finding that cites a
 * route or an element the capture never produced gets DROPPED, and the drop is
 * counted, just like a hallucination from a live model.
 *
 * `MockModelClient` remains the zero-config default (well-formed, empty). This
 * client is for demonstrating and regression-testing the validation tail against
 * known-adversarial output.
 */

const CritiqueLikeSchema = z
  .object({
    grade: z.string(),
    overall: z.string(),
    findings: z.array(z.record(z.string(), z.unknown())),
    notReviewed: z.array(z.string()).optional(),
  })
  .passthrough();

export const CannedScriptSchema = z.object({
  /** Answer for the cheap triage pass. */
  triage: z.object({
    needsDeepReview: z.boolean(),
    suspectRoutes: z.array(z.string()).default([]),
    obviousBreakage: z.array(z.string()).default([]),
  }),
  /** Per-route deep-pass critique, keyed by route path. */
  routes: z.record(z.string(), CritiqueLikeSchema),
});

export type CannedScript = z.infer<typeof CannedScriptSchema>;

/** Parse a canned script (from JSON), returning a typed error rather than throwing. */
export function parseCannedScript(raw: unknown): { ok: true; script: CannedScript } | { ok: false; error: string } {
  const parsed = CannedScriptSchema.safeParse(raw);
  return parsed.success ? { ok: true, script: parsed.data } : { ok: false, error: parsed.error.message };
}

/** Marker the thinking step emits so the coercion step can identify the route. */
const ROUTE_MARKER = /^\[route:(.+?)\]/;

function routeFromDeepPrompt(request: ModelRequest): string | null {
  const user = request.messages.find((m) => m.role === "user")?.content ?? "";
  const direct = /^Review route (\S+?)\./.exec(user);
  if (direct?.[1]) return direct[1];
  const marker = ROUTE_MARKER.exec(user.trim());
  return marker?.[1] ?? null;
}

function isTriageRequest(request: ModelRequest): boolean {
  const system = request.messages.find((m) => m.role === "system")?.content ?? "";
  return system.startsWith("You are triaging");
}

const EMPTY_CRITIQUE = { grade: "ship", overall: "no scripted critique for this route", findings: [] };

export class CannedModelClient implements ModelClient {
  readonly backend: ModelBackend;
  /** Every request seen, for assertions. */
  readonly calls: ModelRequest[] = [];

  constructor(private readonly script: CannedScript, backend: ModelBackend = "mock") {
    this.backend = backend;
  }

  async complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse> {
    if (options?.signal?.aborted) throw new Error("aborted");
    this.calls.push(request);
    return {
      text: this.respond(request),
      thinkingText: request.thinking ? "scripted reasoning" : undefined,
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      finishReason: "stop",
    };
  }

  private respond(request: ModelRequest): string {
    if (isTriageRequest(request)) return JSON.stringify(this.script.triage);

    const route = routeFromDeepPrompt(request);
    const critique = route !== null ? this.script.routes[route] : undefined;

    // Deep pass, step 1: prose. Carry the route in a marker so the non-thinking
    // coercion step — whose only input is this prose — can find it again.
    if (request.responseFormat === undefined) {
      return `[route:${route ?? "unknown"}]\n${critique?.overall ?? "no scripted critique"}`;
    }
    // Coercion step, or the self-host single-call guided-decoding path.
    return JSON.stringify(critique ?? EMPTY_CRITIQUE);
  }
}

/** Factory binding a canned script to every pass. */
export const cannedModelFactory =
  (script: CannedScript) =>
  (config: { backend: ModelBackend }): ModelClient =>
    new CannedModelClient(script, config.backend);
