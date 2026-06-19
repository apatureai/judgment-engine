import type {
  ModelBackend,
  ModelCallOptions,
  ModelClient,
  ModelImage,
  ModelMessage,
  ModelRequest,
  ModelResponse,
} from "./model.js";

/**
 * DashScope model client (TRD §6.1/§6.5, #27). Streams against the DashScope
 * OpenAI-compatible endpoint (the OpenAI SDK shape — never `@anthropic-ai/sdk`),
 * selects the Thinking checkpoint for the deep pass (reasoning on, temp ~0.6),
 * splits the reasoning stream (`reasoning_content`) from the answer, and threads
 * an AbortSignal into every call. The exact same client serves self-host
 * vLLM/SGLang by pointing the create fn at that endpoint (#76).
 *
 * The streaming `create` is injected so the client is unit-tested against a fake
 * stream — NEVER a live model. `createOpenAICompatibleCreate` adapts a real
 * OpenAI-SDK client in production.
 */

/** One streamed chunk in the OpenAI chat-completions shape. */
export interface ChatChunk {
  choices: Array<{
    delta: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

export interface ChatCreateParams {
  model: string;
  messages: unknown[];
  stream: true;
  stream_options?: { include_usage: boolean };
  temperature?: number;
  response_format?: { type: "json_object" };
  /** DashScope passes `enable_thinking` via extra_body on the OpenAI-compatible path. */
  enable_thinking?: boolean;
}

/** OpenAI-compatible streaming create (chat.completions.create with stream:true). */
export type ChatCompletionsCreate = (
  params: ChatCreateParams,
  options: { signal?: AbortSignal },
) => Promise<AsyncIterable<ChatChunk>>;

/** Resolve an object-storage key to a (signed) URL the model can fetch (#6). */
export type ImageUrlResolver = (image: ModelImage) => string;

export interface DashScopeOptions {
  /** Temperature for the Thinking/deep pass. */
  thinkingTemperature?: number;
  resolveImageUrl?: ImageUrlResolver;
}

function toOpenAIMessages(messages: ModelMessage[], resolveUrl: ImageUrlResolver): unknown[] {
  return messages.map((m) => {
    if (!m.images || m.images.length === 0) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        { type: "text", text: m.content },
        ...m.images.map((img) => ({ type: "image_url", image_url: { url: resolveUrl(img) } })),
      ],
    };
  });
}

export class DashScopeModelClient implements ModelClient {
  readonly backend: ModelBackend;
  private readonly resolveUrl: ImageUrlResolver;
  private readonly thinkingTemperature: number;

  constructor(
    private readonly create: ChatCompletionsCreate,
    options: DashScopeOptions = {},
    backend: ModelBackend = "dashscope",
  ) {
    this.backend = backend;
    this.resolveUrl = options.resolveImageUrl ?? ((img) => img.objectKey);
    this.thinkingTemperature = options.thinkingTemperature ?? 0.6;
  }

  async complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse> {
    // Thinking and json_object are mutually exclusive (#29 two-step); only set
    // json_object on the non-thinking coercion call.
    const wantsJson = request.responseFormat === "json_object" && !request.thinking;
    const stream = await this.create(
      {
        model: request.model,
        messages: toOpenAIMessages(request.messages, this.resolveUrl),
        stream: true,
        stream_options: { include_usage: true },
        temperature: request.thinking ? this.thinkingTemperature : undefined,
        enable_thinking: request.thinking,
        response_format: wantsJson ? { type: "json_object" } : undefined,
      },
      { signal: options?.signal },
    );

    let content = "";
    let thinking = "";
    let finishReason = "stop";
    let usage: ChatChunk["usage"];
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta.reasoning_content) thinking += choice.delta.reasoning_content;
      if (choice?.delta.content) content += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }

    return {
      text: content,
      thinkingText: thinking || undefined,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      finishReason,
    };
  }
}

/** Minimal OpenAI-SDK surface used in production (kept dependency-light + testable). */
export interface OpenAILikeClient {
  chat: {
    completions: {
      create(params: ChatCreateParams, options: { signal?: AbortSignal }): Promise<AsyncIterable<ChatChunk>>;
    };
  };
}

/**
 * Adapt a real OpenAI-SDK client (constructed with the DashScope `baseURL` +
 * api key, or a self-host vLLM URL) into the injectable create fn. DashScope's
 * `enable_thinking` rides in `extra_body`.
 */
export function createOpenAICompatibleCreate(client: OpenAILikeClient): ChatCompletionsCreate {
  return (params, options) => {
    const { enable_thinking, ...rest } = params;
    const body = { ...rest, ...(enable_thinking !== undefined ? { extra_body: { enable_thinking } } : {}) };
    return client.chat.completions.create(body as ChatCreateParams, options);
  };
}
