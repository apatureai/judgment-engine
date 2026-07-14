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

it("refuses to start a production API with the EM0 stub processor", () => {
  expect(() => createJobApi({ store, objectStore, secret: SECRET, production: true })).toThrow(
    /requires an explicit review processor/,
  );
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
    const claimed = await store.claimNext("w1", 60_000);
    await api.processJob(jobId, claimed?.claimGeneration ?? 1);

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
    const claimed = await store.claimNext("w1", 60_000);
    await api.processJob(jobId, claimed?.claimGeneration ?? 1);

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
    await store.claimNext("w1", 60_000); // job is running

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
    await expect(api.processJob(jobId, 1)).rejects.toThrow(/not running/);
    const afterProcess = await store.get(jobId);
    expect(afterProcess?.status).toBe("cancelling");
    expect(afterProcess?.resultPointer).toBeNull();
    expect(await objectStore.get(`jobs/${jobId}/critique/result.json`)).toBeNull();

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

  it("deletes a result artifact when cancellation wins the publication race", async () => {
    api = createJobApi({
      store,
      objectStore,
      secret: SECRET,
      processor: async (job) => {
        await store.requestCancel(job.id);
        return {
          grade: "ship",
          overall: "late result",
          findings: [],
          notReviewed: [],
          artifacts: { annotatedScreenshots: [] },
          screenshotRetentionSeconds: 0,
          metadata: {
            engineVersion: "1",
            model: "test",
            promptVersion: "test",
            captureVersion: "test",
            uiDnaVersion: null,
          },
        };
      },
    });
    const post = await api.handle(signed("POST", "/jobs", "1", submission("publish-race")));
    const jobId = (post.body as { jobId: string }).jobId;
    await store.claimNext("w1", 60_000);

    await expect(api.processJob(jobId, 1)).rejects.toThrow(/before publication/);
    expect((await store.get(jobId))?.status).toBe("cancelling");
    expect(await objectStore.get(`jobs/${jobId}/critique/result.json`)).toBeNull();
  });
});

describe("claim-generation fencing (#166)", () => {
  it("a late worker from an expired lease cannot publish over the recovered attempt", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("fence-1", "deep")));
    const jobId = (post.body as { jobId: string }).jobId;

    // Worker A claims (generation 1), then dies: expire its lease and recover.
    const first = await store.claimNext("worker-a", 60_000);
    expect(first?.claimGeneration).toBe(1);
    await db.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const recovered = await store.recoverExpired({ maxAttempts: 3 });
    expect(recovered).toEqual([{ id: jobId, outcome: "requeued", previousOwner: "worker-a" }]);

    // Worker B claims the recovered attempt and publishes.
    const second = await store.claimNext("worker-b", 60_000);
    expect(second?.claimGeneration).toBe(3); // recovery + reclaim each bump the fence
    await api.processJob(jobId, second?.claimGeneration ?? 0);
    const published = await store.get(jobId);
    expect(published?.status).toBe("succeeded");
    const pointer = published?.resultPointer ?? "";

    // Worker A resumes late: its stale generation cannot publish, fail, or renew,
    // and worker B's result pointer is untouched.
    await expect(api.processJob(jobId, 1)).rejects.toThrow(/not running|stale/);
    expect(await store.retryOrFail(jobId, "late failure", 3, 1)).toBeNull();
    expect(await store.renewLease(jobId, "worker-a", 1, 60_000)).toBe(false);
    const final = await store.get(jobId);
    expect(final?.status).toBe("succeeded");
    expect(final?.resultPointer).toBe(pointer);
    expect(await objectStore.get(pointer)).not.toBeNull();
  });
});

describe("hardening (gstack /review fixes)", () => {
  it("a succeeded job whose result artifact is gone returns failed, not completed+null", async () => {
    const post = await api.handle(signed("POST", "/jobs", "1", submission("k6")));
    const jobId = (post.body as { jobId: string }).jobId;
    await store.claimNext("w1", 60_000);
    // Mark succeeded with a pointer to an object that was never written (expired/missing).
    await store.complete(jobId, "jobs/missing/critique/result.json", 1);

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
