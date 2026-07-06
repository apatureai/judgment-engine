import pytest
from pydantic import ValidationError

from preference_dataset.schema import PreferenceExample

BASE = {
    "findingId": "f1",
    "installationId": "inst-1",
    "promptVersion": "v1",
    "imageRef": None,
    "contextHash": None,
    "finding": {
        "dimension": "spacing",
        "severity": "minor",
        "route": "/home",
        "viewport": "desktop",
        "elementRef": None,
    },
    "verdict": "endorsed",
    "label": "desirable",
    "trainingGrade": True,
}


def test_parses_full_tuple_with_source():
    ex = PreferenceExample.model_validate({**BASE, "source": "thumbs"})
    assert ex.source == "thumbs"
    assert ex.finding.dimension == "spacing"


def test_source_optional_matches_dvc_factory_shape():
    ex = PreferenceExample.model_validate(BASE)  # no `source`
    assert ex.source is None


def test_rejects_unknown_dimension_schema_drift_guard():
    bad = {**BASE, "finding": {**BASE["finding"], "dimension": "vibes"}}
    with pytest.raises(ValidationError):
        PreferenceExample.model_validate(bad)


def test_rejects_verdict_label_mismatch():
    bad = {**BASE, "verdict": "endorsed", "label": "undesirable"}
    with pytest.raises(ValidationError):
        PreferenceExample.model_validate(bad)


def test_rejects_extra_field():
    with pytest.raises(ValidationError):
        PreferenceExample.model_validate({**BASE, "surprise": 1})
