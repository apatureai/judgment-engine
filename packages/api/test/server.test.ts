import { pgliteExecutor, runMigrations } from "@engine/db";
import { JobStore } from "@engine/jobs";
import { InMemoryObjectStore } from "@engine/storage";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { createJobApi, signEngineRequest, type ApiRequest } from "../src/index.js";

const SECRET = "engine-hmac-secret";
let db: PGlite;
let store: JobStore;
let objectStore: InMemoryObjectStore;
let api: ReturnType<typeof createJobApi>;

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  store = new JobStore(pgliteExecutor(db));
  objectStore = new InMemoryObjectStore();
  api = createJobApi({ store, objectStore, secret: SECRET });
});

function signed(
  method: string,
  path: string,
  installationId: string,
  bodyObj?: unknown,
): ApiRequest {
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
  const headers = signEngineRequest({ body, installationId, secret: SECRET });
  return { method, path, headers, body };
}

const submission = (idempotencyKey: string, depth: "triage" | "deep" = "deep") => ({
  idempotencyKey,
  depth,
  request: { prNumber: 42 },
});

describe("POST /jobs", () => {
  it("enqueues a signed job (202) and dedups a duplicate key (409)", async () => {
    const first = await api.handle(signed("POST", "/jobs", "1", submission("pr-42-sha")));
    expect(first.status).toBe(202);
    const jobId = (first.body as { jobId: string }).jobId;

    const dup = await api.handle(signed("POST", "/jobs", "1", submission("pr-42-sha")));
    expect(dup.status).toBe(409);
    expect((dup.body as { jobId: string }).jobId).toBe(jobId);
  });

  it("rejects an unsigned request and a tampered signature", async () => {
    const unsigned: ApiRequest = {
      method: "POST",
      path: "/jobs",
      headers: {},
      body: JSON.stringify(submission("x")),
    };
    expect((await api.handle(unsigned)).status).toBe(401);

    const tampered = signed("POST", "/jobs", "1", submission("x"));
    tampered.headers["x-gate-signature"] = "sha256=deadbeef";
    expect((await api.handle(tampered)).status).toBe(401);
  });

  it("rejects a body whose installationId was swapped after signing", async () => {
    // Signed for installation 1, replayed claiming installation 2.
    const req = signed("POST", "/jobs", "1", submission("x"));
    req.headers["x-gate-installation"] = "2";
    expect((await api.handle(req)).status).toBe(401);
  });
});

describe("GET /jobs/:id", () => {
  it("reports pending then completed with x-schema-version + version metadata", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k1", "deep")));
    const jobId = (post.body as { jobId: string }).jobId;

    const pending = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    expect((pending.body as { state: string }).state).toBe("pending");

    // Worker claims + processes.
    await store.claimNext();
    await api.processJob(jobId);

    const done = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    expect(done.headers["x-schema-version"]).toBe("1");
    const body = done.body as { state: string; result: { metadata: { model: string } } };
    expect(body.state).toBe("completed");
    // depth=deep routes to the deep model.
    expect(body.result.metadata.model).toBe("qwen3-vl-plus");
  });

  it("routes triage depth to the fast model", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k2", "triage")));
    const jobId = (post.body as { jobId: string }).jobId;
    await store.claimNext();
    await api.processJob(jobId);

    const done = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    const body = done.body as { result: { metadata: { model: string } } };
    expect(body.result.metadata.model).toBe("qwen3-vl-flash");
  });

  it("does not disclose another tenant's job (404)", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k3")));
    const jobId = (post.body as { jobId: string }).jobId;

    // Installation 2 asks for installation 1's job.
    const res = await api.handle(signed("GET", `/jobs/${jobId}`, "2"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /jobs/:id", () => {
  it("cancels a job for its owning tenant", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k4")));
    const jobId = (post.body as { jobId: string }).jobId;

    const del = await api.handle(signed("DELETE", `/jobs/${jobId}`, "1"));
    expect(del.status).toBe(200);
    expect((del.body as { canceled: boolean }).canceled).toBe(true);

    const got = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    expect((got.body as { state: string }).state).toBe("failed"); // canceled -> failed state
  });
});
