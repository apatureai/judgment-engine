# Apature Judgment Engine

> **Archived.** Apature was wound down in 2026. This repository is published as-is under the MIT
> license as a record of the work. It is not actively developed, and issues and pull requests are
> unlikely to be reviewed. Fork it freely.
>
> Read [What is actually finished, and what is not](#what-is-actually-finished-and-what-is-not)
> before you invest time in this. The pipeline is real and well tested; the live capture and model
> infrastructure it was designed around was never built, and some seams are still stubbed.

Judgment Engine is the backend that takes screenshots of a rendered web UI, plus design facts
extracted from the repository that produced it, and asks a vision-language model to critique the
UI as a design reviewer would — spacing, hierarchy, contrast, typography, responsiveness,
accessibility, brand consistency. Then it deletes every finding the model cannot point at, and
returns a versioned, structured result over an asynchronous job API.

The hard part is not asking a VLM to look at a screenshot. The hard part is that a VLM will
confidently invent problems that are not on the page, and one hallucinated "blocker" comment on
someone's pull request ends the install. Almost all of the code here exists to make a model's
visual verdict trustworthy enough to post in front of a team.

This repository was the shared engine behind several Apature products; it was never buyer-facing
on its own.

---

## The engineering idea

### Grounding

"Grounding" here means two specific things, not a vibe:

1. **The critique is judged against the repo's own design system**, not the model's generic taste.
   `@engine/context` extracts design tokens (a `tokens.json`, CSS custom properties, or a resolved
   Tailwind v3/v4 config), detects the component libraries in use, maps the PR diff to affected
   routes, and serializes all of it into one **byte-stable context block** — byte-stable so that
   prefix caching on the model endpoint actually hits. Optionally it retrieves relevant rules from
   an approved *UI DNA* snapshot (a versioned model of what the product is supposed to look like,
   produced by a sibling service) via embedding retrieval. "Off-brand" then means off *this repo's*
   system.
2. **Every finding must carry a physical address**: the `route` it was found on and an
   `elementRef` — a selector that must exist in the DOM geometry map captured alongside the
   screenshot.

### The drop-and-count gate

That second point is the mechanism the whole design rests on. Structured output (`json_object` /
JSON-schema guided decoding) guarantees valid JSON — it does not guarantee true JSON. So after
parsing, findings are checked against reality and silently deleted if they fail
(`packages/critique/src/hallucination-gate.ts`):

```ts
for (const finding of findings) {
  if (!routes.has(finding.route)) {                 // route was never captured
    hallucinationDrops++;
    continue;
  }
  if (selectors && finding.elementRef !== null && !selectors.has(finding.elementRef)) {
    hallucinationDrops++;                            // element isn't in the geometry map
    continue;
  }
  kept.push({ ...finding, confidence: clampConfidence(finding.confidence) });
}
```

The model literally cannot report a problem it cannot point at. The drops are not just discarded —
`hallucinationDrops` is emitted as a metric, and the drop *rate* is an SLO that feeds the eval
harness. A prompt change that makes the model more imaginative shows up as a number before it
shows up as a support ticket.

It is a small function, and that is the point: it is cheap because everything upstream is
arranged to make "can you point at it" a question with a real answer. That upstream arrangement is
most of this repository:

- **Deterministic capture.** A half-loaded page or a mid-animation frame *is* a false finding
  factory, so capture pins a synthetic clock, freezes animations and re-injects that freeze after
  scrolling, waits on explicit readiness signals rather than `networkidle`, pins a deterministic
  font set and records silent web-font substitutions as a fact (so a substituted glyph becomes a
  footnote, not a "broken text" finding), and gates on a perceptual-hash + structural-diff
  stability check.
- **Triage before depth.** A cheap first pass short-circuits routes *confirmed* unchanged against
  a baseline (pHash match must be confirmed by an SSIM/pixel-diff tile score; a pHash match alone
  fails open to a full review). Only suspect routes reach the expensive grounded pass.
- **Confidence is not the model's to assert.** Raw verbalized confidence never crosses the wire.
  A numeric confidence is displayable only when an exact, hash-matched promoted
  `CalibrationReportV1` is bound at runtime — that report owns the calibration transform, the
  instability ceiling, the post-filter and the blocking threshold. No matching report means
  confidence is withheld and the result is advisory, not blocking.
- **The grade is reconciled downward.** The overall grade (`ship` / `ship_with_nits` /
  `needs_work` / `blocked`) is recomputed from the findings that *survived* the gate, so a model
  cannot say "blocked" while every blocking finding was dropped.
- **Promotion is eval-gated.** No model or prompt version is promoted without clearing a quality
  bar (blocker recall, nit precision, grade agreement/kappa, injected-defect canary recall,
  prompt-injection resistance) on a frozen, content-addressed capture set. The gate itself is
  exercised on every CI run against both a passing and a deliberately regressed candidate — see
  [Quickstart](#quickstart).

### The model is deliberately boring

Every backend sits behind one `ModelClient` interface (`packages/critique/src/model.ts`):
DashScope-hosted Qwen3-VL, a self-hosted vLLM/SGLang endpoint (same OpenAI-compatible client,
different base URL), a future fine-tuned checkpoint, or the in-repo mock. Swapping is a config
change. The DashScope path is two calls (a Thinking pass for the critique, then a non-thinking
`json_object` coercion pass, because on that API thinking and JSON mode are mutually exclusive);
the self-host path collapses that into one call with JSON-schema guided decoding.

The design bet, stated plainly in the architecture record, was that the durable asset is the
grounding infrastructure and the per-team preference data — not the model call.

---

## How a review flows

```
context block + design-system rules
        │
        ▼
     capture ──► triage ──(confirmed unchanged)──► "no design changes"
                    │
                    └──(suspect routes)──► deep grounded pass
                                                │
                                                ▼
                                          validation tail:
                                          drop-and-count gate
                                        → calibration transform
                                        → instability ceiling + post-filter
                                        → blocking threshold
                                        → grade reconciliation
                                        → version stamp
                                                │
                                                ▼
                                       wire projection → authority recheck
                                                │
                                                ▼
                                       published result (object storage)
```

`runReview` in `packages/review/src/orchestrator.ts` is the only place these stages are sequenced.
Every live I/O — the capture sandbox, the model client factory, the embedder — is injected, which
is why the entire pipeline runs deterministically in unit tests against stubs and the mock model.

Consumers do not call a blocking function over the network. They `POST /jobs` with an HMAC
signature, an idempotency key and a depth, then poll `GET /jobs/:id`; `DELETE /jobs/:id` marks the
job `cancelling` immediately and cooperatively tears down the in-flight work. Jobs live in
Postgres (`pg_notify` wakeups, `SELECT ... FOR UPDATE SKIP LOCKED` claims); results live in object
storage; Redis is used only for the model-endpoint token bucket, per-tenant quota and priority
fairness, never as the job store. Every result carries an `x-schema-version` header and a
`{engineVersion, model, promptVersion, captureVersion}` stamp.

One unusual step at the end: **publication authority**. A grounded result is not publishable just
because its design-system snapshot resolved at the start of the job. Before the bytes are
persisted, the runtime re-reads the exact tenant/repo/DNA version from the UI DNA service and
checks a freshness receipt. If that version was revoked, or the evidence is stale, missing,
regressed or unavailable, blocking is suppressed and the findings survive as advisory, with the
reason recorded in result provenance. UI DNA is the sole approval authority; the engine never
writes authority and never writes customer code.

---

## Where it sat in the stack

Judgment Engine was the shared substrate. The product surfaces owned delivery; the engine owned
everything that made a vision model behave like a reviewer.

| Repo | Role |
| --- | --- |
| [gate](https://github.com/apatureai/gate) | The GitHub PR product: finds a PR's preview deploy, submits a review job, posts the annotated review as comments and Check Runs. The primary consumer of this engine. |
| [mcp-review](https://github.com/apatureai/mcp-review) | The same critique exposed over MCP so a coding agent can check a UI in-loop and recheck its own fix. |
| [ui-dna](https://github.com/apatureai/ui-dna) | Extracts a repo's design system into a versioned, approvable snapshot. The thing this engine grounds against, and the sole authority for whether a snapshot is approved. |
| [ui-graph](https://github.com/apatureai/ui-graph) | Turns capture evidence plus a UI DNA projection into a queryable scene graph, so the prompt can carry a smaller, better-grounded view of the page. |
| [entropy-engine](https://github.com/apatureai/entropy-engine) | Repo-wide design-system drift detection and consolidation planning. Consumes the signed evidence bundles this engine's `@engine/evidence` package produces. |
| [sigil](https://github.com/apatureai/sigil) | A separate, structurally-neutral model-assurance audit product. Imports `@engine/eval`'s calibration work one-directionally. |

The seam between a surface and the engine is the async job API plus the wire contract in
`@engine/types`. `packages/types/fixtures/gate-review-result.golden.json` is byte-identical to
Gate's own golden fixture, so producer and consumer cannot drift silently.

Across every product the boundary was the same and is worth stating because it shaped the code:
**the engine judges and verifies; it never edits code and never drives the UI.** There is no
write path to a customer repo anywhere in this codebase.

---

## Quickstart

Node 24 (see `.node-version`) and pnpm 9.15.0.

```sh
git clone https://github.com/apatureai/judgment-engine.git
cd judgment-engine
pnpm install

pnpm typecheck   # tsc -b across all packages (also produces dist/)
pnpm test        # vitest run
pnpm lint        # eslint, warnings fail
```

All three pass on a clean clone. The test suite is 632 tests across 99 files and takes well under
a minute; it never touches a network, a model, a browser or a GPU.

The release gate is a CLI, and CI asserts both directions of it:

```sh
node packages/eval/dist/release-gate-cli.js packages/eval/fixtures/release/passing.advisory.json
# prints the decision JSON, exits 0

node packages/eval/dist/release-gate-cli.js packages/eval/fixtures/release/regressed.blocked.json
# prints "BLOCKED: - quality: blocker recall 0.620 < 0.85", exits 1
```

The two non-TypeScript components:

```sh
# Rust: perceptual hashing / near-duplicate + change-detection kernels
cargo test --manifest-path rust/capture-dedup/Cargo.toml

# Python: offline eval scorecard and preference-dataset prep (needs uv)
cd python/eval && uv venv && uv pip install -e '.[dev]' && uv run pytest
cd python/preference-dataset && uv venv && uv pip install -e '.[dev]' && uv run pytest
```

The production image builds with `docker build -t judgment-engine .`; `scripts/ci/container-smoke.sh`
is the smoke test CI runs against it (migration, Node version, `/livez`, `/readyz`, graceful
shutdown) and needs a reachable Postgres.

`.github/workflows/ci.yml` is the authoritative list of what was verified on every commit.

### Running the service

`packages/runtime/src/api-main.ts` is the deployable composition root (API + one worker);
`worker-main.ts` is the worker-only entrypoint. Production startup has **no** mock fallback — it
exits before listening unless the full configuration is present:

- Secrets: `DATABASE_URL`, `ENGINE_HMAC_SECRET`, `MODEL_API_KEY`, `OBJECT_STORE_ACCESS_KEY_ID`,
  `OBJECT_STORE_SECRET_ACCESS_KEY`, `CAPTURE_API_TOKEN`
- Config: `MODEL_BASE_URL`, `CAPTURE_ENDPOINT`, `OBJECT_STORE_BUCKET`
  (`OBJECT_STORE_ENDPOINT` / `OBJECT_STORE_REGION` select R2 or S3; `TRIAGE_MODEL`, `DEEP_MODEL`,
  `MODEL_BACKEND` pick the model path)
- Optional grounding: `GENOME_ENDPOINT`, `GENOME_API_TOKEN`, `EMBEDDING_MODEL` — setting these
  also enables the publication-authority recheck, bounded by `AUTHORITY_TIMEOUT_MS` and
  `AUTHORITY_MAX_AGE_MS`

`GET /livez` reports process liveness; `GET /readyz` reports database, capture fleet and worker
capacity separately. Migrations run via `packages/db`'s `migrate` CLI against `DATABASE_URL`.

Read the caveats below before you try any of this: `CAPTURE_ENDPOINT` points at a capture service
that does not exist in this repository.

---

## What is actually finished, and what is not

Be clear-eyed about this: **the engine's pure pipeline is complete and well tested; the live
infrastructure it was designed around was never built, and two seams inside the pipeline were
still stubs when work stopped.** The engine has never captured a real screenshot or called a real
model outside of ad-hoc manual runs. Everything in CI runs against stub capture and the mock
model, by design and also by necessity.

Stubbed *inside* this repository — read these first, they are the ones that would surprise you:

- **`captureInSandbox` is a scaffold stub.** `packages/capture/src/index.ts` exports
  `CAPTURE_VERSION = "stub@0"` and returns fabricated object keys with `geometry: []`. Everything
  else in `@engine/capture` is real (determinism policy, downscale and coordinate rescale,
  full-page tiling, geometry-map handling, stability gating, change detection, egress policy, font
  and clock policy), but the function that would produce a screenshot does not. A consequence
  worth naming: with an empty geometry map, the `elementRef` half of the drop-and-count gate never
  fires on any in-repo path. Only the route check does.
- **The rubric prompt is written but not wired.** `packages/critique/src/prompt.ts` contains the
  real product — the 8-dimension rubric, the grounding rules, and the instruction-hierarchy
  defense against prompt injection embedded in a screenshot — and `buildSystemPrompt()` is
  exported and unit-tested. It is not called by the pipeline. `orchestrator.ts` sends
  `"Apature design reviewer."` and `critique.ts` sends a string that says `stub prompt; #30
  replaces this`. Point this at a live model today and the model gets one line with no rubric.
  Wiring `buildSystemPrompt()` into `buildRequest` is the single highest-value change anyone
  forking this could make.

Not in this repository at all / never shipped:

- **The capture worker.** There is no Playwright dependency and no browser code here.
  `captureInSandbox` / `CAPTURE_ENDPOINT` is the seam where a real worker would attach. The
  Firecracker-microVM-on-Fly sandbox and its `nftables` egress enforcement are designed in
  `ARCHITECTURE.md` §4–5 and implemented only as pure policy functions.
- **Self-hosted GPU serving.** The vLLM/SGLang path is code-complete behind the adapter
  (including single-call guided decoding) but was never run against a GPU, and the warm-pool
  autoscaler does not exist.
- **The fine-tuned judge.** The preference-dataset export, consent/PII gating, DVC versioning and
  the shadow-promotion decision logic all exist. No fine-tune was ever trained; there is no
  checkpoint.
- **Deployment.** `Dockerfile` and `fly.toml` are real and the image is smoke-tested in CI, but no
  Fly app, database, bucket, KMS key or model account was ever provisioned. Nothing here ran in
  production and there were no users.
- **Grounding requires a peer service.** `GENOME_ENDPOINT` expects UI DNA's approved-snapshot read
  contract. Without it, reviews run ungrounded (generic critique) and the authority recheck is
  inert.
- **Credentials.** Any non-mock model run needs a DashScope (or OpenAI-compatible) key. There is
  no bundled key, no free path, and no offline model.
- Weekly production canaries, SOC 2 evidence automation, and shadow/canary rollout were ops tasks
  that were never started; `docs/SOC2-CONTROLS.md` is a control mapping, not an attestation.

There is no runnable end-to-end demo. The honest way to read this repository is as a working
reference architecture for a grounded VLM-judge pipeline, with an unusually thorough test suite,
not as a product you can start.

Also worth knowing: parts of this codebase were built by an autonomous agent loop, which is why
the source is unusually heavy on doc comments citing issue numbers. `PROGRESS.md` is that loop's
checklist, kept as an honest record of what is built versus deferred. Its issue numbers resolve
against this repository; the ones in `PRD.md` and `TRD.md` sometimes point at internal planning
that was never public, so a few cross-references will dead-end.

---

## Repository layout

pnpm workspace, one TypeScript package per concern under `packages/*`, plus a Rust crate and two
Python packages for the work that belongs in those ecosystems. Roughly 14k lines of TypeScript
source against 10k lines of tests.

| Package | What it owns |
| --- | --- |
| `@engine/types` | The `critique()` / `captureInSandbox()` interfaces, the `Finding` / `Critique` types, the 8-dimension rubric, and the consumer wire contract + golden fixture. |
| `@engine/capture` | Pure post-capture logic: deterministic checks (contrast, overflow, touch target), downscale + coordinate rescale, full-page tiling, DOM geometry map, pHash stability gate, change detection, egress policy, storage-state, font and clock policy. The sandbox entry point itself is a stub (see above). |
| `@engine/context` | Repo design-context extraction — design tokens (tokens.json / CSS vars / Tailwind v3+v4), brand block, component-library detection, diff→route mapping, the byte-stable context block, and UI DNA retrieval. |
| `@engine/critique` | The critique pipeline: model adapter, triage + deep passes, system prompt and rubric, Zod output schema, hallucination gate, confidence ceiling, post-filter, grade reconciliation, version stamp, multi-route assembly, wire projection. |
| `@engine/eval` | Quality harness and confidence authority: synthetic canaries, golden-set tooling, calibration report/map/threshold artifacts, precision/recall and agreement metrics (weighted kappa with bootstrap CIs, Krippendorff's alpha, Gwet's AC2, isotonic calibration, ECE/Brier), regression and quality gates, model/prompt registry, SLOs, shadow promotion. |
| `@engine/feedback` | Explicit / implicit / in-loop-recheck feedback signals, rater-permission weighting, per-repo memory digest, PII scan + training consent, preference-dataset export (ORPO + KTO), DVC versioning, GDPR erasure. |
| `@engine/evidence` | Signed `DerivedEvidenceBundleV1` production (RFC 8785 canonicalization, injected Ed25519 signer port, request binding, trust decisions) for the Entropy Engine acceptance gate. |
| `@engine/db` | Deterministic up/down migration runner and `migrate` CLI (Postgres, or PGlite for tests). |
| `@engine/redis` | Global model-endpoint token bucket, per-tenant quota and priority, fairness gate, no-eviction guard. |
| `@engine/storage` | `ObjectStore` interface, in-memory / S3 / dual-write adapters, object-key scheme, signed URLs, retention sweep. |
| `@engine/secrets` | KMS key provider, per-repo data-key envelope, app/repo secret store, log and trace redaction. |
| `@engine/observability` | OpenTelemetry span taxonomy, trace-context propagation through the job payload, SLO metrics. |
| `@engine/api` | The async job API (`POST` / `GET` / `DELETE /jobs`), HMAC verification, idempotency-digest conflict handling, depth→model routing, job→review binding. |
| `@engine/jobs` | Postgres job store (`pg_notify` dispatch, idempotency, `SKIP LOCKED` claim), cancellation coordinator, priority. |
| `@engine/review` | `runReview` — the end-to-end orchestrator — plus the job-processor adapter. |
| `@engine/runtime` | Production composition: Node HTTP adapter, config validation, real model/capture/genome adapters, Postgres `LISTEN` worker, health checks, drain and shutdown. |

| Elsewhere | |
| --- | --- |
| `rust/capture-dedup` | dHash / pHash / Hamming, SSIM and anti-aliasing-aware pixel diff. Integer math where it matters, with a golden vector file mirrored byte-for-byte by a TypeScript test so both languages agree. `#![forbid(unsafe_code)]`, no RNG, no I/O. |
| `python/eval` | Offline batch grader: recorded judge outputs + human-labeled golden set → scorecard. Pure, no GPU, no network. |
| `python/preference-dataset` | Turns exported revealed-preference verdicts into KTO/SFT JSONL plus a dataset card, for a fine-tune that never happened. |
| `contracts/`, `observability/`, `docs/` | Cross-repo JSON contract, Grafana dashboard + alert rules, and compliance/benchmark notes. |

### Further reading in this repo

- `ARCHITECTURE.md` — the architecture record: job lifecycle, boundaries, decision log (E1–E6),
  failure-mode table, mermaid diagrams. Start here.
- `TRD.md` — the technical contract and the research notes behind the model-serving and
  capture-isolation choices.
- `docs/BENCHMARK.md` — how review quality was measured: golden-set construction, every metric
  mapped to a function in `packages/eval/src/metrics.ts`, and the literal quality bars.
- `PRD.md` — what the engine was for.
- `RELEASE.md` — how a (model, prompt, engine, capture, rubric) candidate was promoted and rolled
  back.
- `PROGRESS.md` — the build checklist as it stood at the archive.
- `CONTRIBUTING.md`, `SECURITY.md` — read both before running any of this against real
  infrastructure.

---

## License

MIT. See `LICENSE`.
