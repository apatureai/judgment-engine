import pytest
from pydantic import ValidationError

from apature_eval.golden import (
    GoldenSet,
    consensus_findings,
    consensus_grade,
    finding_key,
    is_usable_for_kappa,
    rater_grades,
)


def test_parses_fixture(golden: GoldenSet):
    assert [c.id for c in golden.cases] == ["c1", "c2", "c3", "c5"]


def test_finding_key_matches_ts_format(golden: GoldenSet):
    # spacing/checkout with null elementRef collapses the elementRef to "".
    spacing = [f for f in golden.cases[1].labels[0].findings if f.dimension == "spacing"][0]
    assert finding_key(spacing) == "spacing|/checkout|"


def test_consensus_findings_needs_two_raters_and_takes_max_severity(golden: GoldenSet):
    # c1: only spacing|/home|#hero is labeled by both raters; severity = max(minor, major).
    truth = consensus_findings(golden.cases[0])
    assert [(f.dimension, f.severity, finding_key(f)) for f in truth] == [
        ("spacing", "major", "spacing|/home|#hero"),
    ]


def test_consensus_findings_three_raters_max_severity(golden: GoldenSet):
    # c2: accessibility blocker (3 raters, max sev blocker) + spacing minor (2 raters).
    truth = consensus_findings(golden.cases[1])
    assert {finding_key(f): f.severity for f in truth} == {
        "accessibility|/checkout|#pay": "blocker",
        "spacing|/checkout|": "minor",
    }


def test_consensus_grade_lower_median(golden: GoldenSet):
    assert consensus_grade(golden.cases[0]) == "needs_work"  # [needs_work, needs_work]
    assert consensus_grade(golden.cases[1]) == "blocked"  # [needs_work, blocked, blocked]
    assert consensus_grade(golden.cases[2]) == "ship"  # [ship, ship_with_nits]


def test_rater_grades_and_usable(golden: GoldenSet):
    assert rater_grades(golden.cases[1]) == {"r1": "blocked", "r2": "blocked", "r3": "needs_work"}
    assert is_usable_for_kappa(golden.cases[0]) is True


def test_min_agreement_three_drops_two_rater_consensus(golden: GoldenSet):
    # Raising the bar to 3 leaves c2 with only the 3-rater accessibility finding.
    truth = consensus_findings(golden.cases[1], min_agreement=3)
    assert [finding_key(f) for f in truth] == ["accessibility|/checkout|#pay"]


def test_rejects_unknown_dimension_schema_drift_guard():
    bad = {
        "cases": [
            {
                "id": "x",
                "source": "own",
                "labels": [
                    {"raterId": "r1", "grade": "ship", "findings": [
                        {"dimension": "vibes", "severity": "nit", "route": "/", "elementRef": None}
                    ]}
                ],
            }
        ]
    }
    with pytest.raises(ValidationError):
        GoldenSet.model_validate(bad)


def test_consensus_grade_empty_labels_raises():
    from apature_eval.golden import GoldenCase

    case = GoldenCase(id="e", source="own", labels=[])
    with pytest.raises(ValueError):
        consensus_grade(case)
