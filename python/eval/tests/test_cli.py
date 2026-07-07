import json

from apature_eval.cli import main

from conftest import FIXTURES


def test_grade_cli_emits_scorecard_json(capsys):
    rc = main(
        [
            "grade",
            "--golden",
            str(FIXTURES / "golden.json"),
            "--candidate",
            str(FIXTURES / "candidate.json"),
        ]
    )
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["checkpoint"] == "cand-ckpt-1"
    assert out["n_cases"] == 3
    assert out["detection"]["overall"]["tp"] == 3
    assert out["alignment"]["golden_only"] == ["c5"]


def test_grade_cli_honors_min_agreement(capsys):
    rc = main(
        [
            "grade",
            "--golden",
            str(FIXTURES / "golden.json"),
            "--candidate",
            str(FIXTURES / "candidate.json"),
            "--min-agreement",
            "3",
        ]
    )
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["min_agreement"] == 3
    assert out["detection"]["overall"]["tp"] == 1
    assert out["detection"]["overall"]["fp"] == 4
