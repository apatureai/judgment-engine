import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiRequest, ApiResponse } from "@engine/api";

export interface ReadinessChecks {
  database(): Promise<boolean>;
  capture(): Promise<boolean>;
  worker(): boolean;
}

export interface EngineHttpServerOptions {
  handle(request: ApiRequest): Promise<ApiResponse>;
  readiness: ReadinessChecks;
  maxBodyBytes?: number;
}

function writeJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error("body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function headersOf(request: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return headers;
}

export class EngineHttpServer {
  private readonly server: Server;
  private readonly maxBodyBytes: number;

  constructor(private readonly options: EngineHttpServerOptions) {
    this.maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    this.server = createServer((request, response) => {
      void this.route(request, response);
    });
  }

  async listen(port: number, host = "0.0.0.0"): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://engine.local").pathname;
    if (request.method === "GET" && path === "/livez") {
      writeJson(response, 200, { status: "live" });
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      const [database, capture] = await Promise.all([
        this.options.readiness.database().catch(() => false),
        this.options.readiness.capture().catch(() => false),
      ]);
      const worker = this.options.readiness.worker();
      const ready = database && capture && worker;
      writeJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready", components: { database, capture, worker } });
      return;
    }
    try {
      const body = await readBody(request, this.maxBodyBytes);
      const result = await this.options.handle({
        method: request.method ?? "GET",
        path,
        headers: headersOf(request),
        body,
      });
      writeJson(response, result.status, result.body, result.headers);
    } catch (error) {
      if (error instanceof Error && error.message === "body_too_large") {
        writeJson(response, 413, { error: "body_too_large" });
        return;
      }
      writeJson(response, 500, { error: "internal_error" });
    }
  }
}
