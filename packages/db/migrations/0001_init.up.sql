-- Baseline migration: shared helpers every later migration builds on.
--
-- A reusable trigger function to maintain `updated_at` columns. Later
-- migrations (jobs #65, findings/feedback #37, model_prompt_registry #71)
-- attach a BEFORE UPDATE trigger that calls this function. Kept dependency-free
-- (no extensions) so it applies identically on Neon and on embedded PGlite in
-- CI; `gen_random_uuid()` is in Postgres core (>=13) and needs no extension.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
