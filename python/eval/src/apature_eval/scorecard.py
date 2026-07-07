"""Offline batch-grader: score a candidate run against the golden set (#125).

Deterministic and pure — no GPU, no network, no time, no RNG. Given a
`CandidateRun` (recorded checkpoint outputs) and a `GoldenSet` (human labels),
it emits a `Scorecard` with:

  * grade agreement  — model grade vs the human consensus grade per case:
    exact/adjacent rates + a confusion matrix, AND the paired grade vectors.
  * detection        — pooled precision/recall (overall + per rubric dimension),
    headline blocker recall, trust-metric nit precision.

BOUNDARY (see golden.py): the counting done here — set-intersection TP/FP/FN and
`prFromCounts` — mirrors `packages/eval/src/metrics.ts` exactly so a fixture
grades identically on both sides. The chance-corrected statistics that package
owns (quadratic-weighted kappa + bootstrap CIs, Krippendorff's alpha, Gwet's
AC2, isotonic calibration, ECE/Brier, the SLO/quality/promotion gates) are NOT
re-implemented; instead the grade agreement block ships the paired
`human_grades`/`model_grades` vectors those estimators consume, so the owned-judge
loop runs kappa/AC2 in one place. Add a real backend by mapping its outputs to a
`CandidateRun` — the grading below does not change.

Pooling: detection counts are summed per case (finding keys are only unique
within a case), never across the whole corpus, so two cases sharing a
route/dimension are never wrongly merged.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel

from .candidate import CandidateFinding, CandidateRun
from .golden import (
    GRADE_SCALE,
    Dimension,
    GoldenSet,
    Grade,
    LabeledFinding,
    consensus_findings,
    consensus_grade,
    finding_key,
)

# A finding for matching is anything carrying the finding_key tuple.
_AnyFinding = LabeledFinding | CandidateFinding


class PrecisionRecall(BaseModel):
    """Detection counts + rates. Mirrors metrics.ts `PrecisionRecall`."""

    precision: float
    recall: float
    tp: int
    fp: int
    fn: int


def _pr(tp: int, fp: int, fn: int) -> PrecisionRecall:
    """Mirror metrics.ts `prFromCounts`: an empty predicted/truth set is 1.0."""
    return PrecisionRecall(
        precision=1.0 if tp + fp == 0 else tp / (tp + fp),
        recall=1.0 if tp + fn == 0 else tp / (tp + fn),
        tp=tp,
        fp=fp,
        fn=fn,
    )


def _keys(findings: list[_AnyFinding]) -> set[str]:
    return {finding_key(f) for f in findings}


def _counts(predicted: list[_AnyFinding], truth: list[_AnyFinding]) -> tuple[int, int, int]:
    """Per-case (tp, fp, fn) by matching finding keys. Mirrors metrics.ts
    `precisionRecall`: keys are set-deduped, severity is NOT part of the key."""
    pred = _keys(predicted)
    true = _keys(truth)
    tp = len(pred & true)
    return tp, len(pred) - tp, len(true) - tp


class GradeAgreement(BaseModel):
    """Model-vs-human consensus grade agreement over the scored cases.

    `confusion[i][j]` counts cases whose HUMAN consensus grade is
    `grade_scale[i]` and MODEL grade is `grade_scale[j]`. `adjacent` counts
    within-one-ordinal-step matches (includes exact). The `*_grades` vectors are
    parallel to `case_ids` and are the input the TS kappa/AC2 estimators consume
    (this module does not compute those chance-corrected coefficients)."""

    n: int
    exact: int
    adjacent: int
    exact_rate: float
    adjacent_rate: float
    grade_scale: list[Grade]
    confusion: list[list[int]]
    case_ids: list[str]
    human_grades: list[Grade]
    model_grades: list[Grade]


class Detection(BaseModel):
    """Finding-detection metrics, pooled over the scored cases."""

    overall: PrecisionRecall
    per_dimension: dict[str, PrecisionRecall]
    blocker_recall: float
    nit_precision: float


class Alignment(BaseModel):
    """Which cases were scored, and the gaps on either side (sorted)."""

    scored: list[str]
    golden_only: list[str]
    candidate_only: list[str]


class Scorecard(BaseModel):
    """The full grade of one checkpoint against one golden set."""

    checkpoint: str
    n_cases: int
    min_agreement: int
    grade_agreement: GradeAgreement
    detection: Detection
    alignment: Alignment


def grade(run: CandidateRun, golden: GoldenSet, min_agreement: int = 2) -> Scorecard:
    """Grade a candidate run against the golden set.

    Cases are aligned by id and scored in sorted-id order (deterministic). Ground
    truth per case is `consensus_findings`/`consensus_grade` at `min_agreement`.
    Cases present on only one side are excluded from metrics and reported under
    `alignment`.
    """
    preds = run.by_case()
    golden_ids = {c.id for c in golden.cases}
    pred_ids = set(preds)

    scored_ids = sorted(golden_ids & pred_ids)
    golden_by_id = {c.id: c for c in golden.cases}

    # --- grade agreement + paired vectors ---
    k = len(GRADE_SCALE)
    confusion = [[0] * k for _ in range(k)]
    case_ids: list[str] = []
    human_grades: list[Grade] = []
    model_grades: list[Grade] = []
    exact = 0
    adjacent = 0

    # --- detection accumulators ---
    tp = fp = fn = 0
    dim_counts: dict[str, list[int]] = {}
    blockers_total = blockers_caught = 0
    nits_total = nits_real = 0

    for cid in scored_ids:
        case = golden_by_id[cid]
        pred = preds[cid]
        truth_findings = consensus_findings(case, min_agreement=min_agreement)

        # grade agreement
        h = consensus_grade(case)
        m = pred.grade
        case_ids.append(cid)
        human_grades.append(h)
        model_grades.append(m)
        hi, mi = GRADE_SCALE.index(h), GRADE_SCALE.index(m)
        confusion[hi][mi] += 1
        if hi == mi:
            exact += 1
        if abs(hi - mi) <= 1:
            adjacent += 1

        # detection: overall
        c_tp, c_fp, c_fn = _counts(pred.findings, truth_findings)
        tp += c_tp
        fp += c_fp
        fn += c_fn

        # detection: per dimension
        dims: set[Dimension] = {f.dimension for f in pred.findings} | {
            f.dimension for f in truth_findings
        }
        for d in dims:
            d_tp, d_fp, d_fn = _counts(
                [f for f in pred.findings if f.dimension == d],
                [f for f in truth_findings if f.dimension == d],
            )
            acc = dim_counts.setdefault(d, [0, 0, 0])
            acc[0] += d_tp
            acc[1] += d_fp
            acc[2] += d_fn

        # headline blocker recall (over ground-truth blockers)
        pred_keys = _keys(pred.findings)
        for f in truth_findings:
            if f.severity == "blocker":
                blockers_total += 1
                if finding_key(f) in pred_keys:
                    blockers_caught += 1

        # trust-metric nit precision (over predicted nits)
        truth_keys = _keys(truth_findings)
        for f in pred.findings:
            if f.severity == "nit":
                nits_total += 1
                if finding_key(f) in truth_keys:
                    nits_real += 1

    n = len(scored_ids)
    agreement = GradeAgreement(
        n=n,
        exact=exact,
        adjacent=adjacent,
        exact_rate=1.0 if n == 0 else exact / n,
        adjacent_rate=1.0 if n == 0 else adjacent / n,
        grade_scale=list(GRADE_SCALE),
        confusion=confusion,
        case_ids=case_ids,
        human_grades=human_grades,
        model_grades=model_grades,
    )

    detection = Detection(
        overall=_pr(tp, fp, fn),
        per_dimension={d: _pr(*counts) for d, counts in sorted(dim_counts.items())},
        blocker_recall=1.0 if blockers_total == 0 else blockers_caught / blockers_total,
        nit_precision=1.0 if nits_total == 0 else nits_real / nits_total,
    )

    alignment = Alignment(
        scored=scored_ids,
        golden_only=sorted(golden_ids - pred_ids),
        candidate_only=sorted(pred_ids - golden_ids),
    )

    return Scorecard(
        checkpoint=run.checkpoint,
        n_cases=n,
        min_agreement=min_agreement,
        grade_agreement=agreement,
        detection=detection,
        alignment=alignment,
    )
