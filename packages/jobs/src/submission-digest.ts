import { createHash } from "node:crypto";
import type { EnqueueJobInput } from "./store.js";

/** Versioned domain separator for the engine-owned immutable request digest. */
export const JOB_SUBMISSION_DIGEST_VERSION = "judgment-engine/job-submission/v1";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("job submission contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError("job submission contains a sparse array");
      }
      const entry = value[index];
      if (entry === undefined) throw new TypeError("job submission contains undefined array state");
      entries.push(canonicalJson(entry));
    }
    return `[${entries.join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("job submission contains a non-JSON object");
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => {
      const entry = object[key];
      if (entry === undefined) throw new TypeError("job submission contains undefined object state");
      return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
    }).join(",")}}`;
  }
  throw new TypeError(`job submission contains unsupported ${typeof value} state`);
}

/**
 * Digest the immutable submission identity. The caller key is opaque: it is
 * included as a string, never parsed or rewritten. Object keys are sorted at
 * every level so equivalent JSON bodies have the same digest.
 */
export function jobSubmissionDigest(input: EnqueueJobInput): `sha256:${string}` {
  const material = {
    schema: JOB_SUBMISSION_DIGEST_VERSION,
    consumer: input.consumer,
    installation_id: input.installationId,
    intent_type: input.intentType,
    opaque_idempotency_key: input.idempotencyKey,
    depth: input.depth,
    request: input.input === undefined ? {} : input.input,
  };
  return `sha256:${createHash("sha256").update(canonicalJson(material), "utf8").digest("hex")}`;
}
