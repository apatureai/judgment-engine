# Release: promotion and rollback (#155)

How a (model, prompt, engine, capture, rubric) candidate becomes the serving
triplet, and how to get back to the previous one. The gate logic lives in
`@engine/eval` (`releaseGate` / `release-gate-cli`); the durable promotion
record is `ModelPromptRegistry` (Postgres, migration 0005).

## Promotion flow

1. **Batch eval on the frozen set.** Run the candidate through the offline
   eval (`python/eval` batch grading + `@engine/eval` metrics) against the
   current frozen capture set. Produce a `ReleaseCandidateV1` JSON artifact:
   version stamp, quality-gate inputs (canary predictions, blocker recall, nit
   precision, kappa, injection canaries), SLO counts, and — for blocking mode —
   the bound `CalibrationReportV1`.
2. **Run the gate.**
   `node packages/eval/dist/release-gate-cli.js <candidate.json>`
   Exit 0 = eligible; exit 1 = blocked (reasons listed); exit 2 = malformed
   artifact. Archive the printed `ReleaseDecisionV1` next to the candidate —
   the decision is deterministic, so an audit replay of the same artifact
   yields the same verdict.
3. **Record the promotion.** On a passing decision:
   `registerCandidate(stamp)` → `recordEval(id, true)` →
   (blocking only) `bindCalibrationReport(id, report)` → `promote(id, { mode })`.
   The registry re-enforces the blocking prerequisites (report present, valid,
   identity-matched, attestation policy) — the CLI gate decides eligibility,
   the registry is the durable record; both must agree.
4. **Deploy.** The production composition root (`buildProductionRuntime`)
   reads the promoted triplet via `ModelPromptRegistry`; ship the image and
   verify `/readyz` + one staging smoke (submit → poll → result) before
   promoting traffic.

## Blocking-mode guard (E11 / core#168 step 4)

Blocking mode cannot ship on quality bars alone. The gate additionally
requires a calibration report that is: present, `sufficient_evidence`,
unexpired, identity-matched to the exact candidate stamp, and whose blocker
false-positive rate clears the declared false-block target at the interval's
**upper** bound. Until such a report exists, candidates promote as advisory
only — Gate stays in advisory language (core#184 standing rule).

## CI enforcement

The `release gate` CI job runs the CLI against two checked-in artifacts on
every build: `fixtures/release/passing.advisory.json` must promote and
`fixtures/release/regressed.blocked.json` (a deliberate golden-set regression)
must be blocked. The vitest suite (`release-gate.test.ts`) covers the full
guard matrix. A change that lets the regressed fixture through fails CI — the
#155 acceptance criterion.

## Rollback

The previous promoted triplet stays deployable at all times:

- **Registry:** promotion never deletes prior entries. One-command revert:
  re-run `promote(<previous-candidate-id>, { mode })` — the registry's
  monotonic `promoted_at` makes the newest promotion the serving one, and the
  previous entry already carries its passed eval + bound calibration.
- **Image:** deploy the previous image tag (images are version-stamped and
  retained). No data migration accompanies a triplet change by design; the
  jobs schema is independent of the serving model.
- **Verification:** after revert, confirm `/readyz`, one smoke review, and
  that result version stamps show the reverted triplet.

## Staging smoke (human-owned, remaining #155 scope)

Staging environment (Postgres/Redis/object store/DashScope or self-host
endpoint) + a recorded smoke driving one review job through the async API,
plus the #166 chaos legs (kill worker during capture and during inference).
Tracked as the ops half of #155; this document's flow is exercised there
before first production promotion.
