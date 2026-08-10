import type {
  ModelBackend,
  ModelCallOptions,
  ModelClient,
  ModelRequest,
  ModelResponse,
} from "./model.js";

/**
 * Deterministic in-memory model client. It is the default stand-in until the
 * real DashScope adapter (#27) and self-host vLLM client (#76) are wired, and
 * the client used in all tests. NEVER call a real model in tests. It echoes the
 * requested model so the per-pass routing is observable, and returns an empty
 * findings JSON so the pipeline parses end to end.
 */
export class MockModelClient implements ModelClient {
  readonly backend: ModelBackend;
  /** Records every request for assertions. */
  readonly calls: ModelRequest[] = [];

  constructor(backend: ModelBackend = "mock") {
    this.backend = backend;
  }

  async complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse> {
    if (options?.signal?.aborted) throw new Error("aborted");
    this.calls.push(request);
    const body = JSON.stringify({ grade: "ship", overall: `mock(${request.model})`, findings: [] });
    return {
      text: request.responseFormat === "json_object" ? body : `mock critique from ${request.model}`,
      thinkingText: request.thinking ? `mock thinking for ${request.model}` : undefined,
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      finishReason: "stop",
    };
  }
}

/**
 * Default factory. Every backend currently maps to a `MockModelClient` (the EM0
 * stand-in) tagged with the requested backend, so `critique()` runs in CI/scaffold
 * without live infra; #27 replaces the dashscope/self-host branches with real
 * clients without changing any call site.
 */
export const defaultModelFactory = (config: { backend: ModelBackend }): ModelClient =>
  new MockModelClient(config.backend);
