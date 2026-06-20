# SOC 2 controls map (readiness)

> Spec ref: TRD §11, §15. Issue #55. SOC 2 (Type II via Vanta) is the
> **enterprise-tier** gate, not a free/early cost. The live work — onboarding
> Vanta, connecting it to our infra, and automating continuous evidence
> collection — is an ops/account task that requires production accounts and is
> tracked as `[~]` in PROGRESS. **This document is the engine-side artifact that
> precedes it:** a mapping from the SOC 2 Trust Service Criteria (TSC) to the
> controls the engine already implements, so Vanta onboarding is configuration,
> not discovery.

## Scope

- **Tier:** Enterprise only. Free/public and paid SMB tiers are covered by the
  DPA + GDPR posture (`COMPLIANCE.md`); the SOC 2 report is offered to enterprise
  customers under NDA.
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
| CC9.2 Vendors — sub-processors | Sub-processor list maintained | `COMPLIANCE.md` DPA Annex | DPA |
| A1.2 Availability — DR | Dual-write R2 + S3; survives single-provider outage | `DualWriteObjectStore` | infra config |
| C1.1/C1.2 Confidentiality — classification/disposal | PII scan excludes PII from training; retention disposal | `scanForPii` (#74), retention (#51) | code, tests |
| PI1 Processing integrity | Drop-and-count grounding; no-partial critique; canary recall gate | `hallucinationGate` (#32), `runDeepPass` (#29), `#44`/`#47` | tests, eval reports |

## Evidence automation (the Vanta task — `[~]` live)

Once Vanta is onboarded, the following connect for **continuous** evidence:

- Cloud (AWS/Cloudflare): KMS key policies, bucket encryption + lifecycle,
  IAM least-privilege.
- GitHub: branch protection, required CI checks, code-review enforcement.
- Postgres (Neon): access controls, backup config.
- HR/identity: onboarding/offboarding, MFA, background checks.
- Monitoring: alerting + incident-response runbooks.

These require production-account access and are **not engine code**; they are
tracked as the `[~]` portion of #55. This document keeps the control→evidence
mapping current so the onboarding is configuration against an already-true
posture rather than a remediation project.
