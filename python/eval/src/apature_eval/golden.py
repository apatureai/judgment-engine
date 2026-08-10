"""Typed mirror of the packages/eval golden-set format + the pure derivations
needed to READ it.

This is a *faithful mirror* of the TypeScript source of truth. Do not invent
fields:

  - `packages/eval/src/golden-set.ts`  (`GoldenSet`, `GoldenCase`, `RaterLabel`,
    `LabeledFinding`, `findingKey`, `consensusFindings`)
  - `packages/types/src/findings.ts`   (the enum literal spaces)

The golden set is the 150 human-labeled PR snapshots (TRD §10, #45): per case,
2-3 design-literate raters each give a grade + a list of findings. The offline
batch-grader (`scorecard.py`) scores a candidate checkpoint's recorded outputs
against the *ground truth derived from this format*.

We deliberately port only the format-reading helpers (`finding_key`,
`consensus_findings`) so a golden fixture produced for the TS suite is consumed
byte-for-byte here. We do NOT re-implement the packages/eval statistics
(quadratic-weighted kappa + bootstrap CIs, Krippendorff's alpha, Gwet's AC2,
isotonic calibration, ECE/Brier, the SLO/quality/promotion gates); those stay
owned by `packages/eval`; the scorecard emits the paired grade vectors those
functions consume rather than recomputing them.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict

# --- enum spaces, copied from packages/types/src/findings.ts ------------------

Dimension = Literal[
    "visual_hierarchy",
    "spacing",
    "color_contrast",
    "typography",
    "consistency",
    "responsiveness",
    "accessibility",
    "brand",
]
Severity = Literal["nit", "minor", "major", "blocker"]
Grade = Literal["ship", "ship_with_nits", "needs_work", "blocked"]

# Ordinal scales, mirroring packages/eval (GRADE_SCALE in metrics.ts; SEV_RANK
# in golden-set.ts). Order is meaningful: index is the ordinal position.
GRADE_SCALE: tuple[Grade, ...] = ("ship", "ship_with_nits", "needs_work", "blocked")
SEV_RANK: dict[Severity, int] = {"nit": 0, "minor": 1, "major": 2, "blocker": 3}


# --- golden-set.ts shapes -----------------------------------------------------


class LabeledFinding(BaseModel):
    """Mirrors `LabeledFinding` (golden-set.ts): the ground-truth finding shape.

    Matched to a predicted finding by `finding_key` (dimension+route+elementRef).
    """

    model_config = ConfigDict(extra="forbid")

    dimension: Dimension
    severity: Severity
    route: str
    elementRef: Optional[str] = None


class RaterLabel(BaseModel):
    """Mirrors `RaterLabel`: one rater's grade + findings for a case."""

    model_config = ConfigDict(extra="forbid")

    raterId: str
    grade: Grade
    findings: list[LabeledFinding]


class GoldenCase(BaseModel):
    """Mirrors `GoldenCase`: one PR snapshot with 2-3 raters' labels."""

    model_config = ConfigDict(extra="forbid")

    id: str
    source: Literal["own", "oss"]
    captureRef: Optional[str] = None
    labels: list[RaterLabel]


class GoldenSet(BaseModel):
    """Mirrors `GoldenSet`: the labeling-tool export the TS suite consumes."""

    model_config = ConfigDict(extra="forbid")

    cases: list[GoldenCase]


def finding_key(f: LabeledFinding) -> str:
    """Stable match key, identical to golden-set.ts `findingKey`.

    `${dimension}|${route}|${elementRef ?? ""}`, where an omitted/null elementRef
    collapses to the empty string exactly as the TS side.
    """
    return f"{f.dimension}|{f.route}|{f.elementRef or ''}"


def rater_grades(case: GoldenCase) -> dict[str, Grade]:
    """Per-rater grade map, mirroring golden-set.ts `raterGrades`."""
    return {label.raterId: label.grade for label in case.labels}


def is_usable_for_kappa(case: GoldenCase, min_raters: int = 2) -> bool:
    """A case needs >= `min_raters` distinct raters for inter-rater stats."""
    return len({label.raterId for label in case.labels}) >= min_raters


def consensus_findings(case: GoldenCase, min_agreement: int = 2) -> list[LabeledFinding]:
    """Consensus ground-truth findings, mirroring golden-set.ts `consensusFindings`.

    A finding is ground truth when at least `min_agreement` distinct raters
    labeled it (by `finding_key`); its severity is the MAX any agreeing rater
    assigned. Deterministic: output order follows first-seen key order.
    """
    order: list[str] = []
    by_key: dict[str, dict] = {}
    for label in case.labels:
        for f in label.findings:
            key = finding_key(f)
            entry = by_key.get(key)
            if entry is None:
                entry = {"finding": f, "raters": set(), "severities": []}
                by_key[key] = entry
                order.append(key)
            entry["raters"].add(label.raterId)
            entry["severities"].append(f.severity)

    out: list[LabeledFinding] = []
    for key in order:
        entry = by_key[key]
        if len(entry["raters"]) < min_agreement:
            continue
        max_sev = max(entry["severities"], key=lambda s: SEV_RANK[s])
        base: LabeledFinding = entry["finding"]
        out.append(base.model_copy(update={"severity": max_sev}))
    return out


def consensus_grade(case: GoldenCase) -> Grade:
    """A single human ground-truth grade per case for the scorecard.

    packages/eval keeps grades *per rater* and feeds them pairwise to kappa; it
    never defines one consensus grade. For the offline scorecard's model-vs-human
    agreement we need one, so we take the LOWER-MEDIAN of the raters' grades on
    the ordinal `GRADE_SCALE`, fully deterministic, and the raw per-rater grades
    stay available via `rater_grades` so the TS kappa path is unaffected.
    """
    if not case.labels:
        raise ValueError(f"case {case.id!r} has no rater labels")
    idxs = sorted(GRADE_SCALE.index(label.grade) for label in case.labels)
    lower_median = idxs[(len(idxs) - 1) // 2]
    return GRADE_SCALE[lower_median]
