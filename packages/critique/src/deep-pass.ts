import type { ModelClient, ModelImage, ModelMessage } from "./model.js";
import { parseCritiqueOutput, schemaInstruction, type CritiqueOutput } from "./schema.js";

/**
 * Deep critique pass (TRD §6.2/§6.5, #29): one request per route, capped at 3
 * concurrent, on the Qwen3-VL Thinking checkpoint. Because thinking and
 * structured output are mutually exclusive on DashScope (confirmed 2026-06-18),
 * each route is a TWO-STEP: (1) a Thinking critique (prose + reasoning), then
 * (2) a non-thinking `json_object` coercion of that prose to the schema (#31).
 * `max_tokens` is never set on the structured step. Self-host (#76) can do this
 * in one guided-decoding call. The pass never returns a partial: a route whose
 * coercion fails Zod contributes no findings rather than malformed output.
 */
export interface DeepPassRoute {
  route: string;
  /** Tiled, labeled, budget-fitted images for this route (#16/#17). */
  images: ModelImage[];
  /** Deterministic facts (contrast/overflow/touch-target, #19) rendered for the prompt. */
  facts?: string[];
  /** Per-repo memory digest suffix (#41), optional. */
  feedbackDigest?: string;
}

export interface DeepPassDeps {
  client: ModelClient;
  model: string;
  /** The frozen system prompt (#30). */
  systemPrompt: string;
  /** Serialized deterministic context block (#63) placed under the prefix-cache boundary. */
  contextBlock: string;
  maxPixels: number;
  concurrency?: number;
  signal?: AbortSignal;
}

export interface DeepPassRouteResult {
  route: string;
  /** Validated output, or null if the coercion failed (no partial emitted). */
  output: CritiqueOutput | null;
}

function thinkingMessages(deps: DeepPassDeps, route: DeepPassRoute): ModelMessage[] {
  const factLines = route.facts && route.facts.length > 0 ? `\nDeterministic facts:\n${route.facts.join("\n")}` : "";
  const digest = route.feedbackDigest ? `\nRepo memory:\n${route.feedbackDigest}` : "";
  return [
    // Stable prefix first (context block) so prefix caching reuses it (#34).
    { role: "system", content: `${deps.systemPrompt}\n\nREPO CONTEXT:\n${deps.contextBlock}` },
    {
      role: "user",
      content: `Review route ${route.route}. Cite segment labels + element_ref.${factLines}${digest}`,
      images: route.images,
    },
  ];
}

function coercionMessages(prose: string): ModelMessage[] {
  return [
    { role: "system", content: `Convert the review below into JSON.\n${schemaInstruction()}` },
    { role: "user", content: prose },
  ];
}

/** Two-step critique for a single route: Thinking prose -> json_object coercion -> Zod. */
export async function critiqueRouteTwoStep(
  deps: DeepPassDeps,
  route: DeepPassRoute,
): Promise<DeepPassRouteResult> {
  const opts = deps.signal ? { signal: deps.signal } : undefined;

  // Step 1: Thinking critique (prose + reasoning); no response_format.
  const thinking = await deps.client.complete(
    { model: deps.model, thinking: true, maxPixels: deps.maxPixels, messages: thinkingMessages(deps, route) },
    opts,
  );

  // Step 2: non-thinking json_object coercion of the prose (max_tokens never set).
  const coerced = await deps.client.complete(
    { model: deps.model, thinking: false, responseFormat: "json_object", messages: coercionMessages(thinking.text) },
    opts,
  );

  const parsed = parseCritiqueOutput(coerced.text);
  return { route: route.route, output: parsed.ok ? parsed.value : null };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Deep pass over all routes: one two-step request per route, <=3 concurrent. */
export function runDeepPass(deps: DeepPassDeps, routes: DeepPassRoute[]): Promise<DeepPassRouteResult[]> {
  return mapWithConcurrency(routes, deps.concurrency ?? 3, (route) => critiqueRouteTwoStep(deps, route));
}
