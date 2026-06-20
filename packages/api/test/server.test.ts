import { pgliteExecutor, runMigrations } from "@engine/db";
import { CancellationCoordinator, JobStore } from "@engine/jobs";
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

describe("DELETE /jobs/:id (cooperative cancel)", () => {
  it("flips to cancelling immediately, aborts via the coordinator, and writes no result", async () => {
    const killed: string[] = [];
    const coordinator = new CancellationCoordinator(async (id) => {
      killed.push(id);
    });
    api = createJobApi({ store, objectStore, secret: SECRET, coordinator });

    const post = await api.handle(signed("POST", "/jobs", "1", submission("k4")));
    const jobId = (post.body as { jobId: string }).jobId;
    coordinator.register(jobId);
    await store.claimNext(); // job is running

    const del = await api.handle(signed("DELETE", `/jobs/${jobId}`, "1"));
    expect(del.status).toBe(200);
    expect((del.body as { cancelling: boolean }).cancelling).toBe(true);

    // Consumer sees the intent immediately.
    const got = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    expect((got.body as { state: string }).state).toBe("cancelling");
    // Inference aborted + microVM kill invoked.
    expect(coordinator.isAborted(jobId)).toBe(true);
    expect(killed).toEqual([jobId]);

    // A late processJob writes NO result for a job that left `running`.
    await api.processJob(jobId);
    const afterProcess = await store.get(jobId);
    expect(afterProcess?.status).toBe("cancelling");
    expect(afterProcess?.resultPointer).toBeNull();

    // Worker finalizes -> canceled -> consumer sees terminal failed.
    await store.markCanceled(jobId);
    const final = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    expect((final.body as { state: string }).state).toBe("failed");
  });

  it("does not disclose another tenant's job on cancel", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k5")));
    const jobId = (post.body as { jobId: string }).jobId;
    expect((await api.handle(signed("DELETE", `/jobs/${jobId}`, "2"))).status).toBe(404);
  });
});

describe("hardening (gstack /review fixes)", () => {
  it("a succeeded job whose result artifact is gone returns failed, not completed+null", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k6")));
    const jobId = (post.body as { jobId: string }).jobId;
    await store.claimNext();
    // Mark succeeded with a pointer to an object that was never written (expired/missing).
    await store.complete(jobId, "jobs/missing/critique/result.json");

    const got = await api.handle(signed("GET", `/jobs/${jobId}`, "1"));
    const body = got.body as { state: string; error?: string; result?: unknown };
    expect(body.state).toBe("failed");
    expect(body.error).toBe("result_unavailable");
    expect(body.result).toBeUndefined(); // never completed+null
  });

  it("rejects a stale timestamp by default (replay protection on without config)", async () => {
    const body = JSON.stringify(submission("k7"));
    const stale = signEngineRequest({ body, installationId: "1", secret: SECRET, timestamp: Date.now() - 10 * 60_000 });
    const res = await api.handle({ method: "POST", path: "/jobs", headers: stale, body });
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toBe("timestamp_skew");
  });

  it("rejects a non-numeric timestamp instead of silently bypassing the skew check", async () => {
    const body = JSON.stringify(submission("k8"));
    const headers = signEngineRequest({ body, installationId: "1", secret: SECRET });
    headers["x-gate-timestamp"] = "not-a-number";
    const res = await api.handle({ method: "POST", path: "/jobs", headers, body });
    // signature was computed over the real ts, so swapping the header also breaks the sig;
    // either way it must NOT be accepted.
    expect(res.status).toBe(401);
  });
});
