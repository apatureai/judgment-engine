/**
 * Object keys are namespaced by job id so every artifact for a review lives
 * under one prefix (`jobs/<jobId>/...`), making retention/deletion a single
 * prefix sweep (#51).
 */
export const OBJECT_KINDS = {
  screenshot: "screenshots",
  dom: "dom",
  critique: "critique",
} as const;

export type ObjectKind = keyof typeof OBJECT_KINDS;

/** Build an object key for a job artifact: `jobs/<jobId>/<kind>/<name>`. */
export function objectKey(jobId: string, kind: ObjectKind, name: string): string {
  return `jobs/${jobId}/${OBJECT_KINDS[kind]}/${name}`;
}

/** Prefix covering every artifact for a job (retention sweep). */
export function jobPrefix(jobId: string): string {
  return `jobs/${jobId}/`;
}
