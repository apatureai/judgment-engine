"""apature-preference-dataset — verdicts -> owned-judge training data.

Offline, deterministic prep tool: reads the revealed-preference tuples the TS
`judgment-engine` produces and shapes them into KTO/SFT datasets for the owned
judge (#78). See README for the TS<->Python boundary.
"""

from .build import BuildResult, DatasetCard, build, write_outputs
from .reader import load, read_dvc_dir, read_json_array, read_jsonl
from .schema import Finding, PreferenceExample

__all__ = [
    "PreferenceExample",
    "Finding",
    "build",
    "write_outputs",
    "BuildResult",
    "DatasetCard",
    "load",
    "read_json_array",
    "read_jsonl",
    "read_dvc_dir",
]

__version__ = "0.0.1"
