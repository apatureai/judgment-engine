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
