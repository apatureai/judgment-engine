# Contributing

Short version: **this project is archived. Fork it.**

Apature has been wound down and this repository is published as a historical
archive. There is no roadmap, no maintainer on call, and no release process
still running. Issues and pull requests may sit unread indefinitely, and most
will not be merged. That is not a judgment on your patch; there is simply nobody
shipping from here anymore.

Forking is the encouraged path. The license is MIT — take it, rename it, change
whatever you like. You do not need to ask, and there is no CLA.

## If you open a pull request anyway

- Small and obviously correct has the best odds: a typo, a dead link, a clear
  bug with a test that fails before your change and passes after.
- Anything needing product judgment (new features, changed boundaries, changed
  wire contracts) will not get an answer. The person who would make that call
  has moved on.
- Please skip feature requests and roadmap issues. An archived repo cannot
  honor them.

## Building it

Accurate as of the archive; every command below was run against this tree.

**Toolchain.** Node 24 (`.node-version`; `engines` pins `>=24 <25`) and pnpm
9.15.0 (declared in `packageManager`, so `corepack enable` gets you the right
one). Add a stable Rust toolchain and [uv](https://docs.astral.sh/uv/) only if
you touch `rust/` or `python/`.

```sh
corepack enable
pnpm install --frozen-lockfile

pnpm lint       # eslint; --max-warnings=0, so warnings fail
pnpm typecheck  # tsc -b across the project references
pnpm test       # vitest run
pnpm build      # tsc -b (emits dist/ — same graph as typecheck)
```

The TypeScript workspace is `packages/*` (`@engine/*`). `vitest.config.ts`
aliases every package to its `src/index.ts`, so tests run against sources with
no build step; `pnpm test` alone is enough for the TS side.

Rust — `rust/capture-dedup`, perceptual near-duplicate detection, std-only with
no dependencies:

```sh
cargo test  --manifest-path rust/capture-dedup/Cargo.toml
cargo clippy --manifest-path rust/capture-dedup/Cargo.toml --all-targets -- -D warnings
cargo fmt   --manifest-path rust/capture-dedup/Cargo.toml --check
```

Python — `python/eval` and `python/preference-dataset` are two independent uv
projects (not part of the pnpm workspace):

```sh
cd python/eval            # then repeat for python/preference-dataset
uv venv
uv pip install -e '.[dev]'
uv run pytest
```

Verified on 2026-08-09 on macOS with Node 24.14.0 and pnpm 9.15.0: lint clean,
typecheck clean, 632 vitest tests across 99 files passing, 20 Rust tests
passing, 26 + 53 pytest tests passing. The `container` job in
`.github/workflows/ci.yml` needs Docker plus a live Postgres service and was
not run locally.

## The one rule that still matters

**No test may call a live model, sandbox, browser, GPU, or network.** Every live
I/O in this codebase sits behind an injected seam; tests use the mock model
adapter and stub capture, and that is what keeps the pipeline deterministic and
CI-runnable. A change that reaches the network from a test is broken by
construction, whatever it does otherwise.

## Getting oriented

- `README.md` — what the engine is, how a review flows, the `packages/*` map,
  and an explicit list of what is stubbed or missing. Read the status section
  before you plan any work.
- `ARCHITECTURE.md` — job lifecycle, module boundaries, diagrams.
- `TRD.md` / `PRD.md` — the technical contract and the product requirements.
- `docs/BENCHMARK.md` — the review-quality measurement methodology.
- `PROGRESS.md` — the build checklist as it stood at the archive. `[~]` marks
  "core done, live infrastructure deferred" — the microVM capture sandbox, the
  Playwright worker, and GPU serving are in that category and are not
  implemented here.
- `RELEASE.md` — how a (model, prompt, engine, capture, rubric) candidate was
  promoted and rolled back.

Before you run any of this against real infrastructure, read `SECURITY.md`. It
is blunt about what is missing.
