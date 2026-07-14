DROP INDEX jobs_lease_expiry_idx;
ALTER TABLE jobs
  DROP COLUMN claim_generation,
  DROP COLUMN lease_owner,
  DROP COLUMN lease_expires_at,
  DROP COLUMN heartbeat_at;
