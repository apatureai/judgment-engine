-- In-loop recheck labels (#40): each design_recheck cycle records whether the
-- applied fix resolved the finding — an automatic, dense pre-labeled signal.
ALTER TABLE feedback DROP CONSTRAINT feedback_signal_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_signal_check
  CHECK (signal IN (
    'thumbs_up', 'thumbs_down', 'ignore', 'applied', 'recheck',
    'merged_blockers_unresolved', 'recheck_resolved', 'recheck_unresolved'
  ));
