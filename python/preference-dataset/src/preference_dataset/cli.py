"""`python -m preference_dataset build|resolve ...`: offline dataset prep.

`build` reads the TS-produced preference tuples (flat JSON, JSONL, or a DVC
dataset dir) and writes KTO/SFT/DPO JSONL + a dataset card. `resolve` hydrates
the `imageRef` / `contextHash` references in those tuples into training-ready
multimodal records against a LOCAL fixture directory. No network, no model, no
keys in either path.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .build import build, write_outputs
from .reader import load, read_dvc_dir
from .resolve import LocalFixtureResolver, resolve_records, write_records


def _load_examples(args: argparse.Namespace):
    if args.dvc_manifest:
        return read_dvc_dir(Path(args.dvc_manifest), Path(args.dvc_cache_root))
    if not args.input:
        raise SystemExit("error: --input is required (or use --dvc-manifest)")
    return load(args.input)


def _add_input_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--input", help="path to a JSON array or .jsonl of tuples")
    p.add_argument("--dvc-manifest", help="path to a DVC `.dir` manifest JSON")
    p.add_argument(
        "--dvc-cache-root",
        help="root dir containing files/md5/... (with --dvc-manifest)",
    )


def _run_build(args: argparse.Namespace) -> int:
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


def _run_resolve(args: argparse.Namespace) -> int:
    examples = _load_examples(args)
    resolver = LocalFixtureResolver(args.fixture_root)
    result = resolve_records(examples, resolver, on_missing=args.on_missing)
    paths = write_records(result, args.out)

    json.dump(
        {"resolve": result.stats.to_dict(), "paths": paths},
        sys.stdout,
        indent=2,
        sort_keys=True,
    )
    sys.stdout.write("\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="preference_dataset")
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="build KTO/SFT datasets from preference tuples")
    _add_input_args(b)
    b.add_argument("--out", required=True, help="output directory")
    b.add_argument("--prompt-version", help="keep only tuples of this prompt version")
    b.add_argument(
        "--training-grade-only",
        action="store_true",
        help="keep only collaborator (owner/write) verdicts",
    )

    r = sub.add_parser(
        "resolve",
        help="hydrate imageRef/contextHash refs into multimodal records "
        "(local fixture dir only)",
    )
    _add_input_args(r)
    r.add_argument("--out", required=True, help="output directory")
    r.add_argument(
        "--fixture-root",
        required=True,
        help="local directory that holds the artifacts refs map into",
    )
    r.add_argument(
        "--on-missing",
        choices=("skip", "error"),
        default="skip",
        help="policy when an imageRef artifact is absent (default: skip+count)",
    )

    args = parser.parse_args(argv)

    if args.command == "resolve":
        return _run_resolve(args)
    return _run_build(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
