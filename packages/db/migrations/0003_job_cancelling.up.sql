-- Cooperative cancellation (#66): add an intermediate 'cancelling' status set the
-- moment DELETE /jobs/:id arrives (consumers see intent immediately), before the
-- microVM teardown + inference abort land. The job moves to 'canceled' once
-- finalized. Correctness never depends on the kill landing in time.
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'canceled'));
