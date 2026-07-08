import json
from pathlib import Path

from preference_dataset.build import (
    _relpath_for,
    _relpath_sort_key,
    build,
    build_dpo,
    dataset_version,
    write_outputs,
)
from preference_dataset.cli import main
from preference_dataset.reader import (
    canonical_json,
    dvc_object_md5,
    load,
    md5hex,
    read_dvc_dir,
)

FIX = Path(__file__).parent / "fixtures"
DVC = FIX / "dvc"


def _examples():
    return load(FIX / "preference-examples.json")


def _dpo_examples():
    return load(FIX / "dpo-examples.json")


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


# --- DVC content-address reproduction (#127) ----------------------------------
#
# The `fixtures/dvc/` tree is real `buildDvcDataset()` output; BOTH tuples omit
# `source` (the DVC-export test-factory shape). A Python-recomputed content
# address must equal the TS side's — previously `dataset_version`/`iter_dedup`
# re-hashed `exclude_none=False`, injecting `source:null` and diverging the id.


def test_dvc_object_md5_matches_ts_content_address_for_source_omitted():
    examples = read_dvc_dir(DVC / "manifest.dir.json", DVC)
    assert any(e.source is None for e in examples), "fixture must be source-omitted"
    want = {e["relpath"]: e["md5"] for e in json.loads((DVC / "manifest.dir.json").read_text())}
    for ex in examples:
        relpath = f"{ex.promptVersion}/{ex.findingId}.json"
        assert dvc_object_md5(ex) == want[relpath], relpath


def test_card_version_equals_ts_dvc_id_for_source_omitted_fixture():
    examples = read_dvc_dir(DVC / "manifest.dir.json", DVC)
    ts_dvc_version = (DVC / "VERSION").read_text().strip()
    # The whole-set content address (the TS `.dir` id) is reproduced byte-for-byte.
    assert dataset_version(examples) == ts_dvc_version
    assert build(examples).card.version == ts_dvc_version


def test_build_is_deterministic_and_order_independent():
    ex = _examples()
    v1 = dataset_version(ex)
    v2 = dataset_version(list(reversed(ex)))
    assert v1 == v2
    assert build(ex).card.version == build(list(reversed(ex))).card.version


# --- non-ASCII `.dir` relpath ordering (#133) ---------------------------------
#
# dvc-export.ts and this package both sort `.dir` listings by raw UTF-8 bytes of
# `relpath`, not locale collation. This is the DVC contract, and keeps dataset
# versions stable across Python, Node, host locales, and ICU versions.


def test_relpath_sort_key_uses_canonical_utf8_byte_order():
    relpaths = [
        "v1/cafe.json", "v1/café.json", "v1/cafz.json",
        "v1/Apple.json", "v1/apple.json",
        "v1/naïve.json", "v1/naive.json",
        "v1/résumé.json", "v1/resume.json",
        "v1/a-b.json", "v1/ab.json", "v1/a_b.json", "v1/a@b.json", "v1/a.b.json",
        "v1/finding-2.json", "v1/finding-10.json", "v1/finding_1.json", "v1/finding.1.json",
        "v1/βeta.json", "v1/中.json", "v1/あ.json", "v1/я.json",
    ]
    utf8_order = [
        "v1/Apple.json",
        "v1/a-b.json", "v1/a.b.json", "v1/a@b.json", "v1/a_b.json", "v1/ab.json",
        "v1/apple.json",
        "v1/cafe.json", "v1/cafz.json", "v1/café.json",
        "v1/finding-10.json", "v1/finding-2.json", "v1/finding.1.json", "v1/finding_1.json",
        "v1/naive.json", "v1/naïve.json",
        "v1/resume.json", "v1/résumé.json",
        "v1/βeta.json", "v1/я.json", "v1/あ.json", "v1/中.json",
    ]
    assert sorted(relpaths, key=_relpath_sort_key) == utf8_order


def test_dataset_version_sorts_dir_by_utf8_byte_order_not_locale():
    base = _examples()[0]
    examples = [
        base.model_copy(update={"findingId": fid})
        for fid in ("cafe", "café", "cafz", "apple", "Apple", "a-b", "a_b")
    ]
    entries = [{"md5": dvc_object_md5(e), "relpath": _relpath_for(e)} for e in examples]
    byte_order_id = f'{md5hex(canonical_json(sorted(entries, key=lambda x: _relpath_sort_key(x["relpath"]))))}.dir'
    locale_like_id = f'{md5hex(canonical_json(sorted(entries, key=lambda x: x["relpath"].casefold())))}.dir'

    assert byte_order_id != locale_like_id  # locale-style ordering would diverge
    assert dataset_version(examples) == byte_order_id  # conforms to the DVC contract
    assert dataset_version(examples) != locale_like_id
    # order-independent, like the rest of the DVC layer.
    assert dataset_version(list(reversed(examples))) == byte_order_id


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


# --- DPO/ORPO pairing (#124) --------------------------------------------------
#
# The dpo-examples fixture is built to exercise every branch of build_dpo:
#   (img-a, ctx-a): 2 endorsed x 2 dismissed  -> 4 pairs, 1 paired context
#   (img-b, ctx-b): endorsed only             -> skipped_only_endorsed
#   (img-c, ctx-c): dismissed only            -> skipped_only_dismissed
#   (null,  null ): no context key            -> skipped_no_context
#   (img-x, null ): half-missing context key  -> skipped_no_context


def test_dpo_pairs_cross_product_on_shared_context():
    rows, stats = build_dpo(_dpo_examples())
    # 2 endorsed x 2 dismissed on the single fully-paired context.
    assert stats.pairs == 4
    assert len(rows) == 4
    assert stats.paired_contexts == 1
    # every emitted pair shares the one paired context, and the prompt carries
    # ONLY that shared context (no per-finding route/viewport that could differ).
    for r in rows:
        assert r["prompt"] == {"imageRef": "img-a", "contextHash": "ctx-a"}


def test_dpo_skip_cases_are_counted_not_dropped():
    _, stats = build_dpo(_dpo_examples())
    assert stats.skipped_only_endorsed == 1   # (img-b, ctx-b)
    assert stats.skipped_only_dismissed == 1  # (img-c, ctx-c)
    assert stats.skipped_no_context == 2      # (null,null) and (img-x, null)


def test_dpo_chosen_and_rejected_drawn_from_correct_verdict_sides():
    examples = _dpo_examples()
    rows, _ = build_dpo(examples)
    endorsed = [e.finding.model_dump() for e in examples if e.verdict == "endorsed"]
    dismissed = [e.finding.model_dump() for e in examples if e.verdict == "dismissed"]
    for r in rows:
        assert r["chosen"] in endorsed
        assert r["rejected"] in dismissed
        assert r["chosen"] not in dismissed
        assert r["rejected"] not in endorsed


def test_dpo_is_deterministic_and_order_independent():
    examples = _dpo_examples()
    rows_a, stats_a = build_dpo(examples)
    rows_b, stats_b = build_dpo(list(reversed(examples)))
    # byte-identical rows (order and content) regardless of input order.
    assert rows_a == rows_b
    assert stats_a.to_dict() == stats_b.to_dict()


def test_dpo_empty_input_yields_no_pairs():
    rows, stats = build_dpo([])
    assert rows == []
    assert stats.to_dict() == {
        "pairs": 0,
        "paired_contexts": 0,
        "skipped_only_endorsed": 0,
        "skipped_only_dismissed": 0,
        "skipped_no_context": 0,
    }


def test_build_card_reports_dpo_stats():
    res = build(_dpo_examples())
    assert res.card.dpo["pairs"] == 4
    assert res.card.dpo["paired_contexts"] == 1
    assert res.card.dpo["skipped_no_context"] == 2
    assert len(res.dpo_rows) == 4


def test_write_outputs_materializes_dpo_jsonl(tmp_path):
    res = build(_dpo_examples())
    paths = write_outputs(res, tmp_path)
    dpo_lines = Path(paths["dpo"]).read_text().strip().splitlines()
    assert len(dpo_lines) == 4
    row = json.loads(dpo_lines[0])
    assert set(row) == {"prompt", "chosen", "rejected"}
    assert set(row["prompt"]) == {"imageRef", "contextHash"}


def test_cli_build_reports_dpo_in_card(tmp_path, capsys):
    rc = main(["build", "--input", str(FIX / "dpo-examples.json"), "--out", str(tmp_path)])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["dataset"]["dpo"]["pairs"] == 4
    assert Path(out["paths"]["dpo"]).exists()
