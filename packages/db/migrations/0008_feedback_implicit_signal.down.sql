DELETE FROM feedback WHERE signal = 'merged_blockers_unresolved';
ALTER TABLE feedback DROP CONSTRAINT feedback_signal_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_signal_check
  CHECK (signal IN ('thumbs_up', 'thumbs_down', 'ignore', 'applied', 'recheck'));
