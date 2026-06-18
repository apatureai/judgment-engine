DROP INDEX IF EXISTS jobs_queued_priority_idx;
CREATE INDEX jobs_queued_idx ON jobs (created_at) WHERE status = 'queued';
ALTER TABLE jobs DROP COLUMN priority;
