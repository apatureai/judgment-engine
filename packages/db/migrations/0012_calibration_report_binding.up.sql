CREATE TABLE model_prompt_calibration_bindings (
  registry_id uuid PRIMARY KEY REFERENCES model_prompt_registry(id) ON DELETE CASCADE,
  rubric_version text NOT NULL,
  calibration_report_id text,
  calibration_report_hash text,
  calibration_report jsonb,
  promotion_mode text NOT NULL DEFAULT 'advisory'
    CHECK (promotion_mode IN ('advisory', 'blocking')),
  CONSTRAINT model_prompt_calibration_binding_complete CHECK (
    (calibration_report_id IS NULL AND calibration_report_hash IS NULL AND calibration_report IS NULL)
    OR
    (calibration_report_id IS NOT NULL AND calibration_report_hash IS NOT NULL AND calibration_report IS NOT NULL)
  ),
  CONSTRAINT model_prompt_calibration_hash_format CHECK (
    calibration_report_hash IS NULL OR calibration_report_hash ~ '^sha256:[0-9a-f]{64}$'
  )
);
