# apature-eval

Offline **batch-grader** for the owned judge (issue #125). Given a recorded
judge-checkpoint run and the human-labeled golden set, it emits a **scorecard**
(grade agreement + per-dimension detection metrics). Pure Python: **no GPU, no
network, no model call**, fully deterministic — it grades outputs that were
recorded earlier.

This is the *eval* half of the owned-judge loop; `python/preference-dataset` is
the *training* half.

## The TS ⇄ Python boundary

`packages/eval` (TypeScript) is the source of truth for the golden-set format and
the metric math. This package deliberately does **not** duplicate the hard
statistics it owns — quadratic-weighted kappa + bootstrap CIs, Krippendorff's
alpha, Gwet's AC2, isotonic calibration, ECE/Brier, and the SLO / quality /
promotion gates.

What it *does* mirror, so a fixture grades identically on both sides:

- the golden-set shapes and format-reading helpers — `finding_key`,
  `consensusFindings`, `raterGrades` (`golden.py`, mirroring
  `packages/eval/src/golden-set.ts` + `packages/types/src/findings.ts`);
- the basic finding-detection counting — set-intersection TP/FP/FN and the
  `prFromCounts` empty-set convention (`scorecard.py`, mirroring
  `packages/eval/src/metrics.ts`).

For grade agreement the scorecard reports exact/adjacent rates and a confusion
matrix, and **emits the paired `human_grades` / `model_grades` vectors** that the
TS chance-corrected estimators consume — it does not compute kappa/AC2 here.

## Golden format consumed

The labeling-tool export `packages/eval` already produces (`GoldenSet`):

```json
{
  "cases": [
    {
      "id": "c1",
      "source": "own",
      "captureRef": "cap://c1",
      "labels": [
        { "raterId": "r1", "grade": "needs_work",
          "findings": [
            { "dimension": "spacing", "severity": "minor", "route": "/home", "elementRef": "#hero" }
          ] }
      ]
    }
  ]
}
```

Ground truth per case is derived exactly as on the TS side: a finding is truth
when ≥ `min-agreement` (default 2) raters labeled it by `finding_key`
(`dimension|route|elementRef`), taking the **max** severity any agreeing rater
assigned. The per-case human grade is the raters' **lower median** on the ordinal
grade scale (the raw per-rater grades stay available via `raterGrades` for the TS
kappa path).

## Candidate-run format

What a checkpoint produced, recorded to disk (`CandidateRun`):

```json
{
  "checkpoint": "cand-ckpt-1",
  "predictions": [
    { "caseId": "c1", "grade": "needs_work",
      "findings": [
        { "dimension": "spacing", "severity": "minor", "route": "/home", "elementRef": "#hero" }
      ] }
  ]
}
```

A recorded engine `Finding` may carry extra fields (`confidence`, `viewport`,
`title`, …); they are ignored. Predictions need not cover every golden case — the
scorecard aligns by id and reports any gap under `alignment`.

## Use

```bash
apature-eval grade --golden golden.json --candidate run.json [--min-agreement 2]
```

Prints the scorecard as JSON. Or from Python:

```python
from apature_eval import grade, GoldenSet, CandidateRun

sc = grade(run, golden)                # -> Scorecard
sc.detection.blocker_recall            # headline metric
sc.grade_agreement.human_grades        # paired vector for the TS kappa/AC2 path
```

## Plugging in a real backend later

The grader consumes *recorded* outputs, so a live judge (vLLM / DashScope)
plugs in with a thin adapter that maps its critique output to `CandidateRun`;
`grade(...)` is unchanged and the tests keep running on fixtures.

## Dev

```bash
pip install -e '.[dev]'
pytest
```
