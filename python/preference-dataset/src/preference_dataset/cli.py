"""`python -m preference_dataset build ...` — offline dataset prep.

Reads the TS-produced preference tuples (flat JSON, JSONL, or a DVC dataset dir)
and writes KTO/SFT JSONL + a dataset card. No network, no model, no keys.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .build import build, write_outputs
from .reader import load, read_dvc_dir


def _load_examples(args: argparse.Namespace):
    if args.dvc_manifest:
        return read_dvc_dir(Path(args.dvc_manifest), Path(args.dvc_cache_root))
    if not args.input:
        raise SystemExit("error: --input is required (or use --dvc-manifest)")
    return load(args.input)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="preference_dataset")
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="build KTO/SFT datasets from preference tuples")
    b.add_argument("--input", help="path to a JSON array or .jsonl of tuples")
    b.add_argument("--dvc-manifest", help="path to a DVC `.dir` manifest JSON")
    b.add_argument(
        "--dvc-cache-root",
        help="root dir containing files/md5/... (with --dvc-manifest)",
    )
    b.add_argument("--out", required=True, help="output directory")
    b.add_argument("--prompt-version", help="keep only tuples of this prompt version")
    b.add_argument(
        "--training-grade-only",
        action="store_true",
        help="keep only collaborator (owner/write) verdicts",
    )

    args = parser.parse_args(argv)

    examples = _load_examples(args)
    result = build(
        examples,
        prompt_version=args.prompt_version,
        training_grade_only=args.training_grade_only,
    )
    paths = write_outputs(result, args.out)

    json.dump(
        {"dataset": result.card.to_dict(), "paths": paths},
        sys.stdout,
        indent=2,
        sort_keys=True,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
