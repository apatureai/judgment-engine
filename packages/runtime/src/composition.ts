import { S3Client } from "@aws-sdk/client-s3";
import { createJobApi, createJobReviewProcessor } from "@engine/api";
import { buildGenomeIndex, type Embedder } from "@engine/context";
import type { ModelClientFactory, PassModelOverrides } from "@engine/critique";
import { pgExecutor } from "@engine/db";
import { CancellationCoordinator, JobStore, type JobRecord } from "@engine/jobs";
import { initTelemetry, type Telemetry } from "@engine/observability";
import { EnvSecretStore } from "@engine/secrets";
import { S3ObjectStore, type ObjectStore } from "@engine/storage";
import { Pool } from "pg";
import { HttpCaptureClient, HttpGenomeResolver, createOpenAIAdapters, type CaptureClient, type GenomeResolver } from "./adapters.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import { EngineHttpServer } from "./http.js";
import { repositoryForJob, toReviewInput } from "./input.js";
import { EngineWorker, PgNotificationSource, type NotificationSource } from "./worker.js";

export interface EngineRuntimeOptions {
  store: JobStore;
  objectStore: ObjectStore;
  engineHmacSecret: string;
  capture: CaptureClient;
  modelFactory: ModelClientFactory;
  passModels?: PassModelOverrides;
  genomeResolver?: GenomeResolver;
  embedder?: Embedder;
  notificationSource?: NotificationSource;
  databaseReady(): Promise<boolean>;
  workerPollMs?: number;
  workerMaxAttempts?: number;
  logger?: Pick<Console, "info" | "error">;
}

export interface EngineRuntime {
  server: EngineHttpServer;
  worker: EngineWorker;
  start(port: number, host?: string): Promise<number>;
  stop(): Promise<void>;
}

/** Compose the real API, orchestrator processor, cancellation, worker, and health surfaces. */
export function createEngineRuntime(options: EngineRuntimeOptions): EngineRuntime {
  const coordinator = new CancellationCoordinator((jobId) => options.capture.cancel(jobId));
  const coreProcessor = createJobReviewProcessor(
    toReviewInput,
    async (job: JobRecord, input) => {
      const signal = coordinator.register(job.id);
      const resolvedGenome = options.genomeResolver
        ? await options.genomeResolver.resolve(repositoryForJob(job), job.installationId)
        : null;
      if (resolvedGenome && !options.embedder) {
        throw new Error("UI-DNA grounding resolved a genome but no embedder is configured");
      }
      input.context.uiDnaVersion = resolvedGenome?.version ?? null;
      const genomeIndex = resolvedGenome && options.embedder
        ? await buildGenomeIndex(resolvedGenome.version, resolvedGenome.rules, options.embedder)
        : undefined;
      return {
        captureInSandbox: options.capture.forJob(job.id, signal),
        modelFactory: options.modelFactory,
        ...(options.passModels ? { passModels: options.passModels } : {}),
        ...(genomeIndex ? { genomeIndex } : {}),
        ...(genomeIndex && options.embedder ? { embedder: options.embedder } : {}),
        signal,
      };
    },
  );
  const processor = async (job: JobRecord) => coreProcessor(job);
  const api = createJobApi({
    store: options.store,
    objectStore: options.objectStore,
    secret: options.engineHmacSecret,
    processor,
    coordinator,
    production: true,
  });
  const worker = new EngineWorker({
    store: options.store,
    processJob: api.processJob,
    ...(options.notificationSource ? { notificationSource: options.notificationSource } : {}),
    ...(options.workerPollMs !== undefined ? { pollIntervalMs: options.workerPollMs } : {}),
    ...(options.workerMaxAttempts !== undefined ? { maxAttempts: options.workerMaxAttempts } : {}),
    finalizeCancellation: async (jobId) => {
      await options.store.markCanceled(jobId);
    },
    onJobSettled: (jobId) => coordinator.release(jobId),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const server = new EngineHttpServer({
    handle: api.handle,
    readiness: {
      database: options.databaseReady,
      capture: () => options.capture.ready(),
      worker: () => worker.isReady(),
    },
  });
  return {
    server,
    worker,
    async start(port, host) {
      try {
        await worker.start();
        return await server.listen(port, host);
      } catch (error) {
        await worker.stop();
        throw error;
      }
    },
    async stop() {
      await server.close();
      await worker.stop();
    },
  };
}

export interface ProductionRuntime {
  runtime: EngineRuntime;
  config: RuntimeConfig;
  telemetry: Telemetry;
  pool: Pool;
  start(): Promise<number>;
  stop(): Promise<void>;
}

/** Bind all production adapters. Missing dependencies fail before a port is opened. */
export async function buildProductionRuntime(env: NodeJS.ProcessEnv = process.env): Promise<ProductionRuntime> {
  const config = await loadRuntimeConfig(new EnvSecretStore(env), env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  const store = new JobStore(pgExecutor(pool));
  const s3 = new S3Client({
    region: config.objectStoreRegion,
    ...(config.objectStoreEndpoint ? { endpoint: config.objectStoreEndpoint } : {}),
    credentials: {
      accessKeyId: config.objectStoreAccessKeyId,
      secretAccessKey: config.objectStoreSecretAccessKey,
    },
  });
  const objectStore = new S3ObjectStore(s3, config.objectStoreBucket);
  const capture = new HttpCaptureClient(config.captureEndpoint, config.captureToken);
  const openai = createOpenAIAdapters({
    apiKey: config.modelApiKey,
    baseURL: config.modelBaseUrl,
    objectStore,
    ...(config.embeddingModel ? { embeddingModel: config.embeddingModel } : {}),
  });
  const genomeResolver = config.genomeEndpoint && config.genomeToken
    ? new HttpGenomeResolver(config.genomeEndpoint, config.genomeToken)
    : undefined;
  const telemetry = initTelemetry({ serviceName: "judgment-engine", serviceVersion: "0.0.0" });
  const runtime = createEngineRuntime({
    store,
    objectStore,
    engineHmacSecret: config.engineHmacSecret,
    capture,
    modelFactory: openai.modelFactory,
    passModels: config.passModels,
    ...(genomeResolver ? { genomeResolver } : {}),
    ...(openai.embedder ? { embedder: openai.embedder } : {}),
    notificationSource: new PgNotificationSource(config.databaseUrl),
    databaseReady: async () => {
      await pool.query("SELECT 1");
      return true;
    },
    workerPollMs: config.workerPollMs,
    workerMaxAttempts: config.workerMaxAttempts,
    logger: console,
  });
  return {
    runtime,
    config,
    telemetry,
    pool,
    start: () => runtime.start(config.port),
    async stop() {
      await runtime.stop();
      await Promise.all([pool.end(), telemetry.shutdown()]);
    },
  };
}
