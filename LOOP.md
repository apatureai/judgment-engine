# LOOP.md — self-improving build playbook (judgment-engine)

Living know-how for the autonomous build loop. Read at the start of every run;
append concrete learnings at the end. Mirrors the conventions proven in
apatureai/gate.

## How to run (each fire)

1. Sync: `git fetch`, checkout `agent/build`, `git pull --ff-only`, merge
   `origin/main` (stop only if conflicts are non-trivial).
2. Read this file, `PROGRESS.md` (EM0→EM6 checklist), and the plan (PRD/TRD/
   ARCHITECTURE).
3. Work top-down: first `[ ]` whose deps are `[x]`, one coherent slice per commit.
   If it needs LIVE infra/keys (Firecracker fleet, DashScope keys, GPUs), mark
   `[~] -> skipped: <reason>`, **stub the model/sandbox and keep going**.
4. Verify green: `pnpm install` (if deps changed) → `pnpm typecheck` → `pnpm test`
   → `pnpm lint`. Never commit red.
5. Flip `PROGRESS.md`, commit (plain message, **no AI attribution**), push, keep
   ONE PR `agent/build -> main` updated with `Closes #<N>` lines (open a new PR if
   the current one is merged/closed). Don't merge it; leave for human review.
6. Comment 2-3 lines on the issue. Update this log before ending.

## Conventions (from gate; don't rediscover)

- **Never call a real model or launch a real sandbox in tests.** Build against
  stubs / a mock model; the contract anchor is the golden wire fixture.
- **The wire result must stay byte-compatible with Gate's `GateReviewResult`**:
  `@engine/types/fixtures/gate-review-result.golden.json` is copied from
  apatureai/gate and is the cross-repo contract anchor. Evolve `@engine/types`
  additive-only behind `x-schema-version` (currently `1`). Keep this fixture in
  sync with Gate's (a shared package / Pact is the deferred upgrade, #80).
- **Package layout:** one concern per `packages/*`, own `tsconfig.json`
  (`rootDir: src`, `outDir: dist`) added to root `references`; tests in
  `packages/*/test/**`; add new packages to the `vitest.config.ts` alias map.
- **ESM/NodeNext/verbatimModuleSyntax**; `import type` + `.js` extensions.
  `lint` is `eslint . --max-warnings=0`; `_`-prefixed/rest-sibling unused vars ok.
- **Prefer real in-process tests for infra:** PGlite for Postgres, in-memory
  fakes for Redis/object-storage/model; leave real provisioning (Fly/Neon/R2/
  KMS/GPUs) as `[~]` ops steps.
- **Boundary (ECOSYSTEM §5, mirrored):** the engine owns capture/model/eval/
  feedback/storage. It does NOT own product delivery (that's Gate); it resolves
  UI-DNA from ui-dna/source-of-truth (mock those) but does not own the genome.

## Self-improvement log (newest first)

- 2026-06-19 (run 6): EM3 eval foundation — #45 golden-set labeling tooling
  (GoldenCase/RaterLabel/LabeledFinding + consensus/inter-rater helpers) and #46
  metrics suite (per-dimension P/R, blocker recall, nit precision, quadratic-
  weighted kappa + seeded bootstrap CI). 194 tests. Learnings:
  - **`@typescript-eslint/consistent-type-imports` forbids inline `import()` type
    annotations in tests too** — `Partial<import("...").Foo>` fails lint though it
    typechecks. Import the type at the top. (Tests pass + typecheck pass while
    `pnpm lint` fails — the run that "succeeded with 188 tests" was actually the
    lint step erroring; always read which of the 3 gates failed.)
  - **`noUncheckedIndexedAccess` + `++` on an indexed element doesn't compile**
    (`arr[i]++` where `arr[i]: number|undefined`). Use `arr[i] = (arr[i] ?? 0) + 1`
    for confusion-matrix / histogram builds; same for the kappa marginals.
  - **Recall denominators: pass `fn = total - tp`, not `total`.** A blockerRecall
    bug (`prFromCounts(tp,0,blockers.length)`) gave 1/3 instead of 1/2 — for a
    "recall over a set" just return `caught / total` directly and skip the P/R
    helper. Caught only because the test asserted the exact 0.5.
  - **Seed every bootstrap** (mulberry32) so CIs are deterministic and testable;
    skip non-finite kappa resamples (degenerate single-category draws).
  - **Next (EM3 chain in `@engine/eval`):** #47 regression gate (hard on canary
    recall ~100% via #44, monitor human set within #46's CIs, offline batch
    path), #48 quality gate (clears golden-set + canary bar on the frozen set),
    #72 SLOs (hallucination-drop + capture-instability targets, needs #46), then
    #71 model_prompt_registry (Postgres migration + CI eval-gate, builds on #68/
    #48/#47). #50 (public benchmark) + #49 (weekly prod canary) are ops/data.
    Then EM4 data (#37 Postgres schema first) and EM5 security.

- 2026-06-18 (run 5): EM2 critique finished + EM3 started — #27 DashScope
  streaming client (OpenAI-compatible, reasoning/content split, AbortSignal),
  #69 max_pixels enforcement, #29 deep-pass two-step + ≤3 concurrency, #34
  prefix-cache layout + cache-hit telemetry, #35 free-tier model swap, #28 triage
  + phash short-circuit, and #44 synthetic-canary generator (new `@engine/eval`).
  **EM2 (Context + Critique) is now fully complete.** 184 tests. Learnings:
  - **Inject the streaming `create` fn, don't import `openai` into the package.**
    The DashScope client is unit-tested against a fake async-iterable stream;
    `createOpenAICompatibleCreate(client)` adapts a real OpenAI-SDK client in
    production and the SAME client reaches self-host vLLM by base URL. Avoids a
    heavy dep + fragile SDK streaming types while honoring "use the OpenAI SDK".
  - **The two-step is just two `complete()` calls** with different flags
    (thinking+no-format, then non-thinking+json_object) — `max_tokens` is never
    set because `ModelRequest` has no such field (compliant by construction).
    "Never a partial" = a route whose coercion fails Zod returns `output: null`.
  - **`mapWithConcurrency` (a tiny worker-pool over a shared index)** is enough
    for the ≤3-concurrent cap; assert `maxInFlight` with an instrumented mock.
  - **Cross-package dep added cleanly:** critique→capture (for #16 PIXEL_BUDGETS,
    #15 hashesWithin) — acyclic, so add the workspace dep + tsconfig reference.
  - **A new package is still the 4-edit ritual** (pkg/tsconfig + root tsconfig
    references + vitest alias); `@engine/eval` for EM3.
  - **Next (EM3 eval, mostly a chained set in `@engine/eval`):** #45 (150-PR
    golden set + labeling tooling), #46 (metrics: precision/recall, blocker
    recall, nit precision, quadratic-weighted-kappa + bootstrap CIs — pure
    stats), then #47 (regression gate on canary recall, uses #44+#46), #48
    (quality gate on the frozen set), #71 (model_prompt_registry + CI eval-gate +
    rollback — Postgres migration, builds on #68/#48/#47), #72 (hallucination-
    drop + capture-instability SLOs, needs #46). #46 is the highest-leverage
    pure starting point. Then EM4 data (#37 schema first) and EM5 security.

- 2026-06-18 (run 4): EM0 finish + EM2 critique pipeline — closed out EM0 (#36
  global token-bucket, #66 cooperative cancellation, #67 capacity/fairness, #68
  version stamping) and built the model-abstraction + validation pipeline (#26
  per-pass `ModelClient`, #30 frozen prompt/rubric, #31 Zod `json_object`
  validation, #32 drop-and-count gate, #33 post-filter, #70 confidence ceiling).
  10 issues, 163 tests. Learnings:
  - **`critique()` is now a clean pipeline:** model → parse+Zod (#31) →
    hallucination gate (#32) → confidence ceiling (#70) → post-filter (#33) →
    version stamp (#68). Each stage is a pure exported fn wired in order, so the
    remaining model-I/O issues (#27 DashScope client, #28 triage, #29 deep
    two-step) only need to populate the ModelClient — the output path is done.
  - **Keep zod enums in sync with `@engine/types` via `as const satisfies
    readonly Dimension[]`** — compile-time guarantee the schema matches the
    contract without importing runtime values from the types package.
  - **Migrations that ALTER a CHECK/serial constraint:** the inline column check
    is named `<table>_<column>_check` (e.g. `jobs_status_check`) — drop + re-add
    it by that name; PGlite honors it, so the add-a-status migration is testable.
    Adding columns mid-stream (#67 `priority`) means updating COLS + the row
    type + mapRow together or the SELECT silently lacks the field.
  - **Token-bucket as pure `refillAndConsume` + a Lua mirror** kept #36/#67
    fully testable with an in-memory clock while the real cross-instance
    atomicity lives in `TOKEN_BUCKET_LUA` (never run against live Redis in CI).
  - **Cooperative cancellation invariant is free** if `complete`/`fail` are
    `WHERE status='running'`: once a job leaves running (cancelling/canceled) a
    late `processJob` writes nothing — no extra guard needed.
  - **Next (EM2 critique, model-I/O against a fake transport):** #27 (OpenAI-SDK
    streaming + thinking split + AbortController — build a DashScope ModelClient
    behind the #26 interface, test with a fake stream), #28 (triage + phash
    short-circuit using #15), #29 (deep two-step: thinking call → json_object
    coercion call, per the 2026-06-18 research the managed path can't collapse),
    #69 (max_pixels in the adapter, uses #16), #34 (prefix-cache byte-identical
    test on #63 + cached_tokens telemetry per the #34 research note), #35
    (free-tier model swap = config). Then EM3 eval (#44-#50) is a fresh package.

- 2026-06-18 (run 3): EM2 Context extraction — shipped the whole context layer as
  a new `@engine/context` package: #59 tokens.json (W3C + Style Dictionary) +
  shared `TokenMap`, #58 CSS custom props (PostCSS), #60 component detection,
  #61 `.designreview.yml` brand block (yaml), #62 diff->route (Next.js App +
  Pages), #56 Tailwind v3 `resolveConfig`, #57 Tailwind v4 `@theme`/`@config`,
  and #63 the deterministic content-hashed context block (the prefix-cache
  anchor). 124 tests green. Learnings:
  - **`*/` inside a JSDoc comment closes the comment** — writing `app/**/page.tsx`
    in a doc comment silently ends the block and produces a cascade of bogus
    syntax errors (and made ALL package tests fail to load via esbuild). Use
    `app/.../page.tsx` in prose. Quick tell: a syntax error on a line far from
    where you think the problem is, plus every sibling test file "failing."
  - **NodeNext can't resolve types for some package subpath exports** even when
    the runtime import works (tailwindcss/resolveConfig): `pnpm test` (esbuild)
    passes while `pnpm typecheck` errors `TS2307`. Fix with a tiny local ambient
    `declare module "pkg/subpath"` .d.ts (included via `src/**/*.ts`) rather than
    fighting the exports map.
  - **`type === "atrule"` does NOT narrow a `Container | Document` union to
    AtRule** in postcss's types — cast `parent as AtRule` after the check to read
    `.name`/`.params`.
  - **Determinism recipe that passed the byte-identical test:** recursively sort
    ALL object keys (`canonicalize`), sort arrays the caller controls, never emit
    a timestamp, then `JSON.stringify`. Hash that string for the cache key.
  - **`tailwindcss` is the right call for #56** despite its weight — the issue
    explicitly forbids static-AST-parsing (misses preset defaults); `resolveConfig`
    on a passed-in config object is pure/testable, and the untrusted-config LOAD
    stays the #22 sandbox seam.
  - **Next: EM2 Critique. #26 (critique() interface + per-pass model abstraction
    against a MOCK model) is the keystone** — deps are all [x], and it unblocks
    EM0 #36/#68 plus #27-#35/#69/#70. Then #30 (system prompt + 8-dim rubric +
    anti-hallucination), #31 (Zod schema + json_object — see the 2026-06-18
    research note: pin VL snapshots + require the literal "JSON" keyword), #32
    (drop-and-count gate; consumes #18 geometry + #63 routes), #33 (post-filter),
    #34 (prefix-cache byte-identical test, built on #63), #69 (max_pixels uses
    #16), #70 (confidence ceiling uses #15's flag). All implementable against a
    mock model — no live DashScope/GPU in tests.

- 2026-06-18 (run 2): EM1 capture sweep — implemented the pure-logic cores that
  the live-browser worker will call: #16 (`downscale.ts` pixel-budget + coord
  rescale), #17 (`tiling.ts`), #18 (`geometry.ts`), #15 (`stability.ts` phash +
  structural-diff gate), #20 (`page-health.ts`), #24 (`egress.ts` SSRF policy +
  domain budget), #25 (`storage-state.ts`). Resolved #23 (BUILD, already in
  docs). Skipped the live-browser/infra ones (#11/#12/#13/#14/#21/#22/#73).
  EM1 is now fully accounted for. 94 tests green. Learnings:
  - **The "pure core vs live seam" split is the EM1 unlock.** Almost every
    capture issue has a browser-free decision/computation (budget math, tiling
    geometry, hash-distance gate logic, SSRF allow/deny, cookie scoping, health
    aggregation) separable from the Playwright/Firecracker I/O. Implement the
    pure core with an injected sampler/extractor; mark the I/O `[~]` with the
    `captureInSandbox` stub as the seam. This turned a "blocked on browser"
    milestone into 7 shipped, fully-tested modules.
  - **A SPIKE issue is "done" when the decision is recorded in the docs** — #23's
    BUILD outcome was already in ARCHITECTURE/TRD, so it's `[x] resolved`, not a
    skip and not code.
  - **Share one `Rect`/value type** across capture modules (export from
    `checks.ts`, import elsewhere) — re-exporting two same-named `Rect`s from the
    package index collides. Caught at design time, not by the compiler.
  - **`noUncheckedIndexedAccess` bites string indexing too** (`a[i]` in hamming
    distance, regex `m[1]`): guard with `?? "0"` / `m?.[1]`. Tests pass under
    esbuild but `pnpm typecheck` fails — always run both before committing.
  - **A review-merge loop firing mid-build is safe to service inline** — it's
    `git fetch` + `gh` only (read-only on the working tree), so an uncommitted
    agent/build tree is undisturbed; handle it, then resume.
  - **Next milestone is EM2 (Context & critique), all pure-implementable:** new
    `@engine/context` package for #56-#63 (Tailwind v3 `resolveConfig`, v4
    `@theme` via PostCSS, CSS custom props, tokens.json, component detection,
    `.designreview.yml`, diff->route, deterministic context-block + content-hash
    #63 = the prefix-cache anchor), then **#26** (critique interface + per-pass
    model abstraction against a MOCK model) which unblocks EM0 #36/#68 and the
    rest of EM2. #56/#57 need `tailwindcss`/`postcss` deps; #58-#63 are
    dependency-light pure parsers.

- 2026-06-18: EM0 sweep — shipped #2 (CI hardening), #4 (`@engine/db` up/down
  migration runner), #5 (`@engine/redis`), #6 (`@engine/storage` R2/S3 +
  signed-URL), #7 (`@engine/secrets` CMK/DEK envelope), #8 (`@engine/observability`
  spans+propagation+metrics), #9 (dashboards/alerts), #10 (secret accessor +
  redaction), #65 (`@engine/jobs` store + pg_notify + idempotency), #64
  (`@engine/api` async job server), and EM1 #19 (deterministic contrast/overflow/
  touch-target checks). Skipped #3 (live Fly) + #11 (live browser). 61 tests green.
  Learnings for next runs:
  - **Mirror gate, don't reinvent.** gate's `@gate/db|redis|secrets|observability|
    engine` are the proven templates; adapt names/boundary, keep the structure.
    The engine's HMAC headers stay `x-gate-*` so gate's existing client works.
  - **Registering a package = 4 edits:** `packages/<n>/{package.json,tsconfig.json}`
    (+ `references` if it imports another `@engine/*`), root `tsconfig.json`
    `references`, and `vitest.config.ts` alias. Miss the alias and tests can't
    resolve the import.
  - **Test-only deps must be in that package's `devDependencies`** — a test that
    imports `@electric-sql/pglite` or `@engine/db` fails to load unless the
    package declares it (pnpm isolates node_modules). `@engine/api` hit this.
  - **`tsc` (noUncheckedIndexedAccess) is stricter than vitest/esbuild** — regex
    captures (`m[1]`) are `string | undefined`; guard before use. Tests can pass
    while `pnpm typecheck` fails; always run both.
  - **Async guards for `.rejects`:** a function that `throw`s synchronously before
    returning a promise won't be caught by `await expect(...).rejects`; make the
    function `async`.
  - **PGlite supports plpgsql, triggers, `FOR UPDATE SKIP LOCKED`, and
    LISTEN/NOTIFY** (`db.listen`) — real Postgres behavior is testable in-process.
  - **Adding a migration breaks rollback tests that hardcode the last id** — write
    rollback tests against `listMigrations()` (reverse order / full round-trip),
    not literal `["0001_init"]`.
  - **Dependency discipline:** `#36`/`#68` are gated by `#26` (critique model
    abstraction) and `#66` by `#22` (Firecracker). EM0 is otherwise done. The next
    high-leverage unblocked seam is **#26** — it unlocks #36/#68 and all of EM2.
    Many EM1 capture issues have pure-logic cores (#16 pixel-budget/coordinate
    rescale, #18 geometry serialization, #15 stability-gate logic) implementable
    without a browser even though #11 is skipped.

- 2026-06-17: EM0 #1 — scaffolded the monorepo + `@engine/types` (critique() +
  captureInSandbox() + Finding/Critique + wire result) consumed by stub capture
  and critique packages; copied Gate's golden fixture as the cross-repo anchor.
  Mirrors gate's #30. Next: #2 CI is effectively in place (ci.yml copied); then
  #64 async /jobs server is the highest-leverage seam (HMAC verify + x-schema-
  version + depth) — Gate's `@gate/engine` defines the client side to build to.
