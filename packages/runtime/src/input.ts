import type { JobRecord } from "@engine/jobs";
import type { ReviewInput } from "@engine/review";
import type { PreviewBuildFact, Viewport } from "@engine/types";
import { z } from "zod";

const viewportSchema = z.enum(["mobile", "tablet", "desktop"]);
const buildFactSchema = z.object({
  kind: z.enum(["compile_error", "warning", "asset_error", "hydration", "deprecation"]),
  message: z.string(),
  source: z.string().optional(),
});

const normalizedConfigSchema = z.object({
  preview: z.object({
    source: z.enum(["vercel", "netlify", "cloudflare", "render", "explicit", "local"]),
    environment: z.string(),
    urlTemplate: z.string().nullable(),
    waitSeconds: z.number().int().nonnegative(),
    readySelector: z.string().nullable(),
    readyPath: z.string().nullable(),
    readyStatus: z.array(z.number().int()).nullable(),
    protectionBypassSecretName: z.string().nullable(),
    authStateSecretName: z.string().nullable(),
    forkPreview: z.boolean(),
  }),
  routes: z.object({
    always: z.array(z.string().min(1)),
    maxPerPr: z.number().int().positive(),
    map: z.record(z.string(), z.string()),
  }),
  viewports: z.array(viewportSchema).min(1),
  darkMode: z.boolean(),
  brand: z.string().nullable(),
  rules: z.object({
    gate: z.enum(["none", "nits", "blockers"]),
    minSeverityToComment: z.enum(["nit", "minor", "major", "blocker"]),
    suppress: z.array(z.string()),
  }),
  tokens: z.object({
    source: z.string().nullable(),
    values: z.record(z.string(), z.string()),
  }),
});

/** Gate's additive POST /jobs request contract. Unknown additive fields are ignored. */
export const runtimeReviewRequestSchema = z.object({
  installationId: z.string().min(1),
  repository: z.object({
    owner: z.string().min(1),
    name: z.string().min(1),
    defaultBranch: z.string().min(1),
  }),
  pullRequest: z.object({
    number: z.number().int().positive(),
    headSha: z.string().min(1),
    baseSha: z.string().min(1),
    title: z.string(),
    body: z.string().nullable(),
  }),
  preview: z.object({
    url: z.url().refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "preview URL must use http or https"),
    provider: z.enum(["vercel", "netlify", "cloudflare", "render", "explicit", "local"]),
    environment: z.string().nullable(),
  }),
  config: normalizedConfigSchema,
  publishMode: z.enum(["advisory", "blocking"]),
  depth: z.enum(["triage", "deep"]),
  previewBuildFacts: z.array(buildFactSchema).optional(),
});

export type RuntimeReviewRequest = z.infer<typeof runtimeReviewRequestSchema>;

export function repositoryForJob(job: JobRecord): string {
  const request = runtimeReviewRequestSchema.parse(job.input);
  return `${request.repository.owner}/${request.repository.name}`;
}

/** The route cap applied to one request: what was asked, what runs, what was dropped. */
export interface CappedRoutes {
  /** Every configured route, in order, before the cap. The ask. */
  requested: string[];
  /** The routes this run will actually capture. */
  routes: string[];
  /** The dropped tail, empty when nothing was dropped. */
  truncated: string[];
}

/**
 * Apply `routes.max_per_pr`, and keep the tail it drops.
 *
 * The cap itself is deliberate: it is the per-PR cost ceiling. What was not
 * deliberate is that the dropped routes disappeared. `routes.always.slice(0,
 * maxPerPr)` was the whole implementation, so with the default `max_per_pr: 5`
 * and eight configured routes, three were not captured, not in `notReviewed`,
 * not in coverage, and not in the comment: the review reported on five routes
 * and read as though five were all you had asked for.
 *
 * The empty-config fallback to `["/"]` is unchanged and is NOT truncation: no
 * route was configured, so none was dropped, and the ask is the default too.
 */
export function capRoutes(config: { always: string[]; maxPerPr: number }): CappedRoutes {
  const configured = config.always;
  if (configured.length === 0) return { requested: ["/"], routes: ["/"], truncated: [] };
  return {
    requested: [...configured],
    routes: configured.slice(0, config.maxPerPr),
    truncated: configured.slice(config.maxPerPr),
  };
}

/**
 * Why a route the config asked for was never looked at, in the same
 * "<what> (<why>)" shape the rest of `notReviewed` uses.
 *
 * It names the setting, not just the number, because the reader's next question
 * is where to change it: `max_per_pr` under `routes` in `.gate.yml`.
 */
export function truncatedRouteReason(route: string, maxPerPr: number): string {
  return `route ${route} (over the routes.max_per_pr limit of ${maxPerPr})`;
}

/**
 * Parse Gate's durable request into the real orchestrator input. Tenant and
 * depth are verified against the HMAC-scoped durable job instead of trusted
 * from the caller-controlled JSON. The current Gate contract does not carry a
 * trustworthy fork bit, so production capture fails closed to fork-safe mode:
 * no storage-state or protection-bypass secret is released to the sandbox.
 */
export function toReviewInput(job: JobRecord): ReviewInput {
  const request = runtimeReviewRequestSchema.parse(job.input);
  if (request.installationId !== job.installationId) {
    throw new Error("request installation does not match the verified job tenant");
  }
  if (request.depth !== job.depth) {
    throw new Error("request depth does not match the durable job depth");
  }

  const { requested, routes, truncated } = capRoutes(request.config.routes);
  const brand = request.config.brand === null
    ? null
    : { description: request.config.brand, tone: null, audience: null, do: [], dont: [] };

  return {
    url: request.preview.url,
    depth: job.depth,
    context: {
      tokens: request.config.tokens.values,
      brand,
      componentLibraries: [],
      // The production resolver stamps the latest approved repository genome.
      uiDnaVersion: null,
      routes,
    },
    captureContext: {
      installationId: job.installationId,
      viewports: request.config.viewports as Viewport[],
      darkMode: request.config.darkMode,
      isFork: true,
      routes,
    },
    // Bare here on purpose, and NOT left bare. The per-route measurements that
    // ground the deep prompt (`facts`) and overrule a triage decline
    // (`deterministicBreakage`) are computed DURING capture, and capture has not
    // run yet at this point: this function only reads the durable job. The
    // composition root captures, then rebuilds these routes from what the
    // capture measured (`applyMeasuredRoutes` in `measurement.ts`). Any other
    // caller of `toReviewInput` that skips that step reviews unfacted pages.
    routes: routes.map((route) => ({ route })),
    // The ask is the configured list, not the capped one, so coverage reports a
    // truncated run as the partial review it is instead of "5 of 5 reviewed".
    requestedRoutes: requested,
    // And the reason each dropped route was dropped, named individually, because
    // "3 routes skipped" does not tell anyone which three.
    ...(truncated.length > 0
      ? {
          notReviewed: truncated.map((route) =>
            truncatedRouteReason(route, request.config.routes.maxPerPr),
          ),
        }
      : {}),
    ...(request.previewBuildFacts !== undefined
      ? { previewBuildFacts: request.previewBuildFacts as PreviewBuildFact[] }
      : {}),
    // No `screenshotIdFor` and no `artifactUrlFor`, which is a KNOWN divergence
    // from the local pipeline and is left visible rather than approximated. The
    // wire projection resolves both from the captured-image set and the object
    // store's signed-URL base; without them every finding this service publishes
    // carries `screenshotId: null` and `artifacts.annotatedScreenshots` is empty,
    // whatever was captured. Binding them means deciding a delivery policy this
    // composition does not have: `screenshotRetentionSeconds: 0` currently tells
    // consumers the screenshots are not retained, and a signed URL has a TTL that
    // has to agree with that number. Inventing either would be publishing a
    // retention promise nothing implements.
    wireOptions: { screenshotRetentionSeconds: 0 },
  };
}
