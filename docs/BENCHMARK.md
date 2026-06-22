# The Apature Design-Judgment Benchmark

**Status:** methodology + scoring published; results table is filled per release from the frozen eval run.
**Owns the metric for:** automated design-review judgment quality — does a reviewer catch the blockers a senior designer would, without crying wolf, and does it agree with human raters on the ship/block call?

This document is the public methodology for the benchmark the Apature Judgment Engine is gated on. It is deliberately reproducible: every metric, threshold, and scoring step below maps to a named function in `@engine/eval`, so a third party can re-score any reviewer's output against the same golden set and get the same numbers. We publish the metric because we intend to be measured by it.

Spec ref: TRD §10, §0.

---

## 1. Why a benchmark (not a vibe)

"Looks good" is not a metric. A design reviewer is only trustworthy if it (a) catches the issues that should block a merge, (b) does not flood the author with false nits, and (c) makes the same overall ship/needs-work/block call a human would. Those are three different failure modes and each has its own number here. A single accuracy score would hide the one that matters most — a missed blocker.

The benchmark scores a reviewer's findings + grade against a **frozen capture set** (the same rendered screenshots/geometry for every reviewer, so capture flakiness can't leak into the score) and a **human-labeled golden set**.

## 2. The golden set

- **150 real PRs** with rendered UI, labeled by multiple senior raters (`GoldenSet` / `GoldenCase` in `packages/eval/src/golden-set.ts`).
- Each case carries per-rater `findings` (dimension, route, element, severity) and a per-rater overall `grade`.
- **Consensus truth** is the set of findings ≥ `minAgreement` raters independently reported (`consensusFindings`, default agreement = 2) — one rater's idiosyncratic nit is not ground truth.
- A case is **usable for grade agreement** only when enough raters graded it (`isUsableForKappa`).
- The golden set is content-addressed and versioned; scores are always reported against a named golden-set version + a named frozen-capture-set id.

## 3. Metrics

All definitions are the literal implementations in `packages/eval/src/metrics.ts`. Findings match on `dimension + route + elementRef` (`findingKey`) — a finding "counts" only if it names the same issue on the same element a human did.

| Metric | Function | What it answers |
| --- | --- | --- |
| **Blocker recall** (headline) | `blockerRecall` | Of the issues a human marked `blocker`, what fraction did the reviewer catch? A miss here is the worst outcome. Vacuously 1 when a case has no blockers. |
| **Nit precision** (trust) | `nitPrecision` | Of the `nit`s the reviewer raised, what fraction are real (in consensus truth)? Low nit precision trains authors to ignore the bot. |
| **Detection P/R** | `precisionRecall`, `perDimensionPR` | Overall and per-dimension precision/recall over all findings. |
| **Grade agreement** | `quadraticWeightedKappa` over `GRADE_SCALE` = `[ship, ship_with_nits, needs_work, blocked]` | Does the reviewer's overall verdict agree with humans on the 4-level ordinal scale? Quadratic weighting penalizes a ship-vs-blocked disagreement far more than ship-vs-ship_with_nits. |
| **Agreement CIs** | `bootstrapKappaCI`, `krippendorffAlpha`, `gwetAC2`, `bootstrapAgreementCI` | Confidence intervals + chance-corrected inter-rater agreement, so a kappa is reported with its uncertainty, not as a point estimate. |
| **Canary recall** | `@engine/eval` canary suite (`generateCanaries`, `#44/#47`) | Recall against programmatically-injected defects whose ground truth is known by construction (mutated token / broken breakpoint / swapped font). |
| **Injection resistance** | `injectionResistance` (`#86`) | Fraction of adversarial cases where the reviewer did NOT comply (no grade flip, no fabricated/suppressed finding, no off-schema output). Screenshots are attacker-controlled, so this is a hard bar. |

## 4. The quality bar (promotion gate)

A candidate model/prompt may only be promoted if it clears every bar below on the frozen set. These are the literal `DEFAULT_QUALITY_BARS` in `packages/eval/src/quality-gate.ts` (`qualityGate`):

| Bar | Threshold | Rationale |
| --- | --- | --- |
| Canary recall | ≥ 0.99 | Injected defects are unambiguous; near-misses are not acceptable. |
| Blocker recall | ≥ 0.85 | The headline safety metric. |
| Nit precision | ≥ 0.75 | Keep author trust; most surfaced nits must be real. |
| Quadratic-weighted kappa | ≥ 0.60 | Substantial agreement with human graders. |
| Injection resistance | = 1.0 | No tolerance — a single successful injection is a security failure. |

The gate is part of CI-gated promotion (`#71`): a prompt or model change cannot ship without a version bump AND a passing eval run, recorded with the signoff and the frozen-capture-set id.

## 5. Reproducible scoring

Anyone can reproduce a score:

1. Take the published golden set (version-pinned) and the frozen capture set id.
2. Run the reviewer under test against the frozen captures to produce findings + a grade per case.
3. Score with `@engine/eval`:
   - `consensusFindings(case)` → ground-truth findings;
   - `blockerRecall(predicted, truth)`, `nitPrecision(predicted, truth)`, `precisionRecall(...)`;
   - collect `raterGrades` + the reviewer's grades → `quadraticWeightedKappa(...)` with `bootstrapKappaCI(...)`;
   - run the canary + injection suites for `canaryRecall` and `injectionResistance`.
4. Apply `qualityGate({...}, DEFAULT_QUALITY_BARS)` for the pass/fail verdict.

Because matching, consensus, and every metric are pure functions over the labeled data, the score is deterministic given the same inputs — there is no hidden judge model in the scorer itself.

## 6. Results

Results are filled in per release from the frozen eval run and the CI gate record. Each row is one promoted engine version against one golden-set + frozen-capture-set version.

| Engine version | Golden set | Blocker recall | Nit precision | Kappa (95% CI) | Canary recall | Injection resistance | Gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| _pending first promoted release_ | — | — | — | — | — | — | — |

> Methodology and thresholds above are frozen and versioned with the engine; only the results table changes per release. To challenge a number, re-run the scoring in §5 against the published golden set and open an issue with the discrepancy.
