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

- 2026-06-17: EM0 #1 — scaffolded the monorepo + `@engine/types` (critique() +
  captureInSandbox() + Finding/Critique + wire result) consumed by stub capture
  and critique packages; copied Gate's golden fixture as the cross-repo anchor.
  Mirrors gate's #30. Next: #2 CI is effectively in place (ci.yml copied); then
  #64 async /jobs server is the highest-leverage seam (HMAC verify + x-schema-
  version + depth) — Gate's `@gate/engine` defines the client side to build to.
