# Data handling: retention, encryption and erasure

> Spec ref: TRD §11. Scope: the judgment engine as a **data processor** acting on
> a customer's (controller's) repositories. It documents the engine's data
> posture, the retention policy (#51), and the erasure workflow implemented in
> `@engine/feedback` `erasure.ts` (#54). Engine behavior only; product delivery
> (sticky comments, dashboard, billing) lives in `apatureai/gate`.

## 1. Processor posture (summary)

- **Roles.** The customer is the **controller**; Apature is the **processor**. The
  engine processes repository UI (rendered screenshots, DOM geometry, design
  tokens) and reviewer feedback solely to produce design-review judgments and,
  with explicit consent, to improve the owned model.
- **No BYOK / managed serving.** Apature manages model serving; enterprises get
  in-VPC residency (#79), not bring-your-own-key.
- **Data minimization.** The engine stores artifacts addressed by job id, the
  judgment result, and feedback signals. It does not store source code; it
  renders the preview and captures images + DOM geometry.
- **Encryption.** Artifacts are encrypted at rest with SSE-KMS (per-tenant CMK
  where configured, shared CMK otherwise; §11 hierarchy) and in transit (TLS).
  Access is **signed-URL only**, minted on demand with a short TTL and never
  persisted or logged.
- **Egress isolation.** The capture browser runs hostile PR preview code behind an
  SSRF-hardened egress policy (RFC-1918 / link-local / metadata deny, DNS-rebind
  recheck at connect; #52) and kernel-level nftables enforcement (#73).
- **Sub-processors.** Object storage (Cloudflare R2 + AWS S3), managed Postgres
  (Neon), KMS (AWS KMS), and the model-serving provider.

## 2. Retention

Retention is policy-configured per tenant and enforced by the engine's at-rest
policy (`@engine/storage` `retentionSecondsForTier`, `isExpired`, `reapExpired`):

| Policy | Artifact retention | Basis |
|--------|--------------------|-------|
| default | **0** (ephemeral — kept only for the in-flight job, then reaped) | default-minimize |
| extended (policy-configured) | **30 days** | re-checks and dispute resolution |

The durable judgment record (findings + feedback, version-stamped) is retained
to power per-repo memory and, with consent, model training; it is erased on
data-subject request (§3).

S3/R2 bucket **lifecycle rules** are the bulk reaping mechanism; `reapExpired`
is the engine-driven targeted sweep using the same idempotent `ObjectStore.delete`
primitive as erasure.

## 3. Deletion workflow (data-subject erasure)

Implemented in `@engine/feedback` `erasure.ts`, wired to the retention primitive:

1. **DB erasure** — `eraseInstallationData(exec, installationId)` deletes the
   tenant's `findings` (cascading to `feedback` via `ON DELETE CASCADE`) and the
   `tenant_training_consent` row, returning the affected job ids.
2. **Artifact purge** — `eraseTenant(exec, store, installationId, listKeys)`
   enumerates each affected job's objects (prod: S3/R2 `ListObjectsV2` under
   `jobPrefix(jobId)`; the lister is injected so the workflow is testable) and
   deletes them with `ObjectStore.delete` (dual-write stores purge **both** R2 and
   S3 copies).
3. **Preference-dataset re-version** — `removeSubject` (`dvc-export.ts`) re-versions
   the DVC training set without the subject's tuples; content-addressing means
   surviving objects keep their ids and prior versions still resolve their
   non-erased content.
4. **Consent withdrawal** — withdrawing training consent (`TrainingConsentStore`)
   excludes a tenant from future cross-tenant exports immediately (#74).

The workflow is **idempotent** (re-running on an already-purged tenant is a
no-op) and returns an `EraseResult` summary suitable for the processing record /
audit trail.
