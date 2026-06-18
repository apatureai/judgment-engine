-- Async job store (TRD §3; architecture review E1). Postgres is the source of
-- truth for job status/metadata; results live in object storage (result_pointer).
-- Redis is token-buckets/quotas only — never the job store.
CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer        text NOT NULL,
  installation_id text NOT NULL,
  intent_type     text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  depth           text NOT NULL CHECK (depth IN ('triage', 'deep')),
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  input           jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_pointer  text,
  error           text,
  attempts        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

-- Partial index over only queued rows keeps the SKIP LOCKED claim cheap.
CREATE INDEX jobs_queued_idx ON jobs (created_at) WHERE status = 'queued';
CREATE INDEX jobs_installation_idx ON jobs (installation_id);

CREATE TRIGGER jobs_touch_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Wake listening workers on enqueue (LISTEN engine_jobs) so they claim on
-- demand instead of busy-polling.
CREATE OR REPLACE FUNCTION notify_new_job() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('engine_jobs', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_notify_new
  AFTER INSERT ON jobs
  FOR EACH ROW WHEN (NEW.status = 'queued')
  EXECUTE FUNCTION notify_new_job();
