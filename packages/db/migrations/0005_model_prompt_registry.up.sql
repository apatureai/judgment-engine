-- Model/prompt registry (#71): versions every model/prompt so nothing reaches
-- production without a version bump (#68) + a passing eval gate (#47/#48).
-- Promotion flips status to 'stable'; rollback flips back to the last stable.
CREATE TABLE model_prompt_registry (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  engine_version  text NOT NULL,
  capture_version text NOT NULL,
  status          text NOT NULL DEFAULT 'candidate'
                    CHECK (status IN ('candidate', 'stable', 'rolled_back')),
  eval_passed     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  promoted_at     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER model_prompt_registry_touch
  BEFORE UPDATE ON model_prompt_registry
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- At most one stable version at a time.
CREATE UNIQUE INDEX model_prompt_registry_one_stable
  ON model_prompt_registry (status) WHERE status = 'stable';
