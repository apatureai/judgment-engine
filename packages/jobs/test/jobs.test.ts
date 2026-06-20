import { pgliteExecutor, runMigrations } from "@engine/db";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { JOB_NOTIFY_CHANNEL, JobStore, type EnqueueJobInput } from "../src/index.js";

let db: PGlite;
let store: JobStore;

const baseInput: EnqueueJobInput = {
  consumer: "gate",
  installationId: "1",
  intentType: "pr_review",
  idempotencyKey: "gate:1:pr_review:sha-abc",
  depth: "deep",
  input: { prNumber: 42 },
};

beforeEach(async () => {
  db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  store = new JobStore(pgliteExecutor(db));
});

describe("enqueue idempotency", () => {
  it("creates a queued job and dedups across duplicate keys", async () => {
    const first = await store.enqueue(baseInput);
    expect(first.created).toBe(true);
    expect(first.job.status).toBe("queued");
    expect(first.job.input).toEqual({ prNumber: 42 });

    const second = await store.enqueue({ ...baseInput, input: { prNumber: 999 } });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id); // same job, not a new row

    const { rows } = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM jobs");
    expect(rows[0]?.count).toBe("1");
  });
});

describe("claimNext (SKIP LOCKED)", () => {
  it("claims the oldest queued job once and marks it running", async () => {
    const { job } = await store.enqueue(baseInput);

    const claimed = await store.claimNext();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);

    // Nothing left queued.
    expect(await store.claimNext()).toBeNull();
  });
});

describe("lifecycle transitions", () => {
  it("completes a running job with a result pointer", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext();
    await store.complete(job.id, "jobs/abc/critique/result.json");

    const got = await store.get(job.id);
    expect(got?.status).toBe("succeeded");
    expect(got?.resultPointer).toBe("jobs/abc/critique/result.json");
  });

  it("fails a running job with an error", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext();
    await store.fail(job.id, "capture unstable");

    const got = await store.get(job.id);
    expect(got?.status).toBe("failed");
    expect(got?.error).toBe("capture unstable");
  });

  it("cancels a non-terminal job and refuses a terminal one", async () => {
    const { job } = await store.enqueue(baseInput);
    const canceled = await store.cancel(job.id);
    expect(canceled?.status).toBe("canceled");

    // Already terminal -> null.
    expect(await store.cancel(job.id)).toBeNull();
  });
});

describe("pg_notify dispatch", () => {
  it("notifies listeners on enqueue (no busy-poll)", async () => {
    const received: string[] = [];
    await db.listen(JOB_NOTIFY_CHANNEL, (payload: string) => received.push(payload));

    const { job } = await store.enqueue(baseInput);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toContain(job.id);
  });
});
