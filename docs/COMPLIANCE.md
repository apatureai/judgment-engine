# Data-processor compliance (GDPR / DPA)

> Spec ref: TRD §11. Scope: the judgment engine as a **data processor** acting on
> a customer's (controller's) repositories. This document is the processor-posture
> artifact set required by #54: the DPA template, the Record of Processing
> Activities (ROPA / processing record), and the deletion workflow wired to the
> retention policy (#51). It describes engine behavior only; product delivery
> (sticky comments, dashboard, billing) is `apatureai/gate` and out of scope here.

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
- **Encryption.** Artifacts are encrypted at rest with per-tenant SSE-KMS (paid →
  per-tenant CMK, free/public → shared CMK; §11 hierarchy) and in transit (TLS).
  Access is **signed-URL only**, minted on demand with a short TTL and never
  persisted or logged.
- **Egress isolation.** The capture browser runs hostile PR preview code behind an
  SSRF-hardened egress policy (RFC-1918 / link-local / metadata deny, DNS-rebind
  recheck at connect; #52) and kernel-level nftables enforcement (#73).
- **Sub-processors.** Object storage (Cloudflare R2 + AWS S3), managed Postgres
  (Neon), KMS (AWS KMS), and the model-serving provider. Maintained as a current
  list in the DPA Annex; customers are notified of additions per §28(2) GDPR.

## 2. Retention

Retention is tier-based and enforced by the engine's at-rest policy
(`@engine/storage` `retentionSecondsForTier`, `isExpired`, `reapExpired`):

| Tier         | Artifact retention | Basis |
|--------------|--------------------|-------|
| free / public | **0** (ephemeral — kept only for the in-flight job, then reaped) | default-minimize |
| paid          | **30 days** | DPA, for re-checks and dispute resolution |

The durable judgment record (findings + feedback, version-stamped) is retained
to power per-repo memory and, with consent, model training; it is erased on
data-subject request (§4) and is governed by the same DPA.

S3/R2 bucket **lifecycle rules** are the bulk reaping mechanism; `reapExpired`
is the engine-driven targeted sweep using the same idempotent `ObjectStore.delete`
primitive as erasure.

## 3. Record of Processing Activities (ROPA)

| Field | Value |
|-------|-------|
| Processing activity | Automated design review of pull-request UI |
| Controller | Customer (repo owner) |
| Processor | Apature |
| Categories of data subjects | Repo collaborators; end-users whose data may appear in rendered previews |
| Categories of personal data | Screenshots of rendered UI (may incidentally contain PII), DOM text, reviewer identity for feedback attribution |
| Special categories | None intended; PII scan (`scanForPii`, #74) excludes PII-bearing records from cross-tenant training |
| Purposes | Produce review judgments; per-repo memory; consented model training |
| Recipients / sub-processors | R2, S3, Neon, AWS KMS, model-serving provider (DPA Annex) |
| International transfers | Per sub-processor region; SCCs where applicable; in-VPC residency option (#79) |
| Retention | Artifacts per §2; durable records until erasure request or consent withdrawal |
| Security measures | Per-tenant SSE-KMS, signed-URL-only access, SSRF egress isolation, prompt-injection defenses (#53), least-privilege, audit logging |
| Lawful basis (controller-set) | Legitimate interest / contract (the controller determines this) |

## 4. Deletion workflow (data-subject erasure)

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

## 5. DPA template (skeleton)

A full DPA is maintained as a signable legal document; the operative clauses it
must encode (and that the engine implements) are:

- **Subject-matter & duration** — processing for the term of the subscription.
- **Nature & purpose** — automated design review; consented model training.
- **Type of personal data & data subjects** — per the ROPA (§3).
- **Controller obligations / instructions** — Apature processes only on
  documented controller instructions (the review request and configured options).
- **Confidentiality** — personnel under confidentiality obligations.
- **Security (Art. 32)** — the measures in §1–§2 (encryption, access control,
  isolation, injection defenses).
- **Sub-processors (Art. 28(2)/(4))** — Annex list; prior notice of changes;
  flow-down terms.
- **Data-subject rights assistance (Art. 28(3)(e))** — the §4 deletion workflow;
  export tooling for portability.
- **Breach notification (Art. 33)** — notify the controller without undue delay.
- **Deletion/return on termination (Art. 28(3)(g))** — run §4 erasure across all
  tenants of the controller; certify completion.
- **Audit (Art. 28(3)(h))** — make available the SOC 2 report (#55) and this ROPA.
- **International transfers** — SCCs / regional residency (#79).

> This is engineering-maintained scaffolding, not legal advice; the executable
> DPA is reviewed by counsel before customer signature.
