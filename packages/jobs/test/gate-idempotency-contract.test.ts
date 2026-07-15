import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jobSubmissionDigest, type EnqueueJobInput } from "../src/index.js";

interface GateFixture {
  consumer: string;
  installationId: string;
  intentType: string;
  callerIdempotencyKey: string;
  depth: "deep" | "triage";
  request: unknown;
  expectedEngineDigest: string;
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL("./fixtures/gate-review-v2-submission.json", import.meta.url)),
  "utf8",
)) as GateFixture;

function engineInput(callerKey: string): EnqueueJobInput {
  return {
    consumer: fixture.consumer,
    installationId: fixture.installationId,
    intentType: fixture.intentType,
    idempotencyKey: `${fixture.consumer}:${fixture.installationId}:${fixture.intentType}:${callerKey}`,
    depth: fixture.depth,
    input: fixture.request,
  };
}

describe("Gate gate-review-v2 producer contract", () => {
  it("byte-pins the engine digest while keeping Gate's caller namespace opaque", () => {
    expect(fixture.callerIdempotencyKey).toBe(
      "gate-review-v2:sha256:a14a2a84926a21784de26c45b71089c23bdfd8d0a17a282a2aa55135a501a2b9",
    );
    expect(jobSubmissionDigest(engineInput(fixture.callerIdempotencyKey)))
      .toBe(fixture.expectedEngineDigest);

    // A future caller namespace is just another opaque string to the engine;
    // no Judgment Engine parser or migration changes with Gate's format.
    expect(jobSubmissionDigest(engineInput("gate-review-v99:opaque/value")))
      .toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
