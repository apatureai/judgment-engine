#!/usr/bin/env node
/**
 * Release-gate CLI (#155): `node dist/release-gate-cli.js <candidate.json>`.
 *
 * Reads a ReleaseCandidateV1 artifact, prints the ReleaseDecisionV1 to stdout
 * (archive it with the version stamp), and exits 0 only when the candidate may
 * be promoted. CI runs this as the promotion gate; exit 1 = blocked (reasons
 * in the decision), exit 2 = malformed input.
 */
import { readFileSync } from "node:fs";
import { parseReleaseCandidate, releaseGate } from "./release-gate.js";

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: release-gate-cli <candidate.json>");
  process.exit(2);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.error(`could not read candidate: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const parsed = parseReleaseCandidate(raw);
if (!parsed.ok) {
  console.error(`malformed candidate: ${parsed.error}`);
  process.exit(2);
}

const decision = releaseGate(parsed.candidate);
console.log(JSON.stringify(decision, null, 2));
if (!decision.promote) {
  console.error(`BLOCKED:\n${decision.reasons.map((r) => `  - ${r}`).join("\n")}`);
  process.exit(1);
}
