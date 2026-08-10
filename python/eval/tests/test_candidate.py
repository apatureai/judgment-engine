import pytest
from pydantic import ValidationError

from apature_eval.candidate import CandidateFinding, CandidateRun
from apature_eval.golden import finding_key


def test_candidate_finding_ignores_rich_engine_fields():
    # A recorded engine Finding carries confidence/viewport/title/..., and those are
    # dropped, and the match/score fields survive so finding_key still works.
    f = CandidateFinding.model_validate(
        {
            "dimension": "spacing",
            "severity": "minor",
            "route": "/home",
            "elementRef": "#hero",
            "confidence": 0.82,
            "viewport": "desktop",
            "title": "cramped",
        }
    )
    assert finding_key(f) == "spacing|/home|#hero"
    assert not hasattr(f, "confidence")


def test_by_case_indexes_predictions(run: CandidateRun):
    by = run.by_case()
    assert set(by) == {"c1", "c2", "c3", "c4"}
    assert by["c2"].grade == "needs_work"


def test_by_case_rejects_duplicate_case():
    dup = CandidateRun(
        checkpoint="x",
        predictions=[
            {"caseId": "c1", "grade": "ship", "findings": []},
            {"caseId": "c1", "grade": "blocked", "findings": []},
        ],
    )
    with pytest.raises(ValueError):
        dup.by_case()


def test_run_envelope_rejects_unknown_field():
    with pytest.raises(ValidationError):
        CandidateRun.model_validate(
            {"checkpoint": "x", "predictions": [], "bogus": 1}
        )


def test_rejects_unknown_grade():
    with pytest.raises(ValidationError):
        CandidateRun.model_validate(
            {"checkpoint": "x", "predictions": [{"caseId": "c", "grade": "meh", "findings": []}]}
        )
