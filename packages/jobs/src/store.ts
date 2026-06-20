import type { SqlExecutor } from "@engine/db";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";
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
  result_pointer: string | null;
  error: string | null;
  attempts: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const COLS = `id, consumer, installation_id, intent_type, idempotency_key, depth, status, input,
  result_pointer, error, attempts, created_at, updated_at, started_at, finished_at`;

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
      `INSERT INTO jobs (consumer, installation_id, intent_type, idempotency_key, depth, input)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLS}`,
      [
        input.consumer,
        input.installationId,
        input.intentType,
        input.idempotencyKey,
        input.depth,
        JSON.stringify(input.input ?? {}),
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
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${COLS}`,
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** Mark a running job succeeded with a pointer to its result in object storage. */
  async complete(id: string, resultPointer: string): Promise<void> {
    await this.exec.query(
      `UPDATE jobs SET status = 'succeeded', result_pointer = $2, finished_at = now()
       WHERE id = $1 AND status = 'running'`,
      [id, resultPointer],
    );
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
}
