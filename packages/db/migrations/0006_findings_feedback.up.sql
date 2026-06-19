-- Findings + feedback schema (TRD §8, #37). The durable record of every emitted
-- finding (version-stamped) and the feedback signals on it (explicit thumbs /
-- ignore #38, implicit accept #39, recheck #40), carrying rater_permission for
-- the down-weighting in #42. Indexed for the preference-export queries (#43),
-- which are versioned by prompt_version.
CREATE TABLE findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid,
  installation_id text NOT NULL,
  route           text NOT NULL,
  viewport        text NOT NULL CHECK (viewport IN ('mobile', 'tablet', 'desktop')),
  dimension       text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('nit', 'minor', 'major', 'blocker')),
  confidence      real NOT NULL,
  element_ref     text,
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  engine_version  text NOT NULL,
  capture_version text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id      uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  signal          text NOT NULL CHECK (signal IN ('thumbs_up', 'thumbs_down', 'ignore', 'applied', 'recheck')),
  source          text NOT NULL CHECK (source IN ('explicit', 'implicit')),
  -- Permission of the rater whose signal this is (for #42 down-weighting).
  rater_permission text NOT NULL CHECK (rater_permission IN ('owner', 'write', 'read', 'public')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Export queries (#43) are versioned by prompt_version and scoped per tenant.
CREATE INDEX findings_prompt_version_idx ON findings (prompt_version);
CREATE INDEX findings_installation_idx ON findings (installation_id);
CREATE INDEX feedback_finding_idx ON feedback (finding_id);
