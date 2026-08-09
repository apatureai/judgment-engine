import { DashScopeModelClient, type ImageUrlResolver } from "./dashscope.js";
import { createHttpChatCompletionsCreate } from "./http-model.js";
import { defaultModelFactory } from "./mock-model.js";
import type { ModelClientFactory } from "./registry.js";

/**
 * Which model client a process is actually running (#27). The engine has always
 * had two: the deterministic in-memory `MockModelClient` and the real
 * OpenAI-compatible client. Choosing between them from configuration is easy to
 * get silently wrong — a run against the mock produces a well-formed, entirely
 * empty review that looks like a clean bill of health. So the choice is resolved
 * ONCE, here, and returned alongside a human-readable `description` that every
 * entry point is expected to print before it reviews anything.
 */

/** Environment variables this resolver reads. */
export interface ModelEnv {
  /** API key for the OpenAI-compatible endpoint. Absent/blank ⇒ mock. */
  MODEL_API_KEY?: string | undefined;
  /** OpenAI-compatible base URL, e.g. `https://host/compatible-mode/v1`. */
  MODEL_BASE_URL?: string | undefined;
}

export type ModelRuntimeMode = "mock" | "live";

export interface ModelRuntime {
  mode: ModelRuntimeMode;
  /** One line naming the active client, for the startup banner. */
  description: string;
  factory: ModelClientFactory;
  /** Endpoint the live client posts to; absent in mock mode. */
  baseUrl?: string;
}

export interface ModelRuntimeOptions {
  /**
   * Resolve a captured image's object key to a URL the model can fetch — a
   * signed object-store URL in production, a `data:` URI for local runs. Required
   * for the live path to send images; defaults to passing the object key through.
   */
  resolveImageUrl?: ImageUrlResolver;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Extra headers for the endpoint (gateway/tenant routing). */
  headers?: Record<string, string>;
}

/** Thrown when a live model was requested but the configuration is incomplete. */
export class ModelConfigError extends Error {}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Resolve the model client from environment configuration.
 *
 * - No `MODEL_API_KEY` ⇒ the mock client. Reviews complete, cost nothing, touch
 *   no network, and contain no model findings. This is the default on purpose:
 *   an unconfigured process must never silently attempt to spend money.
 * - `MODEL_API_KEY` set ⇒ the real streaming OpenAI-compatible client.
 *   `MODEL_BASE_URL` is then required and is NOT defaulted: guessing a vendor
 *   endpoint for someone's key is how a key ends up posted to the wrong host.
 */
export function resolveModelRuntime(env: ModelEnv, options: ModelRuntimeOptions = {}): ModelRuntime {
  if (blank(env.MODEL_API_KEY)) {
    return {
      mode: "mock",
      description:
        "MOCK model client — MODEL_API_KEY is not set. No network call is made and no model findings are produced.",
      factory: defaultModelFactory,
    };
  }
  if (blank(env.MODEL_BASE_URL)) {
    throw new ModelConfigError(
      "MODEL_API_KEY is set but MODEL_BASE_URL is not. Set MODEL_BASE_URL to your OpenAI-compatible endpoint (it is never guessed), or unset MODEL_API_KEY to run against the mock client.",
    );
  }
  const baseUrl = (env.MODEL_BASE_URL as string).trim();
  const create = createHttpChatCompletionsCreate({
    baseUrl,
    apiKey: (env.MODEL_API_KEY as string).trim(),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
  });
  return {
    mode: "live",
    description: `LIVE model client — streaming against ${baseUrl}. Calls are billed to the owner of MODEL_API_KEY.`,
    baseUrl,
    factory: (config) =>
      new DashScopeModelClient(
        create,
        options.resolveImageUrl ? { resolveImageUrl: options.resolveImageUrl } : {},
        config.backend,
      ),
  };
}
