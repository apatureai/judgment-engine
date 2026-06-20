-- Rater identity on feedback (#38): needed for "latest signal per (finding, rater)
-- wins". Nullable because implicit signals (#39) have no human rater.
ALTER TABLE feedback ADD COLUMN rater_id text;
CREATE INDEX feedback_finding_rater_idx ON feedback (finding_id, rater_id);
