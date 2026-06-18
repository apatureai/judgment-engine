import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ResultMetadata } from "./findings.js";

/**
 * Consumer-facing wire result returned over the async job API — the projection of
 * the internal `Critique` that crosses the repo boundary. It MUST stay identical
 * to Gate's `GateReviewResult` (TRD §2, §3); the shared golden fixture
 * (`fixtures/gate-review-result.golden.json`, copied from apatureai/gate) is the
 * cross-repo contract anchor, and `x-schema-version` guards additive evolution.
 */
export const SCHEMA_VERSION = "1";

export type WireGrade = "ship" | "ship_with_nits" | "needs_work" | "blocked";

export interface WireFinding {
  id: string;
  severity: "nit" | "minor" | "major" | "blocker";
  title: string;
  description: string;
  route: string;
  viewport: "mobile" | "tablet" | "desktop";
  element: string | null;
  screenshotId: string | null;
  suggestion: string | null;
}

export interface EngineReviewResult {
  grade: WireGrade;
  overall: string;
  findings: WireFinding[];
  notReviewed: string[];
  artifacts: {
    annotatedScreenshots: Array<{ findingId: string; url: string }>;
    engineDebugUrl?: string;
  };
  screenshotRetentionSeconds: number;
  metadata: ResultMetadata;
}

/** Path to the shared golden wire result (the cross-repo contract anchor). */
export const GOLDEN_RESULT_PATH = fileURLToPath(
  new URL("../fixtures/gate-review-result.golden.json", import.meta.url),
);

/** Load the golden wire result the engine serializer must reproduce. */
export function loadGoldenResult(): EngineReviewResult {
  return JSON.parse(readFileSync(GOLDEN_RESULT_PATH, "utf8")) as EngineReviewResult;
}
