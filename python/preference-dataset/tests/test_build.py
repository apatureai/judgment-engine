import json
from pathlib import Path

from preference_dataset.build import build, dataset_version, write_outputs
from preference_dataset.cli import main
from preference_dataset.reader import load

FIX = Path(__file__).parent / "fixtures"


def _examples():
    return load(FIX / "preference-examples.json")


def test_build_shapes_kto_and_sft():
    res = build(_examples())
    # 3 tuples -> 3 KTO rows; 2 endorsed -> 2 SFT rows.
    assert len(res.kto_rows) == 3
    assert len(res.sft_rows) == 2
    labels = {r["label"] for r in res.kto_rows}
    assert labels == {"desirable", "undesirable"}
    # prompt carries references, not bytes.
    assert set(res.kto_rows[0]["prompt"]) == {"imageRef", "contextHash", "route", "viewport"}


def test_card_counts_and_class_balance():
    card = build(_examples()).card
    assert card.total == 3
    assert card.desirable == 2
    assert card.undesirable == 1
    assert card.training_grade == 2
    assert card.by_dimension["spacing"] == 1
    assert card.by_prompt_version == {"v1": 2, "v2": 1}
    # imbalanced (2:1) -> a desirable down-weight is suggested.
    assert card.kto_weights["desirable"] < 1.0
    assert card.kto_weights["undesirable"] == 1.0


def test_prompt_version_filter():
    res = build(_examples(), prompt_version="v2")
    assert res.card.total == 1
    assert res.kto_rows[0]["prompt"]["route"] == "/about"


def test_training_grade_only_filter():
    res = build(_examples(), training_grade_only=True)
    assert res.card.total == 2  # finding-3 is trainingGrade=False
    assert res.card.training_grade == 2


def test_build_is_deterministic_and_order_independent():
    ex = _examples()
    v1 = dataset_version(ex)
    v2 = dataset_version(list(reversed(ex)))
    assert v1 == v2
    assert build(ex).card.version == build(list(reversed(ex))).card.version


def test_write_outputs_materializes_files(tmp_path):
    res = build(_examples())
    paths = write_outputs(res, tmp_path)
    kto_lines = Path(paths["kto"]).read_text().strip().splitlines()
    assert len(kto_lines) == 3
    assert json.loads(kto_lines[0])["label"] in {"desirable", "undesirable"}
    card = json.loads(Path(paths["card"]).read_text())
    assert card["total"] == 3


def test_cli_build_end_to_end(tmp_path, capsys):
    rc = main(["build", "--input", str(FIX / "preference-examples.json"), "--out", str(tmp_path)])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["dataset"]["total"] == 3
    assert Path(out["paths"]["sft"]).exists()


def test_cli_build_from_dvc_dir(tmp_path, capsys):
    rc = main([
        "build",
        "--dvc-manifest", str(FIX / "dvc" / "manifest.dir.json"),
        "--dvc-cache-root", str(FIX / "dvc"),
        "--out", str(tmp_path),
    ])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["dataset"]["total"] == 2
