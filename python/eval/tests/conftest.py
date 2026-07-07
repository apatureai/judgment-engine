from pathlib import Path

import pytest

from apature_eval.candidate import CandidateRun
from apature_eval.golden import GoldenSet

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def golden() -> GoldenSet:
    return GoldenSet.model_validate_json((FIXTURES / "golden.json").read_text())


@pytest.fixture
def run() -> CandidateRun:
    return CandidateRun.model_validate_json((FIXTURES / "candidate.json").read_text())
