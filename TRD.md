# Apature Judgment Engine - Technical Requirements Document

Created: 2026-06-16
Status: MVP build specification (decisions E1–E6 applied)

## 1. Technical Summary

Judgment Engine is the shared substrate that turns a generic vision model into a trusted reviewer. It exposes an asynchronous job API to all product surfaces, captures rendered UI deterministically in an isolated sandbox, extracts repo context, runs grounded Qwen3-VL critique, validates and version-stamps findings, and records the feedback that becomes the company's data moat.

It owns capture, context, model serving, validation, eval, data, and shared security. It does not own any buyer-facing UX. Apature manages model serving by default — there is no bring-your-own-key path; enterprise data residency is the in-VPC self-host path.

## 2. Core Contract

```ts
critique(images, context) -> Findings
```

Exposed through the async job API (§3). Result includes: overall grade; findings (dimension, severity, confidence, route, viewport, element_ref, evidence, suggestion, introduced_by_this_pr); not-reviewed reasons; validation metadata (hallucination drops); and `{engineVersion, model, promptVersion, captureVersion}`. The contract must be stable enough that consumers evolve independently; an `x-schema-version` header guards it and the type package evolves additive-only.

## 3. Async Job API (E1)

The seam every consumer uses.

- `POST /jobs` -> `202 { jobId }`. Body: `idempotencyKey`, `depth: "triage" | "deep"`, `installationId`, the capture/context intent, and the consumer id. HMAC-SHA256 signed; the engine verifies and scopes all work and storage to `installationId`.
- `GET /jobs/:id` -> `{ status: queued|running|cancelling|completed|failed, result? }`.
- `DELETE /jobs/:id` -> sets `status=cancelling`, returns immediately.

Job store and dispatch:

- Postgres `jobs` table is the source of truth (status, timing, consumer, installationId, idempotencyKey, result pointer). Workers `LISTEN` on `pg_notify` and claim with `SELECT ... FOR UPDATE SKIP LOCKED`. Results in object storage; Redis is used only for token-buckets/quotas, never as the job store.
- **Idempotency key** is `{consumer}:{installationId}:{intentType}:{intentHash}`; `INSERT ... ON CONFLICT DO NOTHING` gives ACID dedup across consumers (Gate's `pr:head_sha` is one `intentHash`).
- **Cancellation** is cooperative: `cancelling` is written at once; the worker tears down the in-flight Firecracker microVM (Fly Machines stop) and aborts the inference stream (AbortController) within one heartbeat (~5s). Correctness never depends on the kill landing in time.
- Deferred to scale: a completion-webhook callback replacing polling; a durable-execution engine if the pipeline becomes a multi-step saga.

## 4. Capture Sandbox (E3)

- One **Firecracker microVM per job on Fly Machines** (BUILD, not a managed browser vendor — KVM isolation for hostile PR code and network-layer egress control are hard requirements; this resolves the #23 spike).
- **Egress:** `nftables` in the guest namespace denies RFC-1918 / link-local `169.254.0.0/16` / metadata / `::1`, allows public assets with per-domain caps; Playwright re-resolves DNS to defeat rebinding.
- **storageState:** KMS-decrypted in-VM only, origin-scoped, disabled on fork PRs.
- Cold-start at MVP; a warm-pool manager is deferred (#77). 120s wall clock is per page-capture; fan out across microVMs. Everything behind `captureInSandbox(url, ctx)`; the in-VPC path runs the same sandbox in the customer cloud.
  - **Warm-pool restore mechanism (2026-06-21 research note, #77).** The deferred warm pool restores a snapshotted sandbox (CPU+memory state) instead of cold-booting kernel+rootfs+Chromium. Two restore models, with very different SECURITY properties for our hostile-PR workload:
    - **Per-machine suspend/resume (1:1) — the recommended default on Fly.** Fly Machines productizes Firecracker snapshot suspend/resume: a Machine saves full state (CPU regs, memory, file handles) and resumes in **hundreds of ms** (vs multi-second cold boot), each pool member resuming *its own* state. Because no snapshot is cloned across VMs, the uniqueness problem below does NOT arise. (Fly suspend/resume GA all regions Jul 2024; a 2025 slow-resume regression was fixed Oct 2025.)
    - **Clone-one-golden-snapshot-N-ways — faster/cheaper but documented-INSECURE for hostile code without mitigation.** Restoring the SAME snapshot into multiple concurrent microVMs replicates "unique identifiers, random numbers and random number seeds, the guest OS entropy pool, as well as cryptographic tokens" across clones — Firecracker's own docs state "we consider resuming execution from the same state more than once insecure." Since each capture sandbox runs attacker-controlled preview code, entropy/TLS/token reuse across clones is a real flaw. Mitigation if cloning is ever pursued: **VMGenID** (reseeds the guest kernel PRNG on resume) + **VMClock** (Linux 7.0+, lets userspace PRNGs detect resume) + explicit refresh of cached randomness/tokens — and even then the kernel pool is the only thing auto-reseeded. Prefer 1:1 suspend/resume.
  - **Snapshot caveats that shape the design:** snapshot AFTER kernel boot (early-boot snapshots can crash on resume); expect network/vsock **connection loss** across resume, so snapshot a launched-but-idle Chromium (no in-flight navigation) and `goto()` fresh after restore rather than freezing mid-load; require **cgroups v2** on the host (v1 → high restore latency); snapshots are tied to the exact code/version and must be invalidated on capture-image (`captureVersion`) change. The fixed post-restore clock complements the animation/time-freeze (#13) determinism work but must not defeat per-job uniqueness. Sources: https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md ; https://fly.io/docs/reference/suspend-resume/ ; https://community.fly.io/t/new-feature-in-preview-suspend-resume-for-machines/20672 ; "Restoring Uniqueness in MicroVM Snapshots" arXiv:2102.12892 (accessed 2026-06-21).

## 5. Capture Trust Protocol (E4)

`domcontentloaded` then explicit readiness; never `networkidle`; wait for fonts; freeze animations + reduced motion (re-inject post-scroll); scroll once for lazy-load. Stability via perceptual-hash plus an orthogonal structural-diff hash, excluding animated regions. A page flagged visually unstable applies a **confidence ceiling (≤ 0.70)** to every finding before the post-filter, so instability cannot produce a blocking finding.

- **Perceptual hash is a settle-detector and a cheap pre-filter — NOT the baseline change-detector (2026-06-20 research note, #89).** A single global pHash (32×32 → DCT → top-left 8×8 = 64-bit) is blind to small/localized UI changes (a button-color shift, a text change, a small spacing tweak), which is the literature's standard caveat ("not suitable as the primary diff method for visual regression"). It is correct for the **stability gate** (two shots a moment apart, where ignoring render jitter is desired) and as a cheap first gate. But the **triage short-circuit (#28)** must NOT conclude "no design change → skip deep review" from a global-pHash match alone: on a pHash *match*, confirm with a change-sensitive diff — tile-wise **SSIM** (≥ ~0.99 ⇒ no visible change) or AA-aware pixel diff (pixelmatch, `includeAA:false`) — computed per tile (#17) with animated regions excluded (#13/#18), before short-circuiting; a pHash *mismatch* still skips straight to deep review. Bias to review when uncertain (fail open). Sources: https://dev.to/dennis-ddev/screenshot-diffing-pixel-level-comparison-techniques-18k ; https://www.sciencedirect.com/science/article/pii/S1877050921011030 (accessed 2026-06-20).
- **Pin the page clock (#102).** CSS-animation freeze (#13) does not stop JS-driven, time-dependent rendering — relative timestamps ("2 min ago"), `setInterval`/`requestAnimationFrame` carousels and countdowns, date-defaulting widgets — which otherwise churn the capture and trip the stability gate / break the frozen-capture-set the eval relies on. Pin time with Playwright `page.clock`: `install({time: CAPTURE_EPOCH})` BEFORE `goto` (so load timers run and the page doesn't hang), then `pauseAt(CAPTURE_EPOCH)` after readiness and again after scroll, immediately before capture. `CAPTURE_EPOCH` is a deterministic constant (never wall-clock `now()`), identical for baseline + head. The real `page.clock` runs in the live worker (#11); the ordering seam is unit-tested. Source: https://playwright.dev/docs/api/class-clock (page.clock GA v1.45, Jul 2024; accessed 2026-06-21).

## 6. Repo Context Extraction

Context grounds the model in the actual repo and must be deterministic and versioned.

- Tailwind v3 resolved config in a sandboxed worker; Tailwind v4 `@theme`/`@config` via PostCSS; CSS custom properties; `tokens.json` (W3C / Style Dictionary); component-library detection -> rubric addenda; `.designreview.yml` brand block; diff->route mapping (framework page-files for MVP, import-graph for v1.5); repo README / approved visual anchors.
- All assembled into a **deterministic, content-hashed context block** placed under the model's prefix-cache boundary; invalidated by content hash, not wall-clock TTL.
- **UI-DNA genome grounding via retrieval (2026-06-21 research note, #104).** `uiDnaVersion` today is only a version STAMP — the resolved genome's design rules are not actually fed to the model (the only design-system grounding is the brand block, component addenda, and tokens). Ground on the genome by RETRIEVAL, not stuffing: embed the genome's rules/components once per `uiDnaVersion` (content-addressed, cacheable like the context block) and inject only the top-k rules relevant to each captured route's components/diff into the deep-pass context. Selective retrieval beats dumping the whole genome on both cost (~half the tokens/latency) and reliability (irrelevant rules add distractor-driven errors); the stable per-repo genome digest stays in the prefix-cached block (effectively cache-augmented) while the per-route retrieved subset is the volatile tail. The genome is OWNED by ui-dna/source-of-truth (resolved here, mocked in tests); the embedder is Apature-served + pinned (e.g. Qwen3-Embedding / EmbeddingGemma). A finding citing a genome rule still grounds structurally on a captured route + element_ref (#32). Sources: https://www.marktechpost.com/2026/02/24/rag-vs-context-stuffing-why-selective-retrieval-is-more-efficient-and-reliable-than-dumping-all-data-into-the-prompt/ ; https://arxiv.org/html/2407.16833v1 ; https://arxiv.org/pdf/2412.15605 (accessed 2026-06-21).

## 7. Model Serving (E2)

- **Phased, all behind one adapter:** DashScope (`qwen3-vl-plus` deep / `qwen3-vl-flash` triage, OpenAI-compatible) for v1; self-host as the act-2 lever (guided decoding, continuous batching, prefix caching, FP8, GPU warm-pool); a fine-tuned VLM as the act-3 owned judge. The adapter stamps `model`/`promptVersion`. Both self-host servers expose the OpenAI-compatible API the adapter (#26/#27) already targets, so the server is a deploy choice, not a code change.
  - **Self-host server = SGLang + XGrammar is the primary recommendation for THIS workload (2026-06-20 research note, #76).** The engine's profile is prefill-heavy (large multimodal prompt → short structured JSON), reuses a **byte-identical context prefix** across reviews of the same repo state (the §6 stable-context-block design is explicitly built for prefix reuse), and emits one **fixed** critique JSON schema every call. That maps onto SGLang's strengths: **RadixAttention** is a token-level radix-tree prefix cache that auto-discovers shared prefixes across requests (vs vLLM's block-level hashing), and prefix caching pays off most exactly when prefill dominates; and SGLang **overlaps grammar-mask generation with GPU inference**, so guided decoding costs little, whereas vLLM degrades notably at batch ≥8 with guided decoding. **XGrammar** is the right grammar backend because it caches/pre-computes per schema and wins when the **same** schema repeats (LLGuidance is for unique-per-request schemas — not our case). Keep vLLM as the supported alternative; lead with SGLang. Sources: https://lmsys.org/blog/2024-01-17-sglang/ ; https://blog.squeezebits.com/guided-decoding-performance-vllm-sglang (vLLM 0.10.0 / SGLang 0.5.0rc0 / XGrammar 0.1.21, Sep 2025) (accessed 2026-06-20).
  - **Model currency (2026-06-20 research note, #87):** Alibaba shipped **Qwen3.5** (GA Feb 2026), a *natively multimodal* successor — there is no separate `Qwen3.5-VL`; the main series is the vision model. `qwen3.5-plus` (`-2026-02-15`) and `qwen3.5-flash` (`-2026-02-23`) are on the same DashScope OpenAI-compatible endpoint and map 1:1 onto the plus/flash split, accept text+image+video, carry a 1M-token context, and were trained on UI screenshots (on-task for this engine). Reported visual gains over Qwen3-VL: ERQA 52.5→67.5, OmniDocBench v1.5 90.8, MMMU-Pro 79.0. Because the per-pass adapter (#26) makes this a config-swap, the new anchor is to be adopted **only via the eval gate** (#48/#71/#78), never blind-swapped; the act-3 owned judge fine-tunes whichever base wins. Sources: https://qwen.ai/blog?id=qwen3.5 ; https://www.alibabacloud.com/help/en/model-studio/models ; https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output (accessed 2026-06-20).
- **Structured output:** DashScope two-step (Thinking critique → non-thinking `json_object` coercion → Zod) because thinking ⊥ JSON mode and `max_tokens` cannot be set with `json_object`; the prompt must contain the literal word "JSON". Self-host uses single-call guided decoding (SGLang + XGrammar; the fixed critique schema makes XGrammar's per-schema caching fully amortized — see §7 serving note). The thinking ⊥ structured-output constraint **still holds on Qwen3.5** ("models in thinking mode do not support structured output", Model Studio, 2026-06-20), so the two-step persists across the #87 model-anchor migration; single-call guided decoding stays self-host-only.
- **Image budget:** Qwen3-VL patch-16 + `min_pixels`/`max_pixels` (never Claude's `⌈w/28⌉`/2576px/4784 constants); `max_pixels` enforced in the adapter is the cost lever. Prefix caching keyed on the byte-identical context block; `<=3` concurrent deep passes.

## 8. Critique & Validation Pipeline (E4)

Tiled images (within `max_pixels`) + context block + deterministic checks -> Thinking pass -> `json_object` coercion -> Zod parse -> **drop-and-count hallucination gate** (drop any finding whose `route`/`element_ref` is not in the captured set / geometry map; emit the drop as a metric) -> post-filter (confidence >= 0.55, dedupe across viewports, cap 1 blocker + 6) -> version stamp. Deterministic facts (contrast, overflow, touch targets) are computed in code and given to the model as facts, never read off pixels. Deferred: conditional re-ask/repair; `json_schema` coercion when GA.

## 9. Evaluation & Model/Prompt Promotion (E6, E4)

- Synthetic canary generator; 150-PR human-labeled set; precision/recall by dimension; blocker recall (headline); nit precision (trust); quadratic-weighted kappa (+ Krippendorff α / Gwet AC2 on skewed sets) with bootstrapped CIs.
- **Confidence calibration (2026-06-21 research note, #107).** The post-filter floor (#33, 0.55) and the unstable-capture ceiling (#70, 0.6) gate on the model's VERBALIZED `confidence`, but it is never measured for calibration. LLM/VLM-as-judge confidence is documented as severely overconfident + saturated (clusters at 90-100%; reported ECE 39-74%), so a fixed 0.55 floor may filter nothing and a 0.6 ceiling may cap everything. The eval suite therefore measures **ECE + Brier + a reliability curve** of `confidence` vs golden-set correctness, and the #33 floor / #70 ceiling are **derived from that measured reliability curve** (the confidence at which empirical precision crosses the trust bar), re-derived on each model/prompt change via the eval gate — not hand-picked constants. An optional monotonic post-hoc calibration map (isotonic / histogram binning, fit on the golden set) can remap raw → calibrated confidence before the floor. Pure stats over offline-labeled findings; no extra model calls. Sources: https://arxiv.org/html/2508.06225v2 ; https://arxiv.org/pdf/2509.25532 (accessed 2026-06-21).
- **Hard gate on canary recall**; the human set is monitored with CIs (a sub-CI move is not actionable). Run on a **frozen, content-addressed capture set**. Hallucination-drop and capture-instability are gated SLO metrics.
- **Eval-gated promotion:** a `model_prompt_registry` (Postgres) versions every model/prompt; CI runs the offline batch eval and **blocks merge on eval-fail**; rollback is a registry status flip; nothing reaches production without a version bump + eval pass. Weekly production injected-defect canaries. Shadow/canary rollout deferred.

## 10. Data Moat & Learning (E5)

- `findings`, `feedback`, `rater_permission` in Postgres. Signals: explicit (thumbs, `/ignore`), in-loop recheck auto-labels (densest), implicit suggestion string-match only. Link-unfurlers and "touched the element" never count; collaborator verdicts weighted over drive-by.
- Per-repo memory digest (<= 600 tok) appended to the deep-pass suffix — immediate personalization.
- **Preference dataset:** DVC-versioned export on the existing R2 (reproducible point-in-time sets, lineage finding -> verdict -> screenshot). Screenshots are PII: explicit tenant **training consent** + a PII scan gate cross-tenant training inclusion.
- **Owned judge (act-3):** ORPO fine-tune on (preferred, rejected) finding pairs, promoted only behind the eval gate, swapped in behind the model adapter. Per-tenant LoRA deferred.

## 11. Capacity, Fairness & Backpressure (E6)

Global Redis token-bucket on the model endpoint (outer envelope) + per-`installationId` quota + priority queues (gate-blocking > gate-background > other consumers). One tenant's burst cannot starve others. Backpressure surfaces as `429 + Retry-After` to consumers' circuit breakers. Composes with the `<=3` concurrent deep cap and warm-pool capacity.

## 12. Security & Privacy

No `contents: write`; the model judges, never edits or drives. SSRF hardening with DNS-rebind checks; deny internal/metadata/link-local egress, allow public assets so pages render honestly. Screenshots encrypted at rest (SSE-KMS); tenant-scoped keys with per-repo data keys (shared CMK free / per-tenant CMK paid / per-repo DEK always — never per-repo KMS keys). Auth storageState encrypted, origin-scoped, off on fork PRs. Prompt-injection defenses for DOM text (delimiters) and rendered screenshot text (the schema-constrained output is the backstop; eval canaries include rendered-text attacks). Retention 0 default / 30d paid under DPA. Enterprise residency via in-VPC self-host.

## 13. Runtime & Infrastructure Substrate

Monorepo (pnpm): job-API service, capture worker, context worker, critique adapter, eval harness, shared types. Fly.io / Fly Machines (microVMs for capture, services as Fly apps). Postgres (jobs, findings, feedback, registry). Redis (token-buckets, quotas, `noeviction`). S3/R2 object storage + on-demand signed URLs. AWS KMS-backed secrets. OpenTelemetry + Grafana. Operational choices stay behind interfaces so consumers never depend on vendor specifics.

## 14. Observability & SLOs

OTel spans across job -> capture -> context -> critique -> validate -> store, with `{engineVersion, model, promptVersion, captureVersion}` span attributes. SLOs: end-to-end critique latency p50/p95; hallucination-drop rate; capture-instability rate; queue backpressure; model-rate-limit incidents; eval precision/recall by dimension. Grafana panels per consumer and per tenant; alerts on hallucination-drop spikes, eval-gate regressions, and capacity saturation.

## 15. Milestones

- **EM0 - Foundation & ops:** monorepo, CI, Fly, Postgres, Redis, S3/R2, KMS, OTel/Grafana, secrets; the async job API + job store + cancellation; capacity/fairness; version stamping.
- **EM1 - Capture core:** Playwright capture, readiness/phash/structural-diff, tiling, geometry, a11y/deterministic checks, Firecracker sandbox, nftables egress + tests, storageState.
- **EM2 - Context & critique:** the full context-extraction layer; the model adapter, two-step structured output, `max_pixels`, prefix cache, drop-and-count gate, post-filter, confidence ceiling.
- **EM3 - Eval & quality gate:** canaries, golden set, metrics, regression + quality gate on the frozen capture set, model/prompt registry + CI eval-gate, hallucination/instability SLOs.
- **EM4 - Data moat & learning:** feedback signals, rater weighting, per-repo memory, consent/PII gate, DVC-versioned export.
- **EM5 - Security & residency:** SSE-KMS + retention, SSRF hardening + tests, prompt-injection defenses, GDPR/DPA, in-VPC residency.
- **EM6 - Scale & owned model (deferred):** self-host vLLM + GPU warm-pool, capture warm-pool, ORPO fine-tune + promotion, per-tenant LoRA, webhook callback, json_schema coercion, shadow/canary.

## 16. Acceptance Criteria

The substrate is acceptable when:

- A consumer can submit a job, poll, and receive a version-stamped `Findings` result; a duplicate idempotency key never re-runs capture; a `DELETE` tears down in-flight work.
- Capture is deterministic enough that the §9 quality gate clears on a frozen capture set; unstable pages never yield blocking findings.
- Hostile PR code cannot reach internal/metadata endpoints (egress + DNS-rebind tests pass).
- Findings referencing unknown routes/element_refs are dropped and counted; no malformed/partial result is ever returned.
- No prompt or model reaches production without a version bump and a passing eval gate.
- The preference dataset is reproducible, lineage-tracked, and excludes non-consenting tenants from cross-tenant training.
- Apature manages model serving end to end; no consumer brings a key.
