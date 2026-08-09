import { describe, expect, it, vi } from "vitest";
import {
  createHttpChatCompletionsCreate,
  decodeSseStream,
  DashScopeModelClient,
  parseSseData,
  toHttpChatBody,
  type ChatCreateParams,
} from "../src/index.js";

/** Wrap SSE text in a byte stream, optionally split at arbitrary points. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const PARAMS: ChatCreateParams = {
  model: "qwen3-vl-plus",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
  enable_thinking: true,
  max_pixels: 1024,
};

describe("toHttpChatBody", () => {
  it("sends enable_thinking and max_pixels as top-level fields, not extra_body", () => {
    const body = toHttpChatBody(PARAMS);
    expect(body).toMatchObject({ model: "qwen3-vl-plus", enable_thinking: true, max_pixels: 1024 });
    expect(body).not.toHaveProperty("extra_body");
  });

  it("omits the optional fields entirely when unset", () => {
    const body = toHttpChatBody({ model: "m", messages: [], stream: true });
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body).not.toHaveProperty("max_pixels");
  });
});

describe("parseSseData", () => {
  it("returns null for the terminal sentinel and for non-JSON noise", () => {
    expect(parseSseData("[DONE]")).toBeNull();
    expect(parseSseData("   ")).toBeNull();
    expect(parseSseData("not json")).toBeNull();
  });

  it("parses a chat chunk", () => {
    expect(parseSseData('{"choices":[{"delta":{"content":"a"}}]}')).toEqual({
      choices: [{ delta: { content: "a" } }],
    });
  });
});

describe("decodeSseStream", () => {
  it("buffers across chunk boundaries that split an event in half", async () => {
    const stream = sseStream([
      'data: {"choices":[{"delta":{"content":"he',
      'llo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const texts: string[] = [];
    for await (const chunk of decodeSseStream(stream)) {
      texts.push(chunk.choices[0]?.delta.content ?? "");
    }
    expect(texts).toEqual(["hello", " world"]);
  });

  it("handles CRLF line endings and a final event with no trailing blank line", async () => {
    const stream = sseStream(['data: {"choices":[{"delta":{"content":"a"}}]}\r\n\r\n', 'data: {"choices":[{"delta":{"content":"b"}}]}']);
    const texts: string[] = [];
    for await (const chunk of decodeSseStream(stream)) texts.push(chunk.choices[0]?.delta.content ?? "");
    expect(texts).toEqual(["a", "b"]);
  });

  it("skips comment frames without aborting the stream", async () => {
    const stream = sseStream([': keep-alive\n\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\n']);
    const texts: string[] = [];
    for await (const chunk of decodeSseStream(stream)) texts.push(chunk.choices[0]?.delta.content ?? "");
    expect(texts).toEqual(["a"]);
  });
});

describe("createHttpChatCompletionsCreate", () => {
  it("posts to {baseUrl}/chat/completions with a bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response(sseStream(["data: [DONE]\n\n"]), { status: 200 }));
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://model.example/v1/",
      apiKey: "k-123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await create(PARAMS, {});

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://model.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k-123");
    expect(JSON.parse(init.body as string)).toMatchObject({ enable_thinking: true, max_pixels: 1024 });
  });

  it("surfaces the endpoint's own error body on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
    );
    const create = createHttpChatCompletionsCreate({
      baseUrl: "https://model.example/v1",
      apiKey: "bad",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(create(PARAMS, {})).rejects.toThrow(/returned 401.*invalid api key/s);
  });

  it("drives DashScopeModelClient end to end over a fake endpoint", async () => {
    const body = [
      'data: {"choices":[{"delta":{"reasoning_content":"thinking…"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"{\\"grade\\":"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\"ship\\"}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":7}}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = vi.fn(async () => new Response(sseStream(body), { status: 200 }));
    const client = new DashScopeModelClient(
      createHttpChatCompletionsCreate({
        baseUrl: "https://model.example/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      { resolveImageUrl: (image) => `https://cdn.example/${image.objectKey}` },
      "self-host",
    );

    const response = await client.complete({
      model: "qwen3-vl-plus",
      thinking: true,
      messages: [
        { role: "system", content: "rubric" },
        {
          role: "user",
          content: "review",
          images: [{ objectKey: "a.png", route: "/", viewport: "mobile" }],
        },
      ],
    });

    expect(response.text).toBe('{"grade":"ship"}');
    expect(response.thinkingText).toBe("thinking…");
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 3, cachedTokens: 7 });
    expect(response.finishReason).toBe("stop");

    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.messages[1].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "https://cdn.example/a.png" },
    });
  });
});
