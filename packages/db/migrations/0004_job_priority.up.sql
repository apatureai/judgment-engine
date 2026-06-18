-- Fair scheduling (#67): a priority column so the claim can serve higher-priority
-- work first (gate-blocking > gate-background > other consumers). Lower = higher.
ALTER TABLE jobs ADD COLUMN priority integer NOT NULL DEFAULT 20;

-- Replace the queued index so the SKIP LOCKED claim orders by (priority, created_at).
DROP INDEX IF EXISTS jobs_queued_idx;
CREATE INDEX jobs_queued_priority_idx ON jobs (priority, created_at) WHERE status = 'queued';
