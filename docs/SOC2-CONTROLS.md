# SOC 2 controls map (readiness)

> Spec ref: TRD §11, §15. A mapping from the SOC 2 Trust Service Criteria to the
> controls the engine implements, and where the evidence for each one lives. This
> is a readiness map, not an attestation — no audit was ever performed.

## Scope

- **Trust Service Criteria in scope:** Security (Common Criteria, required) +
  Confidentiality + Availability. Processing Integrity and Privacy map partially
  via the eval gate and the GDPR posture respectively.

## Controls map (TSC → engine control → evidence)

| TSC | Control (implemented) | Where | Evidence source |
|-----|-----------------------|-------|-----------------|
| CC6.1 Logical access — encryption at rest | Per-tenant SSE-KMS; §11 key hierarchy | `@engine/storage` `tenantKmsKeyId`, `S3ObjectStore` SSE-KMS | KMS config, bucket policy |
| CC6.1 — encryption in transit | TLS everywhere; signed-URL-only artifact access | `ObjectStore.signedGetUrl` (short TTL, never persisted) | TLS config, code |
| CC6.1 — secrets management | CMK/DEK envelope; no plaintext secrets at rest | `@engine/secrets` `sealForRepo`/`openForRepo` | KMS, code review |
| CC6.6 Boundary protection — SSRF | Egress deny (RFC-1918/link-local/metadata), DNS-rebind recheck, nftables | `@engine/capture` `checkEgressForHost` (#52), #73 | tests, kernel policy |
| CC6.6 — injection defense | Prompt-injection instruction hierarchy + constrained output + grounding | `@engine/critique` (#53), `#31`/`#32` | tests, prompt version stamp |
| CC6.7 — data transmission/disposal | Tier retention + idempotent erasure | `reapExpired`, `eraseTenant` (#51/#54) | retention config, audit logs |
| CC7.1 Detection — SLOs/alerts | Hallucination-drop + capture-instability SLOs; dashboards/alerts | `@engine/eval` `evaluateSlos` (#72), #8/#9 | Grafana, alert config |
| CC7.2 — monitoring | Tracing spans + propagation + metrics | `@engine/observability` (#8) | dashboards |
| CC8.1 Change management — eval-gated promotion | Model/prompt registry; promotion blocked without an eval pass; rollback | `@engine/eval` `ModelPromptRegistry` (#71) | registry rows, CI logs |
| CC8.1 — CI quality gate | lint + typecheck + tests on every PR; regression + quality gates | `.github/workflows/ci.yml`, `@engine/eval` (#47/#48) | CI run history |
| CC9.2 Vendors — sub-processors | Sub-processor list maintained | `COMPLIANCE.md` §1 | sub-processor list |
| A1.2 Availability — DR | Dual-write R2 + S3; survives single-provider outage | `DualWriteObjectStore` | infra config |
| C1.1/C1.2 Confidentiality — classification/disposal | PII scan excludes PII from training; retention disposal | `scanForPii` (#74), retention (#51) | code, tests |
| PI1 Processing integrity | Drop-and-count grounding; no-partial critique; canary recall gate | `hallucinationGate` (#32), `runDeepPass` (#29), `#44`/`#47` | tests, eval reports |
