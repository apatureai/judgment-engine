import { S3Client } from "@aws-sdk/client-s3";
import { createJobApi, createJobReviewProcessor } from "@engine/api";
import { buildGenomeIndex, type Embedder } from "@engine/context";
import {
  ENGINE_VERSION,
  PROMPT_VERSION,
  RUBRIC_VERSION,
  enforceGroundingAuthority,
  resolvePassModel,
  type ModelClientFactory,
  type PassModelOverrides,
} from "@engine/critique";
import { pgExecutor } from "@engine/db";
import {
  createCalibrationRuntimeBinding,
  ModelPromptRegistry,
  type PromotedCalibration,
} from "@engine/eval";
import { CancellationCoordinator, JobStore, type JobRecord } from "@engine/jobs";
import { EngineMetrics, initTelemetry, METER_NAME, type Telemetry } from "@engine/observability";
import { EnvSecretStore } from "@engine/secrets";
import { S3ObjectStore, type ObjectStore } from "@engine/storage";
import type { EngineReviewResult, GroundingAuthorityUnknownReason } from "@engine/types";
import { Pool } from "pg";
import { HttpCaptureClient, HttpGenomeResolver, createOpenAIAdapters, type CaptureClient, type GenomeResolver } from "./adapters.js";
import {
  GroundingAuthorityError,
  authorityProvenance,
  compareAuthorityReceipts,
  monotonicGroundingAuthorityPort,
  unknownAuthorityProvenance,
  validateGroundingAuthorityReceipt,
  type GroundingAuthorityKey,
  type GroundingAuthorityPort,
  type GroundingAuthorityReceipt,
} from "./authority.js";
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
  calibrationResolver?: { currentCalibration(): Promise<PromotedCalibration | null> };
  genomeResolver?: GenomeResolver;
  /** Required alongside genomeResolver; rechecks the exact version at publication. */
  groundingAuthority?: GroundingAuthorityPort;
  /** Authority mirror freshness bound (default 60 seconds). */
  authorityMaxAgeMs?: number;
  authorityNow?: () => Date;
  authorityMetrics?: Pick<
    EngineMetrics,
    "recordAuthorityLookupLatency" | "recordAuthorityLookupFailure"
  >;
  embedder?: Embedder;
  notificationSource?: NotificationSource;
  databaseReady(): Promise<boolean>;
  workerPollMs?: number;
  workerMaxAttempts?: number;
  /** Lease TTL per claimed attempt; the worker heartbeats at a third of it (#166). */
  workerLeaseMs?: number;
  /** Hard per-attempt deadline independent of heartbeats (#166); unset = none. */
  jobMaxAttemptMs?: number;
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
  if (Boolean(options.genomeResolver) !== Boolean(options.groundingAuthority)) {
    throw new Error("UI-DNA grounding requires both genomeResolver and groundingAuthority");
  }
  const authorityNow = options.authorityNow ?? ((): Date => new Date());
  const authority = options.groundingAuthority
    ? monotonicGroundingAuthorityPort({
        statusFor: async (key) => validateGroundingAuthorityReceipt(
          await options.groundingAuthority!.statusFor(key),
          { now: authorityNow(), ...(options.authorityMaxAgeMs !== undefined
            ? { maxAgeMs: options.authorityMaxAgeMs }
            : {}) },
        ),
      })
    : undefined;
  const groundingByJob = new Map<string, {
    key: GroundingAuthorityKey;
    initial: GroundingAuthorityReceipt | null;
    initialFailure: GroundingAuthorityUnknownReason | null;
  }>();
  const coordinator = new CancellationCoordinator((jobId) => options.capture.cancel(jobId));
  const coreProcessor = createJobReviewProcessor(
    toReviewInput,
    async (job: JobRecord, input) => {
      const signal = coordinator.register(job.id);
      const promotedCalibration = options.calibrationResolver
        ? await options.calibrationResolver.currentCalibration()
        : null;
      const deepModel = resolvePassModel("deep", options.passModels).model;
      const calibration = promotedCalibration
        ? createCalibrationRuntimeBinding(
            promotedCalibration.report,
            promotedCalibration.promotionMode,
            {
              model: deepModel,
              promptVersion: PROMPT_VERSION,
              engineVersion: ENGINE_VERSION,
              rubricVersion: RUBRIC_VERSION,
            },
          )
        : { ok: false as const, reason: "missing_calibration_report" as const, error: "no promoted calibration report" };
      const resolvedGenome = options.genomeResolver
        ? await options.genomeResolver.resolve(repositoryForJob(job), job.installationId)
        : null;
      if (resolvedGenome && !options.embedder) {
        throw new Error("UI-DNA grounding resolved a genome but no embedder is configured");
      }
      input.context.uiDnaVersion = resolvedGenome?.version ?? null;
      if (resolvedGenome) {
        let initial: GroundingAuthorityReceipt | null = null;
        let initialFailure: GroundingAuthorityUnknownReason | null = null;
        try {
          initial = validateGroundingAuthorityReceipt(resolvedGenome.authority, {
            now: authorityNow(),
            ...(options.authorityMaxAgeMs !== undefined ? { maxAgeMs: options.authorityMaxAgeMs } : {}),
          });
        } catch (error) {
          initialFailure = error instanceof GroundingAuthorityError ? error.reason : "malformed";
        }
        groundingByJob.set(job.id, {
          key: {
            tenantId: job.installationId,
            repository: repositoryForJob(job),
            dnaVersion: resolvedGenome.version,
          },
          initial,
          initialFailure,
        });
      }
      const genomeIndex = resolvedGenome && options.embedder
        ? await buildGenomeIndex(resolvedGenome.version, resolvedGenome.rules, options.embedder)
        : undefined;
      return {
        captureInSandbox: options.capture.forJob(job.id, signal),
        modelFactory: options.modelFactory,
        ...(options.passModels ? { passModels: options.passModels } : {}),
        ...(calibration.ok
          ? { calibration: calibration.binding }
          : { confidenceUnavailableReason: calibration.reason }),
        ...(genomeIndex ? { genomeIndex } : {}),
        ...(genomeIndex && options.embedder ? { embedder: options.embedder } : {}),
        signal,
      };
    },
  );
  const processor = async (job: JobRecord) => coreProcessor(job);
  const beforePublish = async (job: JobRecord, assembled: EngineReviewResult): Promise<EngineReviewResult> => {
    const grounding = groundingByJob.get(job.id);
    if (!grounding || !authority) return assembled;

    const startedAt = Date.now();
    let publication: GroundingAuthorityReceipt | null = null;
    try {
      publication = await authority.statusFor(grounding.key);
      if (grounding.initialFailure) {
        throw new GroundingAuthorityError(
          grounding.initialFailure,
          "resolve-time authority evidence was not trustworthy",
        );
      }
      if (!grounding.initial) {
        throw new GroundingAuthorityError("missing", "resolve-time authority evidence is missing");
      }
      if (assembled.metadata.uiDnaVersion !== grounding.key.dnaVersion) {
        throw new GroundingAuthorityError("malformed", "result DNA version differs from authority key");
      }
      compareAuthorityReceipts(grounding.initial, publication);
      const publicationCheckedAt = authorityNow().toISOString();
      options.authorityMetrics?.recordAuthorityLookupLatency(Date.now() - startedAt, {
        outcome: publication.status,
      });
      const stamped: EngineReviewResult = {
        ...assembled,
        metadata: {
          ...assembled.metadata,
          groundingAuthority: authorityProvenance(publication, publicationCheckedAt),
        },
      };
      return enforceGroundingAuthority(stamped, { status: publication.status });
    } catch (error) {
      const reason: GroundingAuthorityUnknownReason = error instanceof GroundingAuthorityError
        ? error.reason
        : "unavailable";
      const lastKnown = error instanceof GroundingAuthorityError ? error.lastKnown : undefined;
      const publicationCheckedAt = authorityNow().toISOString();
      options.authorityMetrics?.recordAuthorityLookupLatency(Date.now() - startedAt, { outcome: "unknown" });
      options.authorityMetrics?.recordAuthorityLookupFailure(reason);
      options.logger?.info(`engine job ${job.id} grounding authority unknown: ${reason}`);
      const stamped: EngineReviewResult = {
        ...assembled,
        metadata: {
          ...assembled.metadata,
          groundingAuthority: unknownAuthorityProvenance(
            lastKnown ?? publication ?? grounding.initial,
            publicationCheckedAt,
            reason,
          ),
        },
      };
      return enforceGroundingAuthority(stamped, { status: "unknown" });
    }
  };
  const api = createJobApi({
    store: options.store,
    objectStore: options.objectStore,
    secret: options.engineHmacSecret,
    processor,
    beforePublish,
    coordinator,
    production: true,
  });
  const worker = new EngineWorker({
    store: options.store,
    processJob: api.processJob,
    ...(options.notificationSource ? { notificationSource: options.notificationSource } : {}),
    ...(options.workerPollMs !== undefined ? { pollIntervalMs: options.workerPollMs } : {}),
    ...(options.workerMaxAttempts !== undefined ? { maxAttempts: options.workerMaxAttempts } : {}),
    ...(options.workerLeaseMs !== undefined ? { leaseTtlMs: options.workerLeaseMs } : {}),
    ...(options.jobMaxAttemptMs !== undefined ? { maxAttemptMs: options.jobMaxAttemptMs } : {}),
    // Lease lost mid-attempt (#166): abort the local inference stream + capture
    // sandbox so the fenced-out attempt stops burning compute.
    onLeaseLost: (jobId) => {
      void coordinator.cancel(jobId);
    },
    // Recovered a lost worker's attempt: best-effort stop of its capture job.
    onRecovered: (job) => {
      void options.capture.cancel(job.id).catch(() => undefined);
    },
    finalizeCancellation: async (jobId, claimGeneration) => {
      await options.store.markCanceled(jobId, claimGeneration);
    },
    onJobSettled: (jobId) => {
      coordinator.release(jobId);
      groundingByJob.delete(jobId);
    },
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
  const calibrationRegistry = new ModelPromptRegistry(pgExecutor(pool));
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
    ? new HttpGenomeResolver(config.genomeEndpoint, config.genomeToken, fetch, config.authorityTimeoutMs)
    : undefined;
  const telemetry = initTelemetry({ serviceName: "judgment-engine", serviceVersion: "0.0.0" });
  const authorityMetrics = new EngineMetrics(telemetry.meterProvider.getMeter(METER_NAME));
  const runtime = createEngineRuntime({
    store,
    objectStore,
    engineHmacSecret: config.engineHmacSecret,
    capture,
    modelFactory: openai.modelFactory,
    passModels: config.passModels,
    calibrationResolver: calibrationRegistry,
    ...(genomeResolver ? { genomeResolver } : {}),
    ...(genomeResolver ? { groundingAuthority: genomeResolver } : {}),
    authorityMaxAgeMs: config.authorityMaxAgeMs,
    authorityMetrics,
    ...(openai.embedder ? { embedder: openai.embedder } : {}),
    notificationSource: new PgNotificationSource(config.databaseUrl),
    databaseReady: async () => {
      await pool.query("SELECT 1");
      return true;
    },
    workerPollMs: config.workerPollMs,
    workerMaxAttempts: config.workerMaxAttempts,
    workerLeaseMs: config.workerLeaseMs,
    jobMaxAttemptMs: config.jobMaxAttemptMs,
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
