# Apature Judgment Engine

The Judgment Engine turns a generic vision model into a **trusted design reviewer**.
A raw call to a vision model can read a screenshot, but it will also confidently
invent problems that aren't there — and one hallucinated "blocker" ends a customer
install. The engine is the layer that makes the model's verdict trustworthy:
deterministic UI capture, repo-specific design context, a grounded multi-pass
critique, a drop-and-count validation gate that deletes any finding the model
can't point at, version stamping, and a feedback loop that turns every review into
labeled training data. The moat is the **judgment data and the grounding, not the
model call** — the model is swappable behind one adapter.

> New here? Read this top to bottom (it's skimmable), then open `PROGRESS.md` for
> the live build status and `PRD.md` / `TRD.md` / `ARCHITECTURE.md` for depth.

## The bigger picture: where the engine sits

Apature ships several **product surfaces**, and the engine is the **shared
substrate** behind all of them:

- **Gate** — the GitHub PR design-review product (PR comments, Check Runs,
  dashboards, billing). This is the buyer-facing surface. It lives in the
  separate `apatureai/gate` repo.
- **ui-dna** — the design-genome source of truth: the repo's design system
  distilled into rules the review is grounded against.
- Plus other consumers (MCP Review, Interactive Review, …) on the roadmap.

The boundary is deliberate:

```
  Product surfaces (gate, mcp-review, …)        Judgment Engine (this repo)
  ───────────────────────────────────────       ──────────────────────────────
  PR comments / Check Runs                       capture (isolated sandbox)
  dashboards / billing                  ──┐      model serving + critique
  delivery + GitHub plumbing              │      eval harness + quality gate
                                          │      feedback + preference dataset
                                          │      object storage / secrets / KMS
                                          └──▶   async job API  ◀── the seam
                                                 @engine/types  ◀── wire contract
```

The **seam** between a product surface and the engine is the async job API
(`POST` / `GET` / `DELETE /jobs`) plus the wire contract in `@engine/types`.
The cross-repo anchor is `packages/types/fixtures/gate-review-result.golden.json`
— byte-identical to Gate's golden fixture, so the engine's output and Gate's
consumer cannot drift. `x-schema-version` guards additive evolution of that shape.

The engine **does not** own delivery (that's Gate) and it **does not** own the
genome (it resolves UI-DNA from ui-dna; in this repo that resolution is mocked).
It *does* own everything that makes a vision model act like a reviewer.

## How a review flows

The end-to-end pipeline is assembled in `@engine/review`'s `runReview` — the
keystone that sequences the individually-tested pure pieces into one flow. Every
live I/O (the capture sandbox, the model client, the genome embedder) is
**injected**, so the whole pipeline runs deterministically in tests against
stubs and a mock model.

1. **Context + genome** — extract repo design context (tokens, brand,
   component libraries, routes) into one byte-stable block; optionally retrieve
   the relevant UI-DNA genome rules.
2. **Capture** — render each route deterministically in an isolated sandbox
   (the live Firecracker/Playwright worker is the injected seam).
3. **Triage** — a cheap pass that short-circuits to "no design changes" when a
   route is *confirmed* unchanged; otherwise marks suspect routes.
4. **Deep-pass critique** — the grounded multi-dimension review runs over the
   suspect routes only, threaded with deterministic facts, retrieved genome
   rules, and any build facts.
5. **Assemble** — the global validation tail, run once: hallucination gate →
   confidence ceiling → post-filter → grade reconciliation → version stamp.
   The post-filter confidence floor and the unstable-capture ceiling are not
   guessed constants: they are **derived from the measured reliability curve**
   (`@engine/eval` calibration — ECE/Brier + reliability table over the golden
   set's `{confidence, correct}` pairs) and re-derived on each model/prompt
   change via the eval gate (the offline golden-set batch run is the live seam).
6. **Wire projection** — project the internal `Critique` into the
   `EngineReviewResult` wire shape the consumer reads.

```
context+genome → capture → triage ──(unchanged)──▶ "no design changes"
                                  └─(suspect)─▶ deep-pass → assemble → wire result
```

## Key concepts (vocabulary)

- **Deterministic capture** — the same UI always produces the same screenshot
  (pinned clock, frozen animations, font policy, stability gate). A half-loaded
  or jittery capture is the #1 source of false findings, so determinism is
  load-bearing, not polish.
- **Drop-and-count hallucination gate** — after the model responds, any finding
  whose route wasn't captured, or whose element reference isn't in the geometry
  map, is **dropped**, and the count is emitted as a metric. The model literally
  cannot report a problem it can't point at.
- **Confidence & grade** — every finding has a confidence; the overall grade
  (`ship` / `ship_with_nits` / `needs_work` / `blocked`) is **reconciled down**
  to what the surviving findings actually support, never raised.
- **Golden wire contract + `x-schema-version`** — `gate-review-result.golden.json`
  is the shared shape between this repo and Gate; the schema-version header guards
  it against drift.
- **Eval-gated promotion** — no model or prompt change ships unless it clears the
  golden-set + canary bar on a frozen capture set. Promotion to "stable" is
  refused without a passing eval.
- **Data moat (preference dataset)** — every review is instrumented to emit a
  clean labeled preference tuple (image / context / finding / verdict), gated by
  tenant consent and PII scanning, exported DVC-versioned. This is what lets the
  default judge later become a fine-tuned model behind the same adapter.
- **UI-DNA grounding** — the review is grounded on the repo's resolved design
  genome via retrieval, so "off-brand" means *off this repo's actual system*,
  not the model's generic taste.

## Codebase map (`packages/*`)

| Package | What it owns |
| --- | --- |
| `@engine/types` | Single source for the `critique()` / `captureInSandbox()` interfaces, the `Finding` / `Critique` types, and the consumer **wire contract** + golden fixture. |
| `@engine/capture` | Pure post-capture logic: deterministic checks (contrast/overflow/touch-target), downscale + coordinate rescale, full-page tiling, DOM geometry map, phash stability gate, change detection, egress policy, storage-state, font + clock policy. (The live browser/microVM worker is the injected seam.) |
| `@engine/context` | Repo design-context extraction: design tokens (tokens.json / CSS vars / Tailwind v3+v4), brand block, component-library detection, diff→route mapping, byte-stable context block, and UI-DNA genome grounding (retrieval). |
| `@engine/critique` | The critique pipeline: model adapter (DashScope/self-host/mock), triage + deep passes, system prompt + rubric, Zod output schema, hallucination gate, confidence ceiling, post-filter, grade reconciliation, version stamp, multi-route assembly, and the wire projection. |
| `@engine/eval` | Quality harness: synthetic canaries, golden-set tooling, precision/recall + agreement metrics (kappa / Krippendorff / Gwet), injection-resistance canaries, regression + quality gates, model/prompt registry, SLOs, shadow promotion. |
| `@engine/feedback` | The data moat: explicit/implicit/recheck feedback signals, rater-permission weighting, per-repo memory digest, PII scan + training consent, preference-dataset export (ORPO + KTO), DVC versioning, and GDPR erasure. |
| `@engine/db` | Deterministic up/down migration runner + `migrate` CLI (Postgres / embedded PGlite). |
| `@engine/redis` | Global model-endpoint token-bucket, per-tenant quota + priority, fairness gate, resilient connection + no-eviction guard. |
| `@engine/storage` | Object storage: `ObjectStore` interface, in-memory + dual-write (R2/S3) + S3 adapters, object-key scheme, signed URLs, at-rest retention sweep. |
| `@engine/secrets` | KMS key provider + per-repo data-key envelope, app/repo secret store, log/trace redaction. |
| `@engine/observability` | OpenTelemetry span taxonomy across stages, trace-context propagation through the job payload, SLO metrics, telemetry init. |
| `@engine/api` | The async job API (`POST`/`GET`/`DELETE /jobs`), HMAC verification, depth→model routing, and the job→review processor binding. |
| `@engine/jobs` | Postgres job store (`pg_notify` dispatch, idempotency, `SKIP LOCKED` claim), cancellation coordinator, priority. |
| `@engine/review` | **The end-to-end orchestrator** (`runReview`) that composes everything above into one pipeline, plus the job-processor adapter. |
| `@engine/runtime` | Production composition: Node HTTP adapter, validated durable request mapping, real model/capture/genome bindings, Postgres LISTEN worker, health checks, and shutdown/drain. |

## Current status

The pure pipeline is **built and tested** and is now **composed by `@engine/review`**:
context extraction, the multi-pass critique with its full validation tail, the eval
suite + quality gate, the feedback/data-moat, and the end-to-end orchestrator all
exist with unit tests against a mock model and stub capture.

What remains is mostly **human/ops-gated live infrastructure** — the pieces that
need real accounts, GPUs, or KVM hosts and therefore can't run in CI:

- Firecracker-microVM capture sandbox (#22) and the Playwright capture worker (#11)
- self-host vLLM/SGLang GPU serving + warm-pool autoscale (#76, #77)
- Fly.io provisioning (#3) and the various live-infra `[~]` items

These are marked `[~]` ("codeable core done; live-deferred") throughout
`PROGRESS.md` — **that file is the live checklist** and the source of truth for
what's built vs. deferred.

## Getting started

```sh
git clone git@github.com:apatureai/judgment-engine.git
cd judgment-engine
pnpm install
pnpm typecheck && pnpm test && pnpm lint
```

## Production runtime

`packages/runtime/src/api-main.ts` is the deployable composition root. It starts
the HTTP API and one worker so a staging machine exercises the full durable path;
`worker-main.ts` is the scale-out worker-only entrypoint. Production startup has
no mock/stub fallback: it exits before listening unless Postgres, HMAC, object
storage, model, and isolated-capture configuration is present.

Required secrets: `DATABASE_URL`, `ENGINE_HMAC_SECRET`, `MODEL_API_KEY`,
`OBJECT_STORE_ACCESS_KEY_ID`, `OBJECT_STORE_SECRET_ACCESS_KEY`, and
`CAPTURE_API_TOKEN`. Required non-secret configuration: `MODEL_BASE_URL`,
`CAPTURE_ENDPOINT`, and `OBJECT_STORE_BUCKET`. `OBJECT_STORE_ENDPOINT`/`REGION`
select R2 or S3; `TRIAGE_MODEL`, `DEEP_MODEL`, and `MODEL_BACKEND` keep providers
behind the engine adapter. UI-DNA grounding is enabled only when
`GENOME_ENDPOINT`, `GENOME_API_TOKEN`, and `EMBEDDING_MODEL` are configured.

`GET /livez` reports process liveness. `GET /readyz` reports database,
capture-fleet, and worker capacity separately. The worker uses Postgres `LISTEN`
on `engine_jobs` with a bounded polling fallback, `SKIP LOCKED` claims, bounded
retry, and graceful drain. `Dockerfile` and `fly.toml` are the staging image and
service configuration; migrations run as the Fly release command.

The API consumes Gate's versioned `GateReviewRequest` body directly. Tenant and
depth must match the HMAC-scoped durable job. `GENOME_ENDPOINT` targets Source of
Truth's approved `/v1/repos/{repo_id}/ui-dna` read contract; the engine resolves
the repository's approved snapshot itself instead of trusting a caller-supplied
genome version.

The deep docs:

- `PRD.md` — what the engine is and why (product requirements).
- `TRD.md` — the technical contract and design decisions.
- `ARCHITECTURE.md` — the architecture record (job lifecycle, boundaries, diagrams).
- `PROGRESS.md` — the live build checklist.
- `LOOP.md` — how the autonomous build loop works.

**The golden rule for tests:** never call a live model, sandbox, browser, or GPU
in tests. Every live I/O is behind an injected seam; tests use the mock model and
stub capture. This keeps the whole pipeline deterministic and CI-runnable.
