"""Scorecard math, asserted against hand-computed expected values.

Ground truth for the fixture (min_agreement=2), scored cases c1,c2,c3:

  detection (pooled): tp=3 fp=2 fn=1 -> precision 0.6, recall 0.75
    per-dim: spacing tp1/fp1/fn1, consistency fp1, accessibility tp1, typography tp1
    blocker_recall 1.0 (1 truth blocker, caught), nit_precision 0.5 (2 pred nits, 1 real)
  grade agreement: c1 exact, c2 adjacent, c3 exact -> exact 2/3, adjacent 3/3
  alignment: golden-only c5, candidate-only c4
"""

import pytest

from apature_eval.scorecard import grade


def test_alignment(run, golden):
    sc = grade(run, golden)
    assert sc.checkpoint == "cand-ckpt-1"
    assert sc.n_cases == 3
    assert sc.alignment.scored == ["c1", "c2", "c3"]
    assert sc.alignment.golden_only == ["c5"]
    assert sc.alignment.candidate_only == ["c4"]


def test_overall_detection(run, golden):
    d = grade(run, golden).detection.overall
    assert (d.tp, d.fp, d.fn) == (3, 2, 1)
    assert d.precision == pytest.approx(0.6)
    assert d.recall == pytest.approx(0.75)


def test_per_dimension_detection(run, golden):
    per = grade(run, golden).detection.per_dimension
    assert set(per) == {"spacing", "consistency", "accessibility", "typography"}

    assert (per["spacing"].tp, per["spacing"].fp, per["spacing"].fn) == (1, 1, 1)
    assert per["spacing"].precision == pytest.approx(0.5)
    assert per["spacing"].recall == pytest.approx(0.5)

    # consistency: one false positive, no ground truth -> recall vacuously 1.0.
    assert (per["consistency"].tp, per["consistency"].fp, per["consistency"].fn) == (0, 1, 0)
    assert per["consistency"].precision == pytest.approx(0.0)
    assert per["consistency"].recall == pytest.approx(1.0)

    assert (per["accessibility"].tp, per["accessibility"].fp, per["accessibility"].fn) == (1, 0, 0)
    assert per["accessibility"].precision == pytest.approx(1.0)
    assert (per["typography"].tp, per["typography"].fp, per["typography"].fn) == (1, 0, 0)


def test_headline_metrics(run, golden):
    d = grade(run, golden).detection
    assert d.blocker_recall == pytest.approx(1.0)
    assert d.nit_precision == pytest.approx(0.5)


def test_grade_agreement_rates(run, golden):
    ga = grade(run, golden).grade_agreement
    assert ga.n == 3
    assert ga.exact == 2
    assert ga.adjacent == 3
    assert ga.exact_rate == pytest.approx(2 / 3)
    assert ga.adjacent_rate == pytest.approx(1.0)


def test_grade_agreement_paired_vectors_for_ts_kappa(run, golden):
    ga = grade(run, golden).grade_agreement
    # Parallel, sorted by case id: this is what the TS kappa/AC2 path consumes.
    assert ga.case_ids == ["c1", "c2", "c3"]
    assert ga.human_grades == ["needs_work", "blocked", "ship"]
    assert ga.model_grades == ["needs_work", "needs_work", "ship"]


def test_confusion_matrix_orientation(run, golden):
    ga = grade(run, golden).grade_agreement
    # rows = human consensus grade, cols = model grade; GRADE_SCALE order.
    assert ga.grade_scale == ["ship", "ship_with_nits", "needs_work", "blocked"]
    assert ga.confusion == [
        [1, 0, 0, 0],  # ship (c3)
        [0, 0, 0, 0],
        [0, 0, 1, 0],  # needs_work (c1)
        [0, 0, 1, 0],  # blocked (c2), model said needs_work
    ]
    # every scored case lands in exactly one cell
    assert sum(sum(row) for row in ga.confusion) == 3


def test_min_agreement_three_changes_ground_truth(run, golden):
    # At min_agreement=3 only c2's accessibility finding remains ground truth;
    # c1/c3 lose all consensus findings, and c2 loses its spacing FN.
    sc = grade(run, golden, min_agreement=3)
    assert sc.min_agreement == 3
    d = sc.detection.overall
    # truth = {c2 accessibility}. preds unchanged.
    # c1: pred{spacing,consistency} vs {} -> fp2. c2: {accessibility} matches -> tp1.
    # c3: pred{typography,spacing} vs {} -> fp2.
    assert (d.tp, d.fp, d.fn) == (1, 4, 0)


def test_deterministic_repeated_runs(run, golden):
    assert grade(run, golden).model_dump() == grade(run, golden).model_dump()


def test_empty_alignment_is_vacuous(golden):
    from apature_eval.candidate import CandidateRun

    empty = CandidateRun(checkpoint="none", predictions=[])
    sc = grade(empty, golden)
    assert sc.n_cases == 0
    assert sc.grade_agreement.exact_rate == 1.0
    assert sc.grade_agreement.adjacent_rate == 1.0
    assert sc.detection.overall.precision == 1.0
    assert sc.detection.blocker_recall == 1.0
    assert sc.detection.nit_precision == 1.0
    assert sc.alignment.scored == []
    assert sc.alignment.candidate_only == []
