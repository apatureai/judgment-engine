"""Turn revealed-preference tuples into training-ready artifacts.

The owned judge (#78) is trained on the §8 revealed-preference data. The TS side
(`preference-export.ts`) hands us tuples that already carry BOTH a KTO-style
binary `label` and a `verdict`; this module shapes them into the on-disk forms
the Python fine-tuning stack (TRL / HF `datasets`) consumes, and emits a dataset
card so an ML engineer can read class balance / provenance before a run.

Three views are produced, all derivable 1:1 from the tuples (nothing invented):

  - **KTO** (`kto.jsonl`): every tuple -> `{prompt, completion, label}` where
    label is `desirable`/`undesirable`. Matches `trl.KTOTrainer`'s unpaired
    schema — the exact fit for #85's binary signal.
  - **SFT** (`sft.jsonl`): endorsed tuples only -> `{prompt, completion}`.
    Teaches the judge to surface the findings teams actually accepted.
  - **DPO/ORPO** (`dpo.jsonl`): endorsed-vs-dismissed `{prompt, chosen, rejected}`
    pairs on the *same* rendered UI + repo context. Matches
    `trl.DPOTrainer` / `trl.ORPOTrainer`'s paired schema (#124). See
    `build_dpo` for the pairing rule.

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


# --- DPO/ORPO pairing (#124) --------------------------------------------------
#
# DPO/ORPO wants `{prompt, chosen, rejected}` where the *prompt is identical*
# across the two completions. A pair is only meaningful when the two findings
# were judged on the same evidence, so the pairing key is the shared context:
# the rendered-UI screenshot ref (`imageRef`) AND the repo-context hash
# (`contextHash`). Within one such context an ENDORSED finding is `chosen` and a
# DISMISSED finding is `rejected` — the team's revealed preference between two
# candidate critiques of the *same* screen.
#
# Because the prompt must be byte-identical for chosen and rejected, the DPO
# prompt carries only that shared context (imageRef + contextHash) — NOT the
# per-finding route/viewport that the KTO/SFT `_prompt` includes, which could
# differ between the two findings and break the pairing invariant.


ContextKey = tuple[str, str]


def _dpo_context_key(ex: PreferenceExample) -> ContextKey | None:
    """Shared-context key for pairing, or None when the context is unresolvable.

    Both halves must be present: a pair claims "same rendered UI + same repo
    context", which a missing `imageRef` or `contextHash` cannot certify. Such
    tuples are counted (`skipped_no_context`) rather than paired on a partial key.
    """
    if ex.imageRef is None or ex.contextHash is None:
        return None
    return (ex.imageRef, ex.contextHash)


def _dpo_prompt(key: ContextKey) -> dict[str, Any]:
    image_ref, context_hash = key
    return {"imageRef": image_ref, "contextHash": context_hash}


def to_dpo_row(
    key: ContextKey, chosen: PreferenceExample, rejected: PreferenceExample
) -> dict[str, Any]:
    """One `{prompt, chosen, rejected}` pair for a single shared context."""
    return {
        "prompt": _dpo_prompt(key),
        "chosen": _completion(chosen),
        "rejected": _completion(rejected),
    }


@dataclass
class DpoStats:
    """Provenance for the DPO/ORPO view: how many pairs, and why tuples dropped.

    Units differ by field on purpose: `pairs` counts emitted rows; the
    `*_contexts` fields count distinct (imageRef, contextHash) groups; and
    `skipped_no_context` counts individual tuples that carried no resolvable
    context key (so they never entered a group at all).
    """

    pairs: int = 0
    paired_contexts: int = 0
    skipped_only_endorsed: int = 0
    skipped_only_dismissed: int = 0
    skipped_no_context: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "pairs": self.pairs,
            "paired_contexts": self.paired_contexts,
            "skipped_only_endorsed": self.skipped_only_endorsed,
            "skipped_only_dismissed": self.skipped_only_dismissed,
            "skipped_no_context": self.skipped_no_context,
        }


def build_dpo(
    examples: Iterable[PreferenceExample],
) -> tuple[list[dict[str, Any]], DpoStats]:
    """Pair endorsed vs dismissed findings sharing a rendered-UI + repo context.

    v1 rule (#124): group tuples by `(imageRef, contextHash)`; within each group
    emit the full cross-product of ENDORSED (`chosen`) x DISMISSED (`rejected`)
    findings, so every revealed endorsed>dismissed comparison the team implied on
    that screen becomes a training pair.

    Determinism / tie-breaks: groups are visited in sorted-key order; within a
    group both sides are sorted by `findingId` and paired in nested order
    (each chosen against each rejected). Identical input -> byte-identical output.

    No-pair cases (skipped and counted in `DpoStats`, never silently dropped):
      - a group with only endorsed findings   -> `skipped_only_endorsed`
      - a group with only dismissed findings  -> `skipped_only_dismissed`
      - a tuple with no resolvable context key -> `skipped_no_context`
    """
    groups: dict[ContextKey, list[PreferenceExample]] = {}
    stats = DpoStats()
    for ex in examples:
        key = _dpo_context_key(ex)
        if key is None:
            stats.skipped_no_context += 1
            continue
        groups.setdefault(key, []).append(ex)

    rows: list[dict[str, Any]] = []
    for key in sorted(groups):
        members = groups[key]
        chosen = sorted(
            (e for e in members if e.verdict == "endorsed"), key=lambda e: e.findingId
        )
        rejected = sorted(
            (e for e in members if e.verdict == "dismissed"), key=lambda e: e.findingId
        )
        if not rejected:
            stats.skipped_only_endorsed += 1
            continue
        if not chosen:
            stats.skipped_only_dismissed += 1
            continue
        stats.paired_contexts += 1
        for ch in chosen:
            for rj in rejected:
                rows.append(to_dpo_row(key, ch, rj))
    stats.pairs = len(rows)
    return rows, stats


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
    dpo: dict[str, int] = field(default_factory=dict)

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
            "dpo": self.dpo,
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


def build_card(
    examples: list[PreferenceExample],
    version: str,
    dpo_stats: DpoStats | None = None,
) -> DatasetCard:
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
        dpo=(dpo_stats or DpoStats()).to_dict(),
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
    dpo_rows: list[dict[str, Any]]


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
    dpo_rows, dpo_stats = build_dpo(rows)
    return BuildResult(
        card=build_card(rows, version, dpo_stats),
        kto_rows=kto,
        sft_rows=sft,
        dpo_rows=dpo_rows,
    )


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
    dpo_path = out / "dpo.jsonl"
    card_path = out / "dataset-card.json"
    _write_jsonl(kto_path, result.kto_rows)
    _write_jsonl(sft_path, result.sft_rows)
    _write_jsonl(dpo_path, result.dpo_rows)
    card_path.write_text(
        json.dumps(result.card.to_dict(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {
        "kto": str(kto_path),
        "sft": str(sft_path),
        "dpo": str(dpo_path),
        "card": str(card_path),
    }
