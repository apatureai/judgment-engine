import type { SqlExecutor } from "@engine/db";
import { jobPriority } from "./priority.js";

export type JobStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "canceled";
export type ReviewDepth = "triage" | "deep";

/** Postgres NOTIFY channel workers LISTEN on; payload is the new job id. */
export const JOB_NOTIFY_CHANNEL = "engine_jobs";

export interface EnqueueJobInput {
  /** Consuming surface: "gate", "mcp", ... */
  consumer: string;
  installationId: string;
  /** Intent kind, e.g. "pr_review". */
  intentType: string;
  /** `{consumer}:{installationId}:{intentType}:{intentHash}` — the dedup key. */
  idempotencyKey: string;
  depth: ReviewDepth;
  /** Opaque job payload (target, trace carrier, ...). */
  input?: unknown;
}

export interface JobRecord {
  id: string;
  consumer: string;
  installationId: string;
  intentType: string;
  idempotencyKey: string;
  depth: ReviewDepth;
  status: JobStatus;
  input: unknown;
  /** Scheduling priority (lower = higher); the claim serves lowest first (#67). */
  priority: number;
  resultPointer: string | null;
  error: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface JobRow {
  id: string;
  consumer: string;
  installation_id: string;
  intent_type: string;
  idempotency_key: string;
  depth: ReviewDepth;
  status: JobStatus;
  input: unknown;
  priority: number;
  result_pointer: string | null;
  error: string | null;
  attempts: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const COLS = `id, consumer, installation_id, intent_type, idempotency_key, depth, status, input,
  priority, result_pointer, error, attempts, created_at, updated_at, started_at, finished_at`;

function mapRow(r: JobRow): JobRecord {
  return {
    id: r.id,
    consumer: r.consumer,
    installationId: r.installation_id,
    intentType: r.intent_type,
    idempotencyKey: r.idempotency_key,
    depth: r.depth,
    status: r.status,
    input: r.input,
    priority: r.priority,
    resultPointer: r.result_pointer,
    error: r.error,
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/**
 * Job store over Postgres (TRD §3). Status + metadata live here (the source of
 * truth); results live in object storage, referenced by `resultPointer`. Enqueue
 * is idempotent across consumers via the unique `idempotency_key`; workers are
 * woken by `pg_notify` on `engine_jobs` and claim with `FOR UPDATE SKIP LOCKED`,
 * so there is no busy-poll.
 */
export class JobStore {
  constructor(private readonly exec: SqlExecutor) {}

  /**
   * Enqueue a job, returning the existing one if the idempotency key was already
   * used (`created: false`). ACID dedup via `ON CONFLICT DO NOTHING` + re-select.
   */
  async enqueue(input: EnqueueJobInput): Promise<{ job: JobRecord; created: boolean }> {
    const { rows } = await this.exec.query<JobRow>(
      `INSERT INTO jobs (consumer, installation_id, intent_type, idempotency_key, depth, input, priority)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLS}`,
      [
        input.consumer,
        input.installationId,
        input.intentType,
        input.idempotencyKey,
        input.depth,
        JSON.stringify(input.input ?? {}),
        jobPriority(input.consumer, input.intentType),
      ],
    );

    const inserted = rows[0];
    if (inserted) return { job: mapRow(inserted), created: true };

    // Conflict: a job with this key already exists — return it.
    const existing = await this.getByIdempotencyKey(input.idempotencyKey);
    if (!existing) throw new Error(`enqueue conflict but no existing job for ${input.idempotencyKey}`);
    return { job: existing, created: false };
  }

  async get(id: string): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(`SELECT ${COLS} FROM jobs WHERE id = $1`, [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async getByIdempotencyKey(key: string): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(
      `SELECT ${COLS} FROM jobs WHERE idempotency_key = $1`,
      [key],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Atomically claim the oldest queued job, marking it running. Uses
   * `FOR UPDATE SKIP LOCKED` so concurrent workers never claim the same job and
   * never block each other. Returns null when the queue is empty.
   */
  async claimNext(): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(
      `UPDATE jobs
         SET status = 'running', started_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued'
         ORDER BY priority, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${COLS}`,
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Mark a running job succeeded with a pointer to its result in object storage. */
  async complete(id: string, resultPointer: string): Promise<boolean> {
    const { rows } = await this.exec.query<{ id: string }>(
      `UPDATE jobs SET status = 'succeeded', result_pointer = $2, finished_at = now()
       WHERE id = $1 AND status = 'running'
       RETURNING id`,
      [id, resultPointer],
    );
    return rows.length === 1;
  }

  /** Mark a running job failed with an error message. */
  async fail(id: string, error: string): Promise<void> {
    await this.exec.query(
      `UPDATE jobs SET status = 'failed', error = $2, finished_at = now()
       WHERE id = $1 AND status = 'running'`,
      [id, error],
    );
  }

  /**
   * Retry a failed attempt while it is below the bounded attempt budget, or
   * atomically mark it terminal. A cancelled/cancelling job is never requeued.
   * Returns the resulting state, or null when the worker lost ownership.
   */
  async retryOrFail(
    id: string,
    error: string,
    maxAttempts: number,
  ): Promise<"queued" | "failed" | null> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
    const { rows } = await this.exec.query<{ status: "queued" | "failed" }>(
      `UPDATE jobs
         SET status = CASE WHEN attempts < $3 THEN 'queued' ELSE 'failed' END,
             error = $2,
             started_at = CASE WHEN attempts < $3 THEN NULL ELSE started_at END,
             finished_at = CASE WHEN attempts < $3 THEN NULL ELSE now() END
       WHERE id = $1 AND status = 'running'
       RETURNING status`,
      [id, error, maxAttempts],
    );
    return rows[0]?.status ?? null;
  }

  /**
   * Cancel a non-terminal job. Returns the updated record, or null if the job
   * was already terminal (succeeded/failed/canceled) or does not exist.
   */
  async cancel(id: string): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(
      `UPDATE jobs SET status = 'canceled', finished_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING ${COLS}`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Cooperative-cancel step 1 (#66): move a non-terminal job to `cancelling`
   * immediately so consumers see the intent at once. Returns the record, or null
   * if already terminal/cancelling. Teardown (microVM kill + inference abort)
   * happens after; `markCanceled` finalizes. Because `complete`/`fail` only act
   * on `running` rows, no result is written for a job once it leaves `running`.
   */
  async requestCancel(id: string): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(
      `UPDATE jobs SET status = 'cancelling'
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING ${COLS}`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Cooperative-cancel step 2 (#66): finalize a `cancelling` job to `canceled`. */
  async markCanceled(id: string): Promise<JobRecord | null> {
    const { rows } = await this.exec.query<JobRow>(
      `UPDATE jobs SET status = 'canceled', finished_at = now()
       WHERE id = $1 AND status = 'cancelling'
       RETURNING ${COLS}`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }
}
