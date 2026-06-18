# Apature Judgment Engine - Build Progress (loop source of truth)

Deterministic checklist for the autonomous build loop. Work top-down by milestone (EM0 -> EM6).

How the loop uses it:
- Pick the FIRST unchecked `[ ]` issue whose dependencies are already `[x]`.
- When done (code + tests green, pushed): change `[ ]` to `[x]` and append ` -> done: <one line>`.
- If blocked or it needs LIVE infra/keys (Firecracker fleet, DashScope keys, GPUs), mark `[~]` and append ` -> skipped: <reason>`, then take the next unblocked issue. Stub the model/sandbox where possible and keep going.


## EM0 · Foundation & ops

- [x] #1 - Infra: monorepo scaffold + shared critique() interface package -> done: pnpm workspace (types/capture/critique) + tsc -b project refs, strict TS, ESLint, Vitest, CI; @engine/types is the single source for critique()/captureInSandbox() + Finding/Critique/version-stamp types; @engine/capture + @engine/critique consume it (stubs; EM1/EM2 implement). Golden wire fixture copied from Gate as the cross-repo contract anchor (x-schema-version=1). typecheck+test(5)+lint green.
- [x] #2 - Infra: lint + typecheck CI pipeline -> done: GitHub Actions runs eslint + tsc + vitest on PR/push (all workspaces via `eslint .` + `tsc -b` project refs); pnpm store cached via setup-node; install is `--frozen-lockfile`; added least-privilege `permissions: contents: read`. Any error fails the check.
- [~] #3 - Infra: Fly.io app + Machines provisioning -> skipped: needs a live Fly account + Dockerfiles for the orchestrator/capture services that aren't built yet (EM0 #64 / EM1 #22). The deployable seam (db migrate as Fly release command) is in place via `@engine/db` CLI; revisit fly.toml once those services have runnable images.
- [x] #4 - Infra: Neon Postgres provisioning + migration tooling -> done: `@engine/db` deterministic up/down migration runner (paired `NNNN_name.up.sql`/`.down.sql`, `schema_migrations` tracking, idempotent apply + reverse-order rollback) tested against embedded PGlite (apply/idempotent/rollback round-trip); `migrate` CLI (`up`/`down [n]`) for the Fly release command + ephemeral Neon branch in CI; pgExecutor documents Neon pooled-endpoint usage for serverless pooling. Baseline 0001_init adds the shared `touch_updated_at()` trigger fn. Live Neon project/branch provisioning stays ops.
- [x] #5 - Infra: Redis provisioning for BullMQ + token-bucket -> done: `@engine/redis` shared resilient ioredis connection helper (maxRetriesPerRequest:null, capped retry, READONLY reconnect) + reserved key namespaces (`tb:` model-endpoint token-bucket #36, `quota:`/`pq:` per-tenant quota+priority #67, `cb:` circuit-breaker) + `assertNoEviction` startup guard documenting the required `noeviction` policy. Per the E1 architecture review the durable job store is Postgres+pg_notify (#65), NOT Redis, so namespaces are fairness/rate-limit only. Live managed Redis instance stays ops.
- [ ] #6 - Infra: S3 + R2 buckets + on-demand signed-URL service
- [ ] #7 - Infra: AWS KMS per-tenant key + per-repo data-key envelope helper
- [ ] #8 - Infra: OpenTelemetry tracing skeleton across stages
- [ ] #9 - Infra: Grafana dashboards + alerts (cache-hit, queue depth, hallucination-drop)
- [ ] #10 - Infra: secrets management (KMS-backed app secrets)
- [ ] #36 - Orchestrator: global Redis token-bucket on model-endpoint limits
- [ ] #64 - Engine: async job API server (POST/GET/DELETE /jobs, HMAC, x-schema-version, depth)
- [ ] #65 - Engine: job store + pg_notify dispatch + idempotency
- [ ] #66 - Engine: cancellation propagation (cancelling -> microVM kill + inference abort)
- [ ] #67 - Engine: capacity & fairness (token-bucket + per-tenant quota + priority queues)
- [ ] #68 - Engine: version stamping on all Findings results

## EM1 · Capture core

- [ ] #11 - Capture: Playwright worker — 3 viewports at DSF 2
- [ ] #12 - Capture: page-readiness protocol (domcontentloaded -> fonts.ready -> layout-stable -> phash; never networkidle)
- [ ] #13 - Capture: deterministic animation freeze + reduced-motion (re-inject post-scroll)
- [ ] #14 - Capture: auto-scroll lazy-load + infinite-scroll detection
- [ ] #15 - Capture: phash stability gate excluding animated regions
- [ ] #16 - Capture: screenshot downscale to model pixel budget + coordinate rescale
- [ ] #17 - Capture: full-page tiling (viewport-height, 15% overlap, labels)
- [ ] #18 - Capture: DOM geometry map (selector/role/rect)
- [ ] #19 - Capture: a11y tree + computed-style deterministic checks (contrast/overflow/touch-target)
- [ ] #20 - Capture: console-error + failed-request page-health footnote
- [ ] #21 - Capture: dark-mode capture (fresh context, pre-goto colorScheme)
- [ ] #22 - Capture: Firecracker-microVM-on-Fly capture sandbox
- [ ] #23 - Capture: SPIKE build-vs-buy isolated-browser fleet (Firecracker vs Browserbase)
- [ ] #24 - Capture: egress policy — deny RFC-1918/link-local/metadata, allow public assets
- [ ] #25 - Capture: storageState injection (origin-scoped, KMS-decrypt in-VM, off on fork PRs)
- [ ] #73 - Capture: egress enforcement (nftables in-VM) + DNS-rebind/metadata tests

## EM2 · Context & critique

- [ ] #56 - Context: Tailwind v3 resolveConfig in sandboxed worker
- [ ] #57 - Context: Tailwind v4 @theme/@config via PostCSS
- [ ] #58 - Context: CSS custom-properties extraction
- [ ] #59 - Context: tokens.json (W3C / Style Dictionary) parser
- [ ] #60 - Context: component-library detection -> rubric addenda
- [ ] #61 - Context: .designreview.yml brand block extraction
- [ ] #62 - Context: diff->route mapping (framework page-files MVP + import-graph v1.5)
- [ ] #63 - Context: deterministic context-block serialization + content-hash cache invalidation
- [ ] #26 - Critique: critique() interface + per-pass model abstraction
- [ ] #27 - Critique: model SDK streaming + Thinking-checkpoint wiring (OpenAI-compatible)
- [ ] #28 - Critique: triage pass (qwen3-vl-flash) + phash-vs-baseline short-circuit
- [ ] #29 - Critique: deep pass (qwen3-vl-plus Thinking, <=3 concurrent, two-step JSON)
- [ ] #30 - Critique: system prompt + 8-dimension rubric + anti-hallucination clause
- [ ] #31 - Critique: Zod output schema + json_object/guided-decoding validation
- [ ] #32 - Critique: post-parse validation gate + hallucination metric
- [ ] #33 - Critique: post-filter (>=0.55, dedupe, cap 1 blocker + 6)
- [ ] #34 - Critique: prefix-cache layout (stable context block) + cache-hit telemetry + byte-identical test
- [ ] #35 - Critique: free-tier deep-pass model swap (qwen3-vl-flash / Instruct)
- [ ] #69 - Critique: max_pixels image-token budget enforcement in adapter
- [ ] #70 - Critique: confidence-ceiling propagation (unstable page caps findings)

## EM3 · Eval & quality gate

- [ ] #44 - Eval: synthetic-canary generator
- [ ] #45 - Eval: 150-PR golden set + labeling tooling
- [ ] #46 - Eval: metrics (precision/recall, blocker recall, nit precision, weighted-kappa + CIs)
- [ ] #47 - Eval: regression gate (hard on canary recall, monitor humans, offline batch)
- [ ] #48 - Eval: quality gate — critique clears §10 golden-set + canary bar on frozen capture set
- [ ] #49 - Eval: weekly production injected-defect canary
- [ ] #50 - Eval: public benchmark publication
- [ ] #71 - Eval: model/prompt registry + CI eval-gated promotion + rollback
- [ ] #72 - Eval: hallucination-drop + capture-instability SLOs coupled to the gate

## EM4 · Data moat & learning

- [ ] #37 - Data: Postgres schema (findings / feedback / rater_permission)
- [ ] #38 - Data: explicit feedback signals (thumbs + /ignore)
- [ ] #39 - Data: implicit signal — suggestion string-match (drop touched-element heuristic)
- [ ] #40 - Data: in-loop recheck labeling
- [ ] #41 - Data: per-repo memory digest (<=600 tok) -> deep-pass suffix
- [ ] #42 - Data: rater-permission down-weighting
- [ ] #43 - Data: preference-dataset export (image/context/finding/verdict tuples)
- [ ] #74 - Data: tenant training-consent + PII scan for training data
- [ ] #75 - Data: DVC-versioned preference-dataset export on R2

## EM5 · Security & residency

- [ ] #51 - Security: SSE-KMS at rest + retention (0 default / 30d paid)
- [ ] #52 - Security: SSRF hardening + tests (DNS rebind, metadata)
- [ ] #53 - Security: prompt-injection defenses (delimiter + rendered-text canaries + schema)
- [ ] #54 - Security: GDPR/DPA + data-processor artifacts
- [ ] #55 - Security: SOC 2 via Vanta (enterprise)

## EM6 · Scale & owned model (deferred)

- [ ] #76 - Scale: self-host vLLM/SGLang serving + GPU warm-pool autoscale (act-2)
- [ ] #77 - Capture: warm-pool manager (snapshot/UFFD)
- [ ] #78 - Owned model (act-3): ORPO fine-tune training + eval-gated shadow promotion
- [ ] #79 - Enterprise: in-VPC self-hosted engine + capture residency path
- [ ] #80 - Scale hardening (deferred): webhook callback, json_schema coercion, shadow/canary, per-tenant LoRA
