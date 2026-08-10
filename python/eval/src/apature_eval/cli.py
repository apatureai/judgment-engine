"""`apature-eval grade --golden g.json --candidate run.json`: offline scorecard.

Reads a golden-set export and a recorded candidate run (both JSON) and writes the
`Scorecard` as JSON to stdout. No network, no model, no keys.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .candidate import CandidateRun
from .golden import GoldenSet
from .scorecard import grade


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="apature-eval")
    sub = parser.add_subparsers(dest="command", required=True)

    g = sub.add_parser("grade", help="score a candidate run against the golden set")
    g.add_argument("--golden", required=True, help="path to a golden-set JSON export")
    g.add_argument("--candidate", required=True, help="path to a recorded candidate-run JSON")
    g.add_argument(
        "--min-agreement",
        type=int,
        default=2,
        help="raters needed to make a finding ground truth (default 2)",
    )

    args = parser.parse_args(argv)

    golden = GoldenSet.model_validate_json(Path(args.golden).read_text())
    run = CandidateRun.model_validate_json(Path(args.candidate).read_text())
    scorecard = grade(run, golden, min_agreement=args.min_agreement)

    json.dump(scorecard.model_dump(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
