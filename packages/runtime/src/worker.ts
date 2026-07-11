import { JOB_NOTIFY_CHANNEL, type JobRecord, type JobStore } from "@engine/jobs";
import { Client } from "pg";

export interface NotificationSource {
  start(onNotification: () => void): Promise<void>;
  close(): Promise<void>;
}

/** Dedicated Postgres LISTEN connection; pooled query connections stay separate. */
export class PgNotificationSource implements NotificationSource {
  private client: Client | null = null;

  constructor(private readonly connectionString: string) {}

  async start(onNotification: () => void): Promise<void> {
    const client = new Client({ connectionString: this.connectionString });
    this.client = client;
    try {
      await client.connect();
      client.on("notification", (message) => {
        if (message.channel === JOB_NOTIFY_CHANNEL) onNotification();
      });
      await client.query(`LISTEN ${JOB_NOTIFY_CHANNEL}`);
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.end();
  }
}

export interface WorkerStore {
  claimNext(): Promise<JobRecord | null>;
  retryOrFail(id: string, error: string, maxAttempts: number): Promise<"queued" | "failed" | null>;
}

export interface EngineWorkerOptions {
  store: WorkerStore;
  processJob(jobId: string): Promise<unknown>;
  notificationSource?: NotificationSource;
  pollIntervalMs?: number;
  maxAttempts?: number;
  /** Finalize a concurrently requested cancellation after the active attempt settles. */
  finalizeCancellation?: (jobId: string) => Promise<void>;
  onJobSettled?: (jobId: string) => void;
  logger?: Pick<Console, "info" | "error">;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** LISTEN-first worker with a bounded polling fallback and graceful drain. */
export class EngineWorker {
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private running = false;
  private stopping = false;
  private wake: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly options: EngineWorkerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    if (this.pollIntervalMs < 1) throw new Error("pollIntervalMs must be positive");
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer");
    }
  }

  isReady(): boolean {
    return this.running && !this.stopping;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.options.notificationSource?.start(() => this.signalWake());
    this.stopping = false;
    this.running = true;
    this.loopPromise = this.runLoop();
    this.signalWake();
  }

  /** Public for deterministic integration tests and one-shot ops drains. */
  async drainOnce(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainAvailable().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.signalWake();
    await this.loopPromise;
    await this.drainPromise;
    await this.options.notificationSource?.close();
    this.running = false;
  }

  private signalWake(): void {
    this.wake?.();
    this.wake = null;
  }

  private async waitForWakeOrPoll(): Promise<void> {
    await Promise.race([
      delay(this.pollIntervalMs),
      new Promise<void>((resolve) => {
        this.wake = resolve;
      }),
    ]);
    this.wake = null;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      await this.waitForWakeOrPoll();
      if (!this.stopping) await this.drainOnce();
    }
  }

  private async drainAvailable(): Promise<void> {
    while (!this.stopping) {
      const job = await this.options.store.claimNext();
      if (!job) return;
      try {
        await this.options.processJob(job.id);
        this.options.logger?.info(`engine job ${job.id} succeeded`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const state = await this.options.store.retryOrFail(job.id, message, this.maxAttempts);
        this.options.logger?.error(`engine job ${job.id} ${state ?? "lost"}: ${message}`);
      } finally {
        await this.options.finalizeCancellation?.(job.id).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.options.logger?.error(`engine job ${job.id} cancellation finalization failed: ${message}`);
        });
        this.options.onJobSettled?.(job.id);
      }
    }
  }
}

export type JobStoreWorkerView = Pick<JobStore, "claimNext" | "retryOrFail">;
