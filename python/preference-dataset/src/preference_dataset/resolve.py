"""Hydrate artifact references in preference tuples into multimodal records.

`build.py` deliberately stops at *references*: its KTO/SFT/DPO prompts carry
`imageRef` / `contextHash` strings, not the screenshot pixels or the repo-context
text, because pulling those object-storage artifacts is an ops seam it kept out
to stay a pure, offline transform. This module closes that seam behind a
pluggable `ArtifactResolver` so the fine-tuning stack can consume training-ready
`{prompt, completion, label, image_path, ...}` records where the reference has
been turned into a concrete local artifact.

STRICT v1 SCOPE (safety):

  - The ONLY resolver implemented here is `LocalFixtureResolver`, which maps a
    ref to a file under a local fixture directory. It performs **no network I/O,
    reads no credentials, and commits no secrets** — everything runs against a
    local tree, so the tests need no GPU and no network.
  - The production DVC / Cloudflare-R2 backend is a **documented Protocol stub**
    (`RemoteArtifactResolver`) that raises `NotImplementedError`. Wiring a real
    object-storage client (auth, retry, content-addressed cache — the same remote
    `dvc-export.ts`'s `pushDataset()` writes to) is intentionally out of scope for
    this v1 and is the PR's stated follow-up.

Everything here is deterministic: tuples are visited in sorted `findingId` order,
`image_path` is stored **relative to the resolver root** (portable, not the
machine-specific absolute path), and the same input + same fixture tree always
yields the same records and the same skip counts.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Literal, Protocol, runtime_checkable

from .build import to_kto_row
from .schema import PreferenceExample

# Policy for a tuple whose `imageRef` is set but whose artifact is absent.
OnMissing = Literal["skip", "error"]


class ArtifactNotFoundError(FileNotFoundError):
    """An artifact reference could not be resolved under an `on_missing="error"` policy."""


@runtime_checkable
class ArtifactResolver(Protocol):
    """Maps an opaque artifact reference (an `imageRef` or `contextHash`) to a
    local file.

    Contract:
      - Return the artifact's `Path` when it exists.
      - Return `None` when the reference is well-formed but the artifact is
        absent (the caller applies its `on_missing` policy). Returning `None`
        rather than raising keeps the missing/present decision in one place.

    An implementation MAY raise for a *malformed* reference (e.g. one that tries
    to escape its storage root); that is a corruption signal, not an absence.
    """

    def resolve(self, ref: str) -> Path | None:  # pragma: no cover - protocol
        ...


class LocalFixtureResolver:
    """Resolve refs against a local fixture directory. No network, no credentials.

    A ref is treated as an opaque object key and mapped directly under `root`
    (`root / ref`), mirroring how a content/object store keys its blobs — the
    same string the TS side emits is the storage path. The double slash the TS
    exporter can emit (e.g. ``jobs/job-1/screenshots//pricing-desktop``) collapses
    naturally on the filesystem.

    A ref that resolves outside `root` (e.g. via ``..``) is rejected as malformed
    rather than silently reaching elsewhere on disk.
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def resolve(self, ref: str) -> Path | None:
        root = self.root.resolve()
        candidate = (self.root / ref).resolve()
        if candidate != root and root not in candidate.parents:
            raise ValueError(f"artifact ref {ref!r} escapes fixture root {root}")
        return candidate if candidate.is_file() else None


class RemoteArtifactResolver:
    """DOCUMENTED STUB — the production DVC / R2 backend, deliberately NOT built here.

    A real implementation would pull `imageRef` / `contextHash` objects from the
    DVC remote / Cloudflare-R2 bucket that `packages/feedback/src/dvc-export.ts`
    (`buildDvcDataset()` / `pushDataset()`) writes to, using the object-store
    credentials and a content-addressed local cache. It is left unimplemented so
    this package stays network-free and secret-free in v1 (see the README).

    It exists to pin the interface seam: a future backend implements the same
    `ArtifactResolver` protocol, and `resolve_records` consumes it unchanged.
    Building it is the PR follow-up (likely alongside graduating this package to a
    dedicated judge-trainer repo).
    """

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        raise NotImplementedError(
            "RemoteArtifactResolver (DVC/R2) is a v1 interface stub; use "
            "LocalFixtureResolver. A real object-storage backend is the PR follow-up."
        )

    def resolve(self, ref: str) -> Path | None:  # pragma: no cover - stub
        raise NotImplementedError


@dataclass
class ResolveStats:
    """Provenance for a resolve pass: what hydrated and why tuples dropped.

    Every input tuple lands in exactly one of `resolved` / `skipped_no_ref` /
    `skipped_missing`, so the three always sum to the input count — nothing is
    silently dropped. `context_resolved` is an independent overlay: how many of
    the `resolved` records also had their `contextHash` hydrated to a file.
    """

    resolved: int = 0
    skipped_no_ref: int = 0
    skipped_missing: int = 0
    context_resolved: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            "resolved": self.resolved,
            "skipped_no_ref": self.skipped_no_ref,
            "skipped_missing": self.skipped_missing,
            "context_resolved": self.context_resolved,
        }


@dataclass
class ResolveResult:
    records: list[dict[str, Any]]
    stats: ResolveStats


def resolve_records(
    examples: Iterable[PreferenceExample],
    resolver: ArtifactResolver,
    *,
    on_missing: OnMissing = "skip",
    embed_bytes: bool = False,
) -> ResolveResult:
    """Turn preference tuples into training-ready multimodal records.

    For each tuple (visited in sorted `findingId` order for determinism):

      - `imageRef is None`  -> not a multimodal image record; counted as
        `skipped_no_ref` and dropped.
      - `imageRef` set but the artifact is absent -> `on_missing`:
          * ``"skip"``  (default): counted as `skipped_missing` and dropped.
          * ``"error"``: raise `ArtifactNotFoundError`.
      - otherwise -> emit a record reusing `build.to_kto_row` for the
        prompt/completion/label, plus the hydrated image.

    The `contextHash` reference is hydrated opportunistically: when it is set and
    the resolver finds a matching artifact, the record gains a `context_path`
    (relative to root) and `context_resolved` is incremented. A missing/absent
    context is non-fatal — context can be carried inline in the prompt — so it
    never blocks a record the way a missing image does.

    Image representation:
      - ``embed_bytes=False`` (default): record carries `image_path`, the ref
        relative to the resolver root (JSON-serializable / JSONL-writable).
      - ``embed_bytes=True``: record carries raw `image_bytes` for an in-memory
        loader (HF `datasets`); such records are NOT JSONL-writable (see
        `write_records`).
    """
    # For a relative image_path we need a LocalFixtureResolver root; a generic
    # resolver (e.g. a future remote one) would instead surface absolute/URI
    # paths. v1 only ships the local resolver, so require it for the path form.
    ordered = sorted(examples, key=lambda e: e.findingId)
    stats = ResolveStats()
    records: list[dict[str, Any]] = []

    for ex in ordered:
        if ex.imageRef is None:
            stats.skipped_no_ref += 1
            continue

        image = resolver.resolve(ex.imageRef)
        if image is None:
            if on_missing == "error":
                raise ArtifactNotFoundError(
                    f"artifact missing for {ex.findingId}: imageRef={ex.imageRef!r}"
                )
            stats.skipped_missing += 1
            continue

        record = to_kto_row(ex)  # {prompt, completion, label} — reuse, don't re-shape
        if embed_bytes:
            record["image_bytes"] = image.read_bytes()
        else:
            record["image_path"] = _as_record_path(image, resolver)

        if ex.contextHash is not None:
            context = resolver.resolve(ex.contextHash)
            if context is not None:
                record["context_path"] = _as_record_path(context, resolver)
                stats.context_resolved += 1

        records.append(record)
        stats.resolved += 1

    return ResolveResult(records=records, stats=stats)


def _as_record_path(path: Path, resolver: ArtifactResolver) -> str:
    """A portable, deterministic path for a record.

    For the local resolver we store the ref relative to its root (so the path
    doesn't leak the checkout location and stays reproducible across machines; a
    loader recomposes `root / image_path`). A future non-local resolver would
    surface an absolute path / URI instead.
    """
    if isinstance(resolver, LocalFixtureResolver):
        root = resolver.root.resolve()
        return path.resolve().relative_to(root).as_posix()
    return str(path)  # pragma: no cover - no non-local resolver ships in v1


def write_records(result: ResolveResult, out_dir: str | Path) -> dict[str, str]:
    """Materialize `resolved.jsonl` + `resolve-report.json`. Returns their paths.

    Path-form records only: `image_bytes` (from ``embed_bytes=True``) are not
    JSON-serializable and are for in-memory loaders, so writing them is refused
    with a clear error rather than crashing mid-serialize.
    """
    import json

    from .reader import canonical_json

    if any("image_bytes" in r for r in result.records):
        raise ValueError(
            "cannot write embed_bytes records to JSONL; use the default "
            "image_path form (embed_bytes=False) for on-disk output"
        )

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    records_path = out / "resolved.jsonl"
    report_path = out / "resolve-report.json"
    records_path.write_text(
        "".join(canonical_json(r) + "\n" for r in result.records), encoding="utf-8"
    )
    report_path.write_text(
        json.dumps(result.stats.to_dict(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return {"records": str(records_path), "report": str(report_path)}
