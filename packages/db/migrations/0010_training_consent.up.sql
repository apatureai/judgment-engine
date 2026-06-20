-- Per-tenant training consent (#74). Screenshots are PII; cross-tenant training
-- inclusion is gated behind an explicit opt-in (default off). Non-consenting
-- tenants' data is still usable for per-repo memory (#41), never cross-tenant.
CREATE TABLE tenant_training_consent (
  installation_id text PRIMARY KEY,
  consent         boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tenant_training_consent_touch
  BEFORE UPDATE ON tenant_training_consent
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
