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

  const configuredRoutes = request.config.routes.always.slice(0, request.config.routes.maxPerPr);
  const routes = configuredRoutes.length > 0 ? configuredRoutes : ["/"];
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
    routes: routes.map((route) => ({ route })),
    ...(request.previewBuildFacts !== undefined
      ? { previewBuildFacts: request.previewBuildFacts as PreviewBuildFact[] }
      : {}),
    wireOptions: { screenshotRetentionSeconds: 0 },
  };
}
