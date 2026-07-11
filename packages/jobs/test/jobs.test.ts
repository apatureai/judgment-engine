import { pgliteExecutor, runMigrations } from "@engine/db";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CancellationCoordinator,
  JOB_NOTIFY_CHANNEL,
  JobStore,
  type EnqueueJobInput,
} from "../src/index.js";

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

describe("priority scheduling (#67)", () => {
  it("claims higher-priority work first (gate-blocking before other consumers)", async () => {
    // Enqueue a low-priority other-consumer job first, then a gate-blocking one.
    await store.enqueue({
      consumer: "mcp",
      installationId: "1",
      intentType: "pr_review",
      idempotencyKey: "mcp:1:pr_review:a",
      depth: "deep",
    });
    const { job: gateJob } = await store.enqueue({
      consumer: "gate",
      installationId: "1",
      intentType: "pr_review",
      idempotencyKey: "gate:1:pr_review:b",
      depth: "deep",
    });

    // Despite being enqueued second, the gate-blocking job is claimed first.
    const claimed = await store.claimNext();
    expect(claimed?.id).toBe(gateJob.id);
    expect(claimed?.priority).toBe(0);
  });
});

describe("cooperative cancellation (#66)", () => {
  it("requestCancel -> cancelling (immediately), then markCanceled -> canceled", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext(); // running

    const cancelling = await store.requestCancel(job.id);
    expect(cancelling?.status).toBe("cancelling");

    // complete/fail are no-ops once the job left `running` (no result written).
    await store.complete(job.id, "jobs/x/critique/result.json");
    const mid = await store.get(job.id);
    expect(mid?.status).toBe("cancelling");
    expect(mid?.resultPointer).toBeNull();

    const finalized = await store.markCanceled(job.id);
    expect(finalized?.status).toBe("canceled");
  });

  it("requestCancel returns null for an already-terminal job", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext();
    await store.complete(job.id, "jobs/x/r.json"); // succeeded
    expect(await store.requestCancel(job.id)).toBeNull();
  });
});

describe("bounded worker retry", () => {
  it("requeues below the attempt budget and fails at the budget", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext();
    expect(await store.retryOrFail(job.id, "transient", 2)).toBe("queued");
    expect((await store.get(job.id))?.status).toBe("queued");

    await store.claimNext();
    expect(await store.retryOrFail(job.id, "still broken", 2)).toBe("failed");
    const failed = await store.get(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("still broken");
  });

  it("never requeues a cancelling job", async () => {
    const { job } = await store.enqueue(baseInput);
    await store.claimNext();
    await store.requestCancel(job.id);
    expect(await store.retryOrFail(job.id, "late failure", 3)).toBeNull();
    expect((await store.get(job.id))?.status).toBe("cancelling");
  });
});

describe("CancellationCoordinator", () => {
  it("registers an abortable signal and runs the kill seam on cancel", async () => {
    const killed: string[] = [];
    const coordinator = new CancellationCoordinator(async (id) => {
      killed.push(id);
    });
    const signal = coordinator.register("job_1");
    expect(signal.aborted).toBe(false);

    await coordinator.cancel("job_1");
    expect(signal.aborted).toBe(true);
    expect(coordinator.isAborted("job_1")).toBe(true);
    expect(killed).toEqual(["job_1"]);
  });

  it("swallows kill-seam errors (teardown is best-effort)", async () => {
    const coordinator = new CancellationCoordinator(async () => {
      throw new Error("microVM stop failed");
    });
    coordinator.register("job_2");
    await expect(coordinator.cancel("job_2")).resolves.toBeUndefined();
    expect(coordinator.isAborted("job_2")).toBe(true);
  });
});
