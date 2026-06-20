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
