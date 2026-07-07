"""apature-preference-dataset — verdicts -> owned-judge training data.

Offline, deterministic prep tool: reads the revealed-preference tuples the TS
`judgment-engine` produces and shapes them into KTO/SFT datasets for the owned
judge (#78). See README for the TS<->Python boundary.
"""

from .build import BuildResult, DatasetCard, DpoStats, build, build_dpo, write_outputs
from .reader import load, read_dvc_dir, read_json_array, read_jsonl
from .resolve import (
    ArtifactNotFoundError,
    ArtifactResolver,
    LocalFixtureResolver,
    RemoteArtifactResolver,
    ResolveResult,
    ResolveStats,
    resolve_records,
    write_records,
)
from .schema import Finding, PreferenceExample

__all__ = [
    "PreferenceExample",
    "Finding",
    "build",
    "build_dpo",
    "write_outputs",
    "BuildResult",
    "DatasetCard",
    "DpoStats",
    "load",
    "read_json_array",
    "read_jsonl",
    "read_dvc_dir",
    "ArtifactResolver",
    "LocalFixtureResolver",
    "RemoteArtifactResolver",
    "ArtifactNotFoundError",
    "ResolveResult",
    "ResolveStats",
    "resolve_records",
    "write_records",
]

__version__ = "0.0.1"
