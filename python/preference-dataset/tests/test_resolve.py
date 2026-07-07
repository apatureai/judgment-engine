import json
from pathlib import Path

import pytest

from preference_dataset.cli import main
from preference_dataset.reader import load
from preference_dataset.resolve import (
    ArtifactNotFoundError,
    ArtifactResolver,
    LocalFixtureResolver,
    RemoteArtifactResolver,
    resolve_records,
    write_records,
)

FIX = Path(__file__).parent / "fixtures"
ARTIFACTS = FIX / "artifacts"


def _examples():
    return load(FIX / "preference-examples.json")


def _dpo_examples():
    return load(FIX / "dpo-examples.json")


def _resolver():
    return LocalFixtureResolver(ARTIFACTS)


# --- LocalFixtureResolver -----------------------------------------------------


def test_resolver_maps_ref_to_local_file():
    # the double-slash the TS exporter emits collapses on the filesystem.
    p = _resolver().resolve("jobs/job-1/screenshots//pricing-desktop")
    assert p is not None and p.is_file()
    assert p.name == "pricing-desktop"


def test_resolver_returns_none_for_absent_artifact():
    assert _resolver().resolve("jobs/job-2/screenshots//home-mobile") is None


def test_resolver_rejects_ref_escaping_root():
    with pytest.raises(ValueError, match="escapes fixture root"):
        _resolver().resolve("../../../etc/passwd")


def test_local_resolver_satisfies_protocol():
    # structural typing: the fixture resolver is a valid ArtifactResolver.
    assert isinstance(_resolver(), ArtifactResolver)


# --- resolve_records: policy + records ---------------------------------------


def test_resolve_skips_missing_and_no_ref_by_default():
    # preference-examples: finding-1 resolves, finding-2 image missing,
    # finding-3 imageRef is null.
    res = resolve_records(_examples(), _resolver())
    assert res.stats.resolved == 1
    assert res.stats.skipped_missing == 1
    assert res.stats.skipped_no_ref == 1
    # the three buckets account for every input tuple.
    total = (
        res.stats.resolved + res.stats.skipped_missing + res.stats.skipped_no_ref
    )
    assert total == len(_examples())
    assert len(res.records) == 1


def test_resolved_record_shape_reuses_kto_row_and_adds_image():
    res = resolve_records(_examples(), _resolver())
    rec = res.records[0]
    # prompt/completion/label are the reused build.to_kto_row shape...
    assert set(rec) >= {"prompt", "completion", "label", "image_path"}
    assert set(rec["prompt"]) == {"imageRef", "contextHash", "route", "viewport"}
    assert rec["label"] in {"desirable", "undesirable"}
    # ...plus a root-relative, portable image path that actually exists.
    assert rec["image_path"] == "jobs/job-1/screenshots/pricing-desktop"
    assert (ARTIFACTS / rec["image_path"]).is_file()


def test_context_hash_hydrated_when_artifact_present():
    res = resolve_records(_examples(), _resolver())
    rec = res.records[0]  # finding-1, contextHash=ctx-abc (present)
    assert rec["context_path"] == "ctx-abc"
    assert res.stats.context_resolved == 1


def test_on_missing_error_raises_with_finding_context():
    with pytest.raises(ArtifactNotFoundError, match="finding-2"):
        resolve_records(_examples(), _resolver(), on_missing="error")


def test_embed_bytes_carries_real_image_bytes():
    res = resolve_records(_examples(), _resolver(), embed_bytes=True)
    rec = res.records[0]
    assert "image_path" not in rec
    assert isinstance(rec["image_bytes"], bytes)
    assert rec["image_bytes"].startswith(b"\x89PNG\r\n")


def test_resolve_is_deterministic_and_order_independent():
    ex = _examples()
    a = resolve_records(ex, _resolver())
    b = resolve_records(list(reversed(ex)), _resolver())
    assert a.records == b.records
    assert a.stats.to_dict() == b.stats.to_dict()


def test_resolve_over_dpo_fixture_counts():
    # dpo-examples: img-a(x4)/img-b/img-c present, img-x missing, one null ref.
    res = resolve_records(_dpo_examples(), _resolver())
    assert res.stats.resolved == 6
    assert res.stats.skipped_missing == 1  # img-x
    assert res.stats.skipped_no_ref == 1   # fn-1 (null imageRef)
    assert res.stats.context_resolved == 6


# --- write_records ------------------------------------------------------------


def test_write_records_materializes_jsonl_and_report(tmp_path):
    res = resolve_records(_examples(), _resolver())
    paths = write_records(res, tmp_path)
    lines = Path(paths["records"]).read_text().strip().splitlines()
    assert len(lines) == 1
    row = json.loads(lines[0])
    assert row["image_path"] == "jobs/job-1/screenshots/pricing-desktop"
    report = json.loads(Path(paths["report"]).read_text())
    assert report["resolved"] == 1
    assert report["skipped_missing"] == 1


def test_write_records_refuses_embed_bytes(tmp_path):
    res = resolve_records(_examples(), _resolver(), embed_bytes=True)
    with pytest.raises(ValueError, match="embed_bytes"):
        write_records(res, tmp_path)


# --- RemoteArtifactResolver is a documented, unimplemented stub ---------------


def test_remote_resolver_is_stub_only():
    with pytest.raises(NotImplementedError):
        RemoteArtifactResolver("s3://bucket")


# --- CLI ----------------------------------------------------------------------


def test_cli_resolve_end_to_end(tmp_path, capsys):
    rc = main([
        "resolve",
        "--input", str(FIX / "preference-examples.json"),
        "--fixture-root", str(ARTIFACTS),
        "--out", str(tmp_path),
    ])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["resolve"]["resolved"] == 1
    assert out["resolve"]["skipped_missing"] == 1
    assert Path(out["paths"]["records"]).exists()


def test_cli_resolve_on_missing_error(tmp_path):
    with pytest.raises(ArtifactNotFoundError):
        main([
            "resolve",
            "--input", str(FIX / "preference-examples.json"),
            "--fixture-root", str(ARTIFACTS),
            "--out", str(tmp_path),
            "--on-missing", "error",
        ])
