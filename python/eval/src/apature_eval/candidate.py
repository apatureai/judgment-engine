"""Recorded candidate-output schema for the offline batch-grader (#125).

A *candidate run* is the set of critiques a judge checkpoint produced over the
golden-set snapshots, recorded to disk so the scorecard can grade it later with
no GPU/network. The real producer is the owned judge (§16) served over
vLLM/DashScope; this package never calls it. To plug a live backend in later,
write a small adapter that maps its output to `CandidateRun` and feed the same
`scorecard.grade(...)`.

Only the fields the grader needs to MATCH and SCORE findings are modeled
(`dimension`, `severity`, `route`, `elementRef` — the `finding_key` tuple — plus
the per-case `grade`). The engine's wire `Finding` (packages/types/src/findings.ts)
carries more (`confidence`, `viewport`, `title`, `description`, ...); a recorded
run may include those verbatim, so `CandidateFinding` is lenient (`extra="ignore"`)
and drops them rather than failing validation. The per-run/per-case envelopes stay
`extra="forbid"` so a structural drift there still surfaces loudly.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict

from .golden import Dimension, Grade, Severity


class CandidateFinding(BaseModel):
    """One predicted finding. Matched to ground truth by `golden.finding_key`.

    Lenient on extra fields so a recorded engine `Finding` (with `confidence`,
    `viewport`, `title`, ...) feeds straight in; only the match/score fields are
    read.
    """

    model_config = ConfigDict(extra="ignore")

    dimension: Dimension
    severity: Severity
    route: str
    elementRef: Optional[str] = None


class CandidatePrediction(BaseModel):
    """The checkpoint's critique for one golden case: a grade + its findings."""

    model_config = ConfigDict(extra="forbid")

    caseId: str
    grade: Grade
    findings: list[CandidateFinding] = []


class CandidateRun(BaseModel):
    """A whole checkpoint's recorded outputs over the golden set.

    `checkpoint` is the model/checkpoint id under test (stamped onto the
    scorecard). `predictions` need not cover every golden case — the scorecard
    aligns on case id and reports any gap on either side.
    """

    model_config = ConfigDict(extra="forbid")

    checkpoint: str
    predictions: list[CandidatePrediction]

    def by_case(self) -> dict[str, CandidatePrediction]:
        """Case-id -> prediction. Raises on a duplicate `caseId` (ambiguous run)."""
        out: dict[str, CandidatePrediction] = {}
        for p in self.predictions:
            if p.caseId in out:
                raise ValueError(f"duplicate prediction for case {p.caseId!r}")
            out[p.caseId] = p
        return out
