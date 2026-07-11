import type { GenomeRule, Embedder } from "@engine/context";
import {
  createOpenAICompatibleCreate,
  DashScopeModelClient,
  type ModelClientFactory,
  type OpenAILikeClient,
} from "@engine/critique";
import type { ObjectStore } from "@engine/storage";
import type { Capture, CaptureContext, CaptureInSandbox } from "@engine/types";
import OpenAI from "openai";
import { z } from "zod";

const captureSchema = z.object({
  images: z.array(z.object({
    route: z.string(),
    viewport: z.enum(["mobile", "tablet", "desktop"]),
    objectKey: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict()),
  geometry: z.array(z.object({
    route: z.string(),
    viewport: z.enum(["mobile", "tablet", "desktop"]),
    selector: z.string(),
    role: z.string().nullable(),
    rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict(),
  }).strict()),
  pageHealth: z.object({
    consoleErrors: z.number().int().nonnegative(),
    failedRequests: z.number().int().nonnegative(),
    unstable: z.boolean(),
    blockedFonts: z.number().int().nonnegative().optional(),
  }).strict(),
  captureVersion: z.string().min(1),
}).strict();

const genomeSchema = z.object({
  snapshot: z.object({
    id: z.string().min(1),
    approval_state: z.enum(["approved", "superseded"]),
  }),
  items: z.array(z.object({
    field_id: z.string().min(1),
    kind: z.string().min(1),
    value: z.record(z.string(), z.unknown()),
    applicability: z.object({
      component_kinds: z.array(z.string()).optional(),
    }).passthrough(),
  }).passthrough()),
}).passthrough();

export interface CaptureClient {
  forJob(jobId: string, signal: AbortSignal): CaptureInSandbox;
  cancel(jobId: string): Promise<void>;
  ready(): Promise<boolean>;
}

/** Remote binding to the isolated capture fleet owned by Judgment Engine. */
export class HttpCaptureClient implements CaptureClient {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  forJob(jobId: string, signal: AbortSignal): CaptureInSandbox {
    return async (url: string, context: CaptureContext): Promise<Capture> => {
      const response = await this.fetchImpl(new URL("/v1/captures", this.endpoint), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-engine-job-id": jobId,
        },
        body: JSON.stringify({ jobId, url, context }),
        signal,
      });
      if (!response.ok) throw new Error(`capture service returned ${response.status}`);
      return captureSchema.parse(await response.json());
    };
  }

  async cancel(jobId: string): Promise<void> {
    const response = await this.fetchImpl(new URL(`/v1/captures/${encodeURIComponent(jobId)}`, this.endpoint), {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`capture cancellation returned ${response.status}`);
    }
  }

  async ready(): Promise<boolean> {
    const response = await this.fetchImpl(new URL("/readyz", this.endpoint), {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  }
}

export interface GenomeResolver {
  resolve(repository: string, installationId: string): Promise<{
    version: string;
    rules: GenomeRule[];
  } | null>;
}

/** Tenant-scoped read adapter for Source of Truth's approved UI-DNA bundle. */
export class HttpGenomeResolver implements GenomeResolver {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolve(repository: string, installationId: string): Promise<{
    version: string;
    rules: GenomeRule[];
  } | null> {
    const url = new URL(`/v1/repos/${encodeURIComponent(repository)}/ui-dna`, this.endpoint);
    url.searchParams.set("max_items", "100");
    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${this.token}`,
        "x-apature-installation-id": installationId,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`genome service returned ${response.status}`);
    const parsed = genomeSchema.parse(await response.json());
    return {
      version: parsed.snapshot.id,
      rules: parsed.items.map((item) => ({
        id: item.field_id,
        text: JSON.stringify({ kind: item.kind, value: item.value }),
        ...(item.applicability.component_kinds?.[0]
          ? { component: item.applicability.component_kinds[0] }
          : {}),
      })),
    };
  }
}

export interface OpenAIAdapterOptions {
  apiKey: string;
  baseURL: string;
  embeddingModel?: string;
  objectStore: ObjectStore;
  signedImageTtlSeconds?: number;
}

/** Bind DashScope/self-host OpenAI-compatible model and embedding clients. */
export function createOpenAIAdapters(options: OpenAIAdapterOptions): {
  modelFactory: ModelClientFactory;
  embedder?: Embedder;
} {
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
  const create = createOpenAICompatibleCreate(client as unknown as OpenAILikeClient);
  const ttl = options.signedImageTtlSeconds ?? 900;
  const modelFactory: ModelClientFactory = (config) => new DashScopeModelClient(
    create,
    { resolveImageUrl: (image) => options.objectStore.signedGetUrl(image.objectKey, ttl) },
    config.backend,
  );
  const embedder: Embedder | undefined = options.embeddingModel
    ? async (texts) => {
        const response = await client.embeddings.create({
          model: options.embeddingModel as string,
          input: [...texts],
          encoding_format: "float",
        });
        return response.data.map((row) => row.embedding);
      }
    : undefined;
  return { modelFactory, ...(embedder ? { embedder } : {}) };
}
