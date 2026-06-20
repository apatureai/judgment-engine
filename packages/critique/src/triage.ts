import { hashesWithin } from "@engine/capture";
import { z } from "zod";
import type { ModelClient, ModelImage } from "./model.js";

/**
 * Triage pass (TRD §6.2, #28). A cheap `qwen3-vl-flash` look over above-the-fold
 * crops + palette + diff summary that decides whether a deep review is warranted,
 * and short-circuits when every captured route's perceptual hash matches the
 * cached baseline (#15/#34) — posting a one-line "no design changes" result
 * without spending the deep pass. Emits `needsDeepReview`, `suspectRoutes`, and
 * `obviousBreakage` (overlap, unstyled HTML, broken images, overflow), folding
 * in the deterministic overflow/breakage facts (#19).
 */
export const TriageOutputSchema = z.object({
  needsDeepReview: z.boolean(),
  suspectRoutes: z.array(z.string()).default([]),
  obviousBreakage: z.array(z.string()).default([]),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

export interface TriageRoute {
  route: string;
  /** Cached baseline perceptual hash (#34/#41), if any. */
  baselinePhash?: string;
  currentPhash: string;
  /** Above-the-fold crops for the triage look. */
  aboveFoldImages: ModelImage[];
  /** Deterministic breakage facts from #19 (e.g. overflow), if any. */
  deterministicBreakage?: string[];
}

export interface TriageDeps {
  client: ModelClient;
  model: string;
  /** Max phash hamming distance counted as unchanged (default 5, matches #15). */
  phashThreshold?: number;
  maxPixels?: number;
  /**
   * Request multimodal `json_object` on the triage call (default true). Set false
   * on generations whose multimodal structured-output support is unconfirmed
   * (e.g. qwen3.5, #87) — the output is still defensively JSON-parsed and the pass
   * fails open, so disabling the hint never weakens correctness.
   */
  structuredOutput?: boolean;
  signal?: AbortSignal;
}

export interface TriageResult {
  needsDeepReview: boolean;
  suspectRoutes: string[];
  obviousBreakage: string[];
  /** True when the phash-vs-baseline short-circuit fired. */
  shortCircuited: boolean;
  summary: string;
}

const triageInstruction =
  "You are triaging a UI diff. Decide if a deep design review is warranted. " +
  'Respond with ONLY JSON: {"needsDeepReview": boolean, "suspectRoutes": string[], ' +
  '"obviousBreakage": string[]} where obviousBreakage lists overlap, unstyled HTML, ' +
  "broken images, or overflow you can see.";

/** Whether every route has a baseline and matches it within threshold (nothing changed visually). */
export function allUnchanged(routes: TriageRoute[], threshold: number): boolean {
  return (
    routes.length > 0 &&
    routes.every((r) => r.baselinePhash !== undefined && hashesWithin(r.baselinePhash, r.currentPhash, threshold))
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Run the triage pass, short-circuiting on a phash match against the baseline. */
export async function runTriage(deps: TriageDeps, routes: TriageRoute[]): Promise<TriageResult> {
  const threshold = deps.phashThreshold ?? 5;

  if (allUnchanged(routes, threshold)) {
    return {
      needsDeepReview: false,
      suspectRoutes: [],
      obviousBreakage: [],
      shortCircuited: true,
      summary: "No design changes detected (perceptual hash matches the baseline).",
    };
  }

  const deterministic = dedupe(routes.flatMap((r) => r.deterministicBreakage ?? []));
  const images = routes.flatMap((r) => r.aboveFoldImages);
  const response = await deps.client.complete(
    {
      model: deps.model,
      thinking: false,
      responseFormat: deps.structuredOutput === false ? undefined : "json_object",
      maxPixels: deps.maxPixels,
      messages: [
        { role: "system", content: triageInstruction },
        { role: "user", content: `Routes: ${routes.map((r) => r.route).join(", ")}`, images },
      ],
    },
    deps.signal ? { signal: deps.signal } : undefined,
  );

  let parsed: TriageOutput | null = null;
  try {
    parsed = TriageOutputSchema.parse(JSON.parse(response.text));
  } catch {
    parsed = null;
  }

  // Deterministic breakage (#19) always counts, even if the model missed it.
  const obviousBreakage = dedupe([...(parsed?.obviousBreakage ?? []), ...deterministic]);
  const needsDeepReview = parsed?.needsDeepReview ?? true; // fail open: review when unsure
  const suspectRoutes = parsed?.suspectRoutes ?? routes.map((r) => r.route);

  return {
    needsDeepReview: needsDeepReview || obviousBreakage.length > 0,
    suspectRoutes,
    obviousBreakage,
    shortCircuited: false,
    summary: needsDeepReview ? "Deep review warranted." : "Triage found no issues warranting a deep review.",
  };
}
