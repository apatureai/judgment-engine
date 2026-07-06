import json
from pathlib import Path

import pytest

from preference_dataset.reader import (
    canonical_json,
    dvc_cache_path,
    iter_dedup,
    load,
    md5hex,
    read_dvc_dir,
    read_jsonl,
)

FIX = Path(__file__).parent / "fixtures"


def test_canonical_json_matches_dvc_export_ts_shape():
    # sorted keys, compact separators, no ASCII escaping.
    assert canonical_json({"b": 1, "a": [2, {"d": 4, "c": 3}]}) == '{"a":[2,{"c":3,"d":4}],"b":1}'
    assert canonical_json({"s": "é"}) == '{"s":"é"}'


def test_dvc_cache_path_splits_head_and_keeps_dir_suffix():
    assert dvc_cache_path("abcd" + "0" * 28) == "files/md5/ab/cd" + "0" * 28
    assert dvc_cache_path("abcd" + "0" * 28 + ".dir") == "files/md5/ab/cd" + "0" * 28 + ".dir"


def test_read_json_array_fixture():
    examples = load(FIX / "preference-examples.json")
    assert len(examples) == 3
    assert examples[0].findingId == "finding-1"
    assert examples[1].label == "undesirable"


def test_read_jsonl_roundtrip(tmp_path):
    src = load(FIX / "preference-examples.json")
    p = tmp_path / "t.jsonl"
    p.write_text("".join(canonical_json(e.model_dump()) + "\n" for e in src), encoding="utf-8")
    back = read_jsonl(p)
    assert [e.findingId for e in back] == [e.findingId for e in src]


def test_read_dvc_dir_resolves_and_verifies_integrity():
    examples = read_dvc_dir(FIX / "dvc" / "manifest.dir.json", FIX / "dvc")
    assert {e.findingId for e in examples} == {"a", "b"}


def test_read_dvc_dir_detects_corruption(tmp_path):
    # Copy the fixture, then tamper with one cache object -> integrity failure.
    manifest = json.loads((FIX / "dvc" / "manifest.dir.json").read_text())
    root = tmp_path / "dvc"
    for entry in manifest:
        src = (FIX / "dvc" / dvc_cache_path(entry["md5"]))
        dst = root / dvc_cache_path(entry["md5"])
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    m = root / "manifest.dir.json"
    m.write_text(json.dumps(manifest), encoding="utf-8")
    # tamper
    tampered = root / dvc_cache_path(manifest[0]["md5"])
    tampered.write_text(tampered.read_text() + " ", encoding="utf-8")
    with pytest.raises(ValueError, match="integrity mismatch"):
        read_dvc_dir(m, root)


def test_iter_dedup_collapses_identical_tuples():
    src = load(FIX / "preference-examples.json")
    doubled = src + src
    assert len(list(iter_dedup(doubled))) == len(src)


def test_md5_roundtrip_self_consistent():
    obj = {"z": 1, "a": {"c": 2, "b": 3}}
    assert md5hex(canonical_json(obj)) == md5hex(canonical_json(obj))
