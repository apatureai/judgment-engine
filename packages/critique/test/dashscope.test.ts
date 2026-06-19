import { describe, expect, it } from "vitest";
import {
  DashScopeModelClient,
  type ChatChunk,
  type ChatCreateParams,
  type ModelRequest,
} from "../src/index.js";

function fakeStream(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

const deepRequest: ModelRequest = {
  model: "qwen3-vl-plus",
  thinking: true,
  responseFormat: "json_object",
  messages: [
    { role: "system", content: "review" },
    { role: "user", content: "ctx", images: [{ objectKey: "jobs/1/s/a.png", route: "/", viewport: "desktop" }] },
  ],
};

describe("DashScopeModelClient (#27)", () => {
  it("streams, splits reasoning from content, and reports cached tokens", async () => {
    let seen: ChatCreateParams | undefined;
    const create = async (params: ChatCreateParams) => {
      seen = params;
      return fakeStream([
        { choices: [{ delta: { reasoning_content: "thinking..." } }] },
        { choices: [{ delta: { content: '{"grade":' } }] },
        { choices: [{ delta: { content: '"ship"}' }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } } },
      ]);
    };
    const client = new DashScopeModelClient(create);
    const res = await client.complete(deepRequest);

    expect(res.text).toBe('{"grade":"ship"}');
    expect(res.thinkingText).toBe("thinking...");
    expect(res.finishReason).toBe("stop");
    expect(res.usage.cachedTokens).toBe(80);

    // Deep pass: streaming on, reasoning on, temp ~0.6; multimodal message built.
    expect(seen?.stream).toBe(true);
    expect(seen?.enable_thinking).toBe(true);
    expect(seen?.temperature).toBe(0.6);
    // Thinking ⊥ json_object: no response_format on the thinking call.
    expect(seen?.response_format).toBeUndefined();
    const userMsg = (seen?.messages[1] ?? {}) as { content: Array<{ type: string; image_url?: { url: string } }> };
    expect(userMsg.content.some((p) => p.type === "image_url")).toBe(true);
  });

  it("sets json_object only on a non-thinking (coercion) call", async () => {
    let seen: ChatCreateParams | undefined;
    const create = async (params: ChatCreateParams) => {
      seen = params;
      return fakeStream([{ choices: [{ delta: { content: "{}" }, finish_reason: "stop" }] }]);
    };
    const client = new DashScopeModelClient(create);
    await client.complete({ ...deepRequest, thinking: false });
    expect(seen?.response_format).toEqual({ type: "json_object" });
    expect(seen?.enable_thinking).toBe(false);
    expect(seen?.temperature).toBeUndefined();
  });

  it("threads the AbortSignal into the stream call", async () => {
    let seenSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const create = async (_params: ChatCreateParams, options: { signal?: AbortSignal }) => {
      seenSignal = options.signal;
      return fakeStream([{ choices: [{ delta: { content: "{}" }, finish_reason: "stop" }] }]);
    };
    const client = new DashScopeModelClient(create);
    await client.complete({ ...deepRequest, thinking: false }, { signal: controller.signal });
    expect(seenSignal).toBe(controller.signal);
  });
});
