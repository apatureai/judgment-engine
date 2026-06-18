/**
 * App-level secrets the engine holds (§11/§3.1). Resolved from a KMS-backed
 * secret manager in production; the env resolver here is the dev/local seam and
 * the same interface Fly app secrets are injected through at runtime (#3). Every
 * secret read goes through this one typed accessor.
 */
export const APP_SECRET_KEYS = [
  "modelApiKey",
  "engineHmacSecret",
  "databaseUrl",
  "redisUrl",
  "kmsRootKey",
  "objectStoreAccessKeyId",
  "objectStoreSecretAccessKey",
] as const;

export type AppSecretKey = (typeof APP_SECRET_KEYS)[number];

export interface SecretStore {
  get(key: AppSecretKey): Promise<string>;
}

const ENV_VARS: Record<AppSecretKey, string> = {
  modelApiKey: "MODEL_API_KEY",
  engineHmacSecret: "ENGINE_HMAC_SECRET",
  databaseUrl: "DATABASE_URL",
  redisUrl: "REDIS_URL",
  kmsRootKey: "KMS_ROOT_KEY",
  objectStoreAccessKeyId: "OBJECT_STORE_ACCESS_KEY_ID",
  objectStoreSecretAccessKey: "OBJECT_STORE_SECRET_ACCESS_KEY",
};

/**
 * Resolves app secrets from environment variables. The production store binds
 * the same interface to a managed KMS/secret manager (AWS Secrets Manager).
 */
export class EnvSecretStore implements SecretStore {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  async get(key: AppSecretKey): Promise<string> {
    const value = this.env[ENV_VARS[key]];
    if (value === undefined || value === "") {
      throw new Error(`Missing secret: ${key} (${ENV_VARS[key]})`);
    }
    return value;
  }
}
