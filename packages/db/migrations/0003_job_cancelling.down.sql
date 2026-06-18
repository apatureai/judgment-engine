-- Revert any in-flight cancelling rows so the narrower constraint re-applies.
UPDATE jobs SET status = 'canceled' WHERE status = 'cancelling';
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled'));
