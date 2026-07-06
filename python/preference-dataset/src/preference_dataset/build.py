"""Turn revealed-preference tuples into training-ready artifacts.

The owned judge (#78) is trained on the §8 revealed-preference data. The TS side
(`preference-export.ts`) hands us tuples that already carry BOTH a KTO-style
binary `label` and a `verdict`; this module shapes them into the on-disk forms
the Python fine-tuning stack (TRL / HF `datasets`) consumes, and emits a dataset
card so an ML engineer can read class balance / provenance before a run.

Two views are produced, both derivable 1:1 from the tuples (nothing invented):

  - **KTO** (`kto.jsonl`): every tuple -> `{prompt, completion, label}` where
    label is `desirable`/`undesirable`. Matches `trl.KTOTrainer`'s unpaired
    schema — the exact fit for #85's binary signal.
  - **SFT** (`sft.jsonl`): endorsed tuples only -> `{prompt, completion}`.
    Teaches the judge to surface the findings teams actually accepted.

The `prompt` carries the *references* to the screenshot artifact + context hash
(imageRef / contextHash), not the bytes: resolving those object-storage
artifacts into pixels/text is an ops seam (DVC / R2), deliberately out of scope
so this stays a pure, deterministic, offline transform.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .reader import canonical_json, md5hex
from .schema import PreferenceExample


def _prompt(ex: PreferenceExample) -> dict[str, Any]:
    """The model-facing context for a finding — references, not bytes."""
    return {
        "imageRef": ex.imageRef,
        "contextHash": ex.contextHash,
        "route": ex.finding.route,
        "viewport": ex.finding.viewport,
    }


def _completion(ex: PreferenceExample) -> dict[str, Any]:
    """The finding the judge did (or should have) produced."""
    return ex.finding.model_dump()


def to_kto_row(ex: PreferenceExample) -> dict[str, Any]:
    return {"prompt": _prompt(ex), "completion": _completion(ex), "label": ex.label}


def to_sft_row(ex: PreferenceExample) -> dict[str, Any]:
    return {"prompt": _prompt(ex), "completion": _completion(ex)}


@dataclass
class DatasetCard:
    """Human/CI-readable summary of a built dataset (a `datasets`-style card)."""

    version: str
    total: int
    desirable: int
    undesirable: int
    training_grade: int
    by_prompt_version: dict[str, int] = field(default_factory=dict)
    by_dimension: dict[str, int] = field(default_factory=dict)
    by_severity: dict[str, int] = field(default_factory=dict)
    by_source: dict[str, int] = field(default_factory=dict)
    kto_weights: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "total": self.total,
            "desirable": self.desirable,
            "undesirable": self.undesirable,
            "training_grade": self.training_grade,
            "by_prompt_version": self.by_prompt_version,
            "by_dimension": self.by_dimension,
            "by_severity": self.by_severity,
            "by_source": self.by_source,
            "kto_weights": self.kto_weights,
        }


def _kto_weights(desirable: int, undesirable: int) -> dict[str, float]:
    """Suggested TRL KTO desirable/undesirable weights.

    TRL recommends weights so that
      (n_desirable * w_desirable) / (n_undesirable * w_undesirable) in [1, 4/3].
    We hold one weight at 1.0 and scale the majority class down to hit the
    midpoint (7/6) of that band. Returns `{}` when either class is empty.
    """
    if desirable == 0 or undesirable == 0:
        return {}
    target = 7 / 6  # midpoint of [1, 4/3]
    # ratio = (d * w_d) / (u * w_u); start w_d = w_u = 1, adjust the majority.
    ratio = desirable / undesirable
    if ratio > target:  # too many desirable -> down-weight desirable
        return {"desirable": round(target / ratio, 4), "undesirable": 1.0}
    if (undesirable / desirable) > target:  # too many undesirable
        return {"desirable": 1.0, "undesirable": round(target * ratio, 4)}
    return {"desirable": 1.0, "undesirable": 1.0}


def build_card(examples: list[PreferenceExample], version: str) -> DatasetCard:
    desirable = sum(1 for e in examples if e.label == "desirable")
    undesirable = len(examples) - desirable
    return DatasetCard(
        version=version,
        total=len(examples),
        desirable=desirable,
        undesirable=undesirable,
        training_grade=sum(1 for e in examples if e.trainingGrade),
        by_prompt_version=dict(Counter(e.promptVersion for e in examples)),
        by_dimension=dict(Counter(e.finding.dimension for e in examples)),
        by_severity=dict(Counter(e.finding.severity for e in examples)),
        by_source=dict(Counter(e.source or "unknown" for e in examples)),
        kto_weights=_kto_weights(desirable, undesirable),
    )


def dataset_version(examples: Iterable[PreferenceExample]) -> str:
    """A DVC-style content address for the whole built set (reproducible)."""
    listing = sorted(
        md5hex(canonical_json(e.model_dump(exclude_none=False))) for e in examples
    )
    return f"{md5hex(canonical_json(listing))}.dir"


@dataclass
class BuildResult:
    card: DatasetCard
    kto_rows: list[dict[str, Any]]
    sft_rows: list[dict[str, Any]]


def build(
    examples: list[PreferenceExample],
    *,
    prompt_version: str | None = None,
    training_grade_only: bool = False,
) -> BuildResult:
    """Filter + shape tuples into KTO/SFT rows and a dataset card.

    Deterministic: rows are sorted by findingId so a given input always yields
    byte-identical output (point-in-time reproducible, like the DVC layer).
    """
    rows = examples
    if prompt_version is not None:
        rows = [e for e in rows if e.promptVersion == prompt_version]
    if training_grade_only:
        rows = [e for e in rows if e.trainingGrade]
    rows = sorted(rows, key=lambda e: e.findingId)

    version = dataset_version(rows)
    kto = [to_kto_row(e) for e in rows]
    sft = [to_sft_row(e) for e in rows if e.verdict == "endorsed"]
    return BuildResult(card=build_card(rows, version), kto_rows=kto, sft_rows=sft)


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(canonical_json(r) + "\n" for r in rows), encoding="utf-8"
    )


def write_outputs(result: BuildResult, out_dir: str | Path) -> dict[str, str]:
    """Materialize kto.jsonl, sft.jsonl, and dataset-card.json. Returns paths."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    kto_path = out / "kto.jsonl"
    sft_path = out / "sft.jsonl"
    card_path = out / "dataset-card.json"
    _write_jsonl(kto_path, result.kto_rows)
    _write_jsonl(sft_path, result.sft_rows)
    card_path.write_text(
        json.dumps(result.card.to_dict(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {
        "kto": str(kto_path),
        "sft": str(sft_path),
        "card": str(card_path),
    }
