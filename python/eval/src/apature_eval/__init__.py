"""apature-eval — offline batch-grader for the owned judge (#125).

Deterministic, fixture-driven scoring of a recorded judge-checkpoint run against
the human-labeled golden set. Pure Python: no GPU, no network, no model call. It
is the eval half of the owned-judge loop (§16); the preference-dataset package is
the training half.

Format boundary (see `golden.py`): the golden-set shape and finding-detection
counting mirror `packages/eval` (TypeScript) so a fixture grades identically on
both sides. The chance-corrected agreement statistics (kappa/AC2/alpha, calibration,
gates) stay owned by `packages/eval`; the scorecard emits the paired grade vectors
those estimators consume.
"""

from .candidate import CandidateFinding, CandidatePrediction, CandidateRun
from .golden import (
    GoldenCase,
    GoldenSet,
    LabeledFinding,
    RaterLabel,
    consensus_findings,
    consensus_grade,
    finding_key,
    rater_grades,
)
from .scorecard import (
    Alignment,
    Detection,
    GradeAgreement,
    PrecisionRecall,
    Scorecard,
    grade,
)

__all__ = [
    "GoldenSet",
    "GoldenCase",
    "RaterLabel",
    "LabeledFinding",
    "finding_key",
    "consensus_findings",
    "consensus_grade",
    "rater_grades",
    "CandidateRun",
    "CandidatePrediction",
    "CandidateFinding",
    "grade",
    "Scorecard",
    "GradeAgreement",
    "Detection",
    "PrecisionRecall",
    "Alignment",
]

__version__ = "0.0.1"
