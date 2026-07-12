import { signEngineRequest } from "@engine/api";
import { defaultModelFactory } from "@engine/critique";
import { pgliteExecutor, runMigrations } from "@engine/db";
import { JobStore, type JobRecord } from "@engine/jobs";
import { InMemoryObjectStore } from "@engine/storage";
import type { Capture, CaptureContext, CaptureInSandbox } from "@engine/types";
import { PGlite } from "@electric-sql/pglite";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngineRuntime,
  EngineWorker,
  HttpGenomeResolver,
  runtimeReviewRequestSchema,
  toReviewInput,
  type CaptureClient,
  type EngineRuntime,
  type NotificationSource,
} from "../src/index.js";

const SECRET = "runtime-hmac-secret";
const VIEWPORT = "desktop" as const;
const drill = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/genome-lifecycle-drill.golden.json", import.meta.url)), "utf8"),
) as {
  sourceOfTruth: { snapshotId: string; itemIds: string[] };
  judgmentEngine: { uiDnaVersion: string; ruleCount: number; groundingObserved: boolean };
};

function reviewRequest() {
  return {
    installationId: "verified-installation",
    repository: { owner: "apatureai", name: "demo", defaultBranch: "main" },
    pullRequest: {
      number: 42,
      headSha: "head-sha",
      baseSha: "base-sha",
      title: "Demo PR",
      body: null,
    },
    preview: { url: "https://preview.example.test", provider: "vercel" as const, environment: "Preview" },
    config: {
      preview: {
        source: "vercel" as const,
        environment: "Preview",
        urlTemplate: null,
        waitSeconds: 0,
        readySelector: null,
        readyPath: null,
        readyStatus: null,
        protectionBypassSecretName: null,
        authStateSecretName: null,
        forkPreview: false,
      },
      routes: { always: ["/"], maxPerPr: 5, map: {} },
      viewports: [VIEWPORT],
      darkMode: false,
      brand: null,
      rules: { gate: "none" as const, minSeverityToComment: "nit" as const, suppress: [] },
      tokens: { source: null, values: {} },
    },
    publishMode: "advisory" as const,
    depth: "deep" as const,
  };
}

function captureClient(): CaptureClient {
  const capture: Capture = {
    images: [{ route: "/", viewport: VIEWPORT, objectKey: "jobs/test/capture/home.png", width: 1280, height: 720 }],
    geometry: [],
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
    captureVersion: "capture-http@1",
  };
  return {
    forJob: (_jobId: string, signal: AbortSignal): CaptureInSandbox =>
      async (_url: string, _ctx: CaptureContext) => {
        if (signal.aborted) throw new Error("aborted");
        return capture;
      },
    cancel: async () => undefined,
    ready: async () => true,
  };
}

function job(input: unknown = reviewRequest()): JobRecord {
  const now = new Date();
  return {
    id: "job_1",
    consumer: "gate",
    installationId: "verified-installation",
    intentType: "pr_review",
    idempotencyKey: "gate:verified-installation:pr_review:one",
    depth: "deep",
    status: "running",
    input,
    priority: 0,
    resultPointer: null,
    error: null,
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  };
}

describe("runtime request binding", () => {
  it("loads the built production graph under native Node ESM resolution", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "await import('./packages/runtime/dist/index.js')"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("derives tenant scope and depth from the verified durable job", () => {
    const input = toReviewInput(job());
    expect(input.captureContext.installationId).toBe("verified-installation");
    expect(input.depth).toBe("deep");
    expect(input.captureContext.routes).toEqual(["/"]);
    expect(input.url).toBe("https://preview.example.test");
    expect(input.captureContext.isFork).toBe(true);
  });

  it("rejects caller-controlled tenant/depth mismatches but accepts additive fields", () => {
    expect(() => toReviewInput(job({ ...reviewRequest(), installationId: "attacker" }))).toThrow(/tenant/);
    expect(() => toReviewInput(job({ ...reviewRequest(), depth: "triage" }))).toThrow(/depth/);
    expect(runtimeReviewRequestSchema.parse({ ...reviewRequest(), additiveFutureField: true })).toBeDefined();
  });
});

describe("approved genome adapter", () => {
  it("reads Source of Truth by repository and maps the approved snapshot to rules", async () => {
    let requestedUrl = "";
    let requestedInstallation = "";
    const resolver = new HttpGenomeResolver(
      "https://source.apature.test",
      "service-token",
      async (input, init) => {
        requestedUrl = String(input);
        requestedInstallation = new Headers(init?.headers).get("x-apature-installation-id") ?? "";
        return new Response(JSON.stringify({
          snapshot: { id: drill.sourceOfTruth.snapshotId, approval_state: "approved" },
          items: [{
            field_id: drill.sourceOfTruth.itemIds[0],
            kind: "token",
            value: { token: "--color-brand", value: "#0a0a0a", group: "color" },
            applicability: {},
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    );

    await expect(resolver.resolve("apatureai/demo", "tenant_1")).resolves.toEqual({
      version: drill.judgmentEngine.uiDnaVersion,
      rules: [{
        id: drill.sourceOfTruth.itemIds[0],
        text: JSON.stringify({
          kind: "token",
          value: { token: "--color-brand", value: "#0a0a0a", group: "color" },
        }),
      }],
    });
    expect(requestedUrl).toBe("https://source.apature.test/v1/repos/apatureai%2Fdemo/ui-dna?max_items=100");
    expect(requestedInstallation).toBe("tenant_1");
  });

  it("treats an absent approved snapshot as no genome", async () => {
    const resolver = new HttpGenomeResolver(
      "https://source.apature.test",
      "service-token",
      async () => new Response(null, { status: 404 }),
    );
    await expect(resolver.resolve("apatureai/demo", "tenant_1")).resolves.toBeNull();
  });
});

describe("EngineWorker", () => {
  it("retries a failed attempt, succeeds on the next claim, and drains", async () => {
    const queued = [job(), { ...job(), attempts: 2 }];
    const states: Array<string | null> = [];
    let calls = 0;
    const worker = new EngineWorker({
      store: {
        claimNext: async () => queued.shift() ?? null,
        retryOrFail: async () => {
          states.push("queued");
          return "queued";
        },
      },
      processJob: async () => {
        calls++;
        if (calls === 1) throw new Error("transient");
      },
      maxAttempts: 3,
    });
    await worker.drainOnce();
    expect(calls).toBe(2);
    expect(states).toEqual(["queued"]);
  });

  it("closes the LISTEN source during graceful shutdown", async () => {
    let closed = false;
    let notify: (() => void) | undefined;
    const source: NotificationSource = {
      start: async (handler) => { notify = handler; },
      close: async () => { closed = true; },
    };
    const worker = new EngineWorker({
      store: { claimNext: async () => null, retryOrFail: async () => null },
      processJob: async () => undefined,
      notificationSource: source,
      pollIntervalMs: 50,
    });
    await worker.start();
    notify?.();
    await worker.stop();
    expect(closed).toBe(true);
    expect(worker.isReady()).toBe(false);
  });
});

describe("production composition integration", () => {
  let runtime: EngineRuntime | undefined;
  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  it("runs submit -> poll/claim -> real orchestrator -> stored wire result", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const store = new JobStore(pgliteExecutor(db));
    let resolvedGenome = false;
    runtime = createEngineRuntime({
      store,
      objectStore: new InMemoryObjectStore(),
      engineHmacSecret: SECRET,
      capture: captureClient(),
      modelFactory: defaultModelFactory,
      genomeResolver: {
        resolve: async (repository, installationId) => {
          resolvedGenome = repository === "apatureai/demo" && installationId === "tenant_1";
          return {
            version: "dna@1",
            rules: [{ id: "rule-1", text: "Use the approved spacing scale." }],
          };
        },
      },
      embedder: async (texts) => texts.map(() => [1, 0]),
      databaseReady: async () => true,
      workerPollMs: 5,
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const request = reviewRequest();
    request.installationId = "tenant_1";
    const submitBody = JSON.stringify({ idempotencyKey: "repo#42@sha", depth: "deep", request });
    const submit = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: signEngineRequest({ body: submitBody, installationId: "tenant_1", secret: SECRET }),
      body: submitBody,
    });
    expect(submit.status).toBe(202);
    const { jobId } = await submit.json() as { jobId: string };

    let final: { state: string; result?: { metadata: { promptVersion: string; captureVersion: string; uiDnaVersion: string | null } } } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const headers = signEngineRequest({ body: "", installationId: "tenant_1", secret: SECRET });
      const response = await fetch(`${base}/jobs/${jobId}`, { headers });
      final = await response.json() as typeof final;
      if (final?.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(final?.state).toBe("completed");
    expect(final?.result?.metadata.captureVersion).toBe("capture-http@1");
    expect(final?.result?.metadata.promptVersion).not.toBe("stub@0");
    expect(final?.result?.metadata.uiDnaVersion).toBe("dna@1");
    expect(resolvedGenome).toBe(true);

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "ready",
      components: { database: true, capture: true, worker: true },
    });
  });

  it("reports capture capacity separately from liveness", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const store = new JobStore(pgliteExecutor(db));
    const capture = captureClient();
    capture.ready = async () => false;
    runtime = createEngineRuntime({
      store,
      objectStore: new InMemoryObjectStore(),
      engineHmacSecret: SECRET,
      capture,
      modelFactory: defaultModelFactory,
      databaseReady: async () => true,
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/livez`)).status).toBe(200);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ components: { database: true, capture: false, worker: true } });
  });

  it("aborts capture, finalizes cancellation, and never publishes a result", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const store = new JobStore(pgliteExecutor(db));
    const objectStore = new InMemoryObjectStore();
    let killed = false;
    const capture: CaptureClient = {
      forJob: (_jobId, signal) => async () => new Promise<Capture>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
      cancel: async () => { killed = true; },
      ready: async () => true,
    };
    runtime = createEngineRuntime({
      store,
      objectStore,
      engineHmacSecret: SECRET,
      capture,
      modelFactory: defaultModelFactory,
      databaseReady: async () => true,
      workerPollMs: 5,
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const request = reviewRequest();
    request.installationId = "tenant_1";
    const submitBody = JSON.stringify({ idempotencyKey: "cancel-me", depth: "deep", request });
    const submit = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: signEngineRequest({ body: submitBody, installationId: "tenant_1", secret: SECRET }),
      body: submitBody,
    });
    const { jobId } = await submit.json() as { jobId: string };

    for (let attempt = 0; attempt < 100 && (await store.get(jobId))?.status !== "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const cancelHeaders = signEngineRequest({ body: "", installationId: "tenant_1", secret: SECRET });
    const cancel = await fetch(`${base}/jobs/${jobId}`, { method: "DELETE", headers: cancelHeaders });
    expect(cancel.status).toBe(200);

    for (let attempt = 0; attempt < 100 && (await store.get(jobId))?.status !== "canceled"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const record = await store.get(jobId);
    expect(record?.status).toBe("canceled");
    expect(record?.resultPointer).toBeNull();
    expect(killed).toBe(true);
    expect(await objectStore.get(`jobs/${jobId}/critique/result.json`)).toBeNull();
  });
});
