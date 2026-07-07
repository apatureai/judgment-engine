"""Readers for the three shapes the TS side can hand us.

1. A flat JSON array — exactly what `exportPreferenceDataset()` returns when
   dumped with `JSON.stringify`.
2. JSONL — one `PreferenceExample` per line (streaming-friendly for large sets).
3. A DVC dataset directory — the content-addressed layout produced by
   `buildDvcDataset()` / `pushDataset()` in `packages/feedback/src/dvc-export.ts`:
   a `.dir` manifest of `{md5, relpath}` plus cache objects at
   `files/md5/<aa>/<rest>`. We resolve the manifest, load each object, and
   verify its md5 (the same integrity check `pullDataset()` performs).

`canonical_json` reproduces `dvc-export.ts`'s `canonicalJson`: keys sorted at
every level, compact separators, UTF-8 (no ASCII escaping) — so md5s match
byte-for-byte across the boundary.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable, Iterator

from .schema import PreferenceExample


def canonical_json(value: Any) -> str:
    """Deterministic JSON matching dvc-export.ts `canonicalJson`.

    sorted keys at every level, `(",", ":")` separators, non-ASCII passed
    through (JS `JSON.stringify` does not escape it).
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def md5hex(content: str) -> str:
    return hashlib.md5(content.encode("utf-8")).hexdigest()


def dvc_content(ex: PreferenceExample) -> dict[str, Any]:
    """The exact field set `dvc-export.ts` serializes for one tuple.

    Mirrors `buildDvcDataset`'s `canonicalJson(ex)`: every field is kept with its
    value — the nullable refs (`imageRef`/`contextHash`/`elementRef`) stay present
    as `null` — EXCEPT `source`. The TS `PreferenceExample` always carries
    `source`, but the DVC-export test factory omits it, and schema.py relaxes it
    to Optional so *both* shapes parse. To reproduce the TS content address, a
    tuple whose `source` was omitted must hash *without* a `source` key (#127);
    a tuple that carried one hashes *with* it. A blanket `exclude_none` would be
    wrong here — it would also drop the null refs the TS side keeps, diverging the
    md5 for any source-omitted tuple that also has a null ref.
    """
    data = ex.model_dump()
    if ex.source is None:
        data.pop("source", None)
    return data


def dvc_object_md5(ex: PreferenceExample) -> str:
    """DVC content address (cache-object md5) of one tuple.

    Byte-identical to the per-tuple `md5(canonicalJson(ex))` that
    `buildDvcDataset` in `dvc-export.ts` computes, so a Python-recomputed address
    matches the id the TS side stored (dedup and the `.dir` version depend on it).
    """
    return md5hex(canonical_json(dvc_content(ex)))


def dvc_cache_path(md5: str) -> str:
    """Remote/cache path DVC stores an object at — mirrors `dvcCachePath`."""
    if md5.endswith(".dir"):
        hex_, suffix = md5[:-4], ".dir"
    else:
        hex_, suffix = md5, ""
    return f"files/md5/{hex_[:2]}/{hex_[2:]}{suffix}"


def _parse_many(raw: Iterable[dict]) -> list[PreferenceExample]:
    return [PreferenceExample.model_validate(r) for r in raw]


def read_json_array(path: Path) -> list[PreferenceExample]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"{path}: expected a JSON array of preference tuples")
    return _parse_many(data)


def read_jsonl(path: Path) -> list[PreferenceExample]:
    out: list[PreferenceExample] = []
    for i, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(PreferenceExample.model_validate(json.loads(line)))
        except Exception as exc:  # noqa: BLE001 - re-raise with line context
            raise ValueError(f"{path}:{i}: {exc}") from exc
    return out


def read_dvc_dir(manifest: Path, cache_root: Path) -> list[PreferenceExample]:
    """Resolve a DVC `.dir` manifest against a cache tree, verifying integrity.

    `manifest` is a JSON `[{md5, relpath}, ...]` listing (the `.dir` object's
    content). `cache_root` is the directory that contains `files/md5/...`.
    """
    entries = json.loads(Path(manifest).read_text(encoding="utf-8"))
    out: list[PreferenceExample] = []
    for entry in entries:
        obj_path = Path(cache_root) / dvc_cache_path(entry["md5"])
        if not obj_path.exists():
            raise FileNotFoundError(
                f"dvc object missing for {entry['relpath']} ({entry['md5']})"
            )
        content = obj_path.read_text(encoding="utf-8")
        if md5hex(content) != entry["md5"]:
            raise ValueError(f"dvc object integrity mismatch for {entry['relpath']}")
        out.append(PreferenceExample.model_validate(json.loads(content)))
    return out


def load(path: str | Path) -> list[PreferenceExample]:
    """Dispatch on extension: `.jsonl` -> JSONL, else a JSON array.

    For a DVC dataset call `read_dvc_dir` directly (it needs two paths).
    """
    p = Path(path)
    if p.suffix == ".jsonl":
        return read_jsonl(p)
    return read_json_array(p)


def iter_dedup(examples: Iterable[PreferenceExample]) -> Iterator[PreferenceExample]:
    """Content-dedup identical tuples (same behaviour as the DVC layer)."""
    seen: set[str] = set()
    for ex in examples:
        h = dvc_object_md5(ex)
        if h in seen:
            continue
        seen.add(h)
        yield ex
