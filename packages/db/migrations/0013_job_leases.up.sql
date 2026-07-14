-- Durable worker leases + claim-generation fencing (#166). A `running` row was
-- previously owned only by the process that claimed it; a worker crash after
-- claim stranded the job in `running` forever (and the idempotency key kept
-- resolving to the stranded job). Claims now carry a fencing generation and an
-- expiring lease that a live worker heartbeats; a reaper requeues or fails
-- expired attempts, and every finalization is conditional on the generation.
ALTER TABLE jobs
  ADD COLUMN claim_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN lease_owner      text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN heartbeat_at     timestamptz;

-- The reaper scans only leased non-terminal rows; keep that scan cheap.
CREATE INDEX jobs_lease_expiry_idx ON jobs (lease_expires_at)
  WHERE status IN ('running', 'cancelling');
