-- Defense in depth for caller-owned idempotency keys (#178). New jobs persist
-- an engine-owned digest of immutable submission identity. Existing rows get a
-- reserved all-zero legacy sentinel: without the original canonical request
-- bytes they cannot be safely backfilled, and retries fail closed as
-- mismatches. The default is dropped immediately so every future insert must
-- supply a real digest.
ALTER TABLE jobs
  ADD COLUMN submission_digest text NOT NULL
    DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (submission_digest ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE jobs ALTER COLUMN submission_digest DROP DEFAULT;
