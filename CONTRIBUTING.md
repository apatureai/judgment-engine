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

The CLI needs a Chromium binary as well:

```sh
pnpm browser:install   # playwright-core install chromium, ~275 MB downloaded
pnpm review            # captures the bundled demo site, writes out/
```

Verified on 2026-08-09 on macOS 15.6 with Node 24.14.0 and pnpm 9.15.0: lint
clean, typecheck clean, 739 vitest tests across 112 files passing, 20 Rust tests
passing, 26 + 53 pytest tests passing, and `pnpm review` producing 3 findings
with 2 gate drops. The `container` job in `.github/workflows/ci.yml` needs a live
Postgres service; the image itself was built locally with `docker build`.

## The one rule that still matters

**No test may call a live model, sandbox, browser, GPU, or network.** Every live
I/O in this codebase sits behind an injected seam: the capture worker is driven
through the `CaptureBrowser` port and tested against a fake page, the model
adapter is tested against a fake `fetch`, and the orchestrator is tested against
stubs. That is what keeps the pipeline deterministic and CI-runnable. A change
that reaches the network from a test is broken by construction, whatever else it
does.

The real browser is exercised outside the test suite, by the `quickstart` job in
`.github/workflows/ci.yml`, which runs `pnpm review` against headless Chromium,
asserts the artifacts the README promises, and runs
`scripts/ci/extractor-smoke.mjs` — the in-page DOM extractor against real pages,
checking that the deterministic contrast facts a real Chromium yields are the
true ones. Add a case there when you touch `DOM_EXTRACT_EXPRESSION`: a fake page
cannot tell you what `getComputedStyle` actually returns.

## Getting oriented

`README.md` is the documentation: what the engine is, how a review flows, the
`packages/*` map, the configuration table, how review quality was measured, and
an audited status table of what is implemented and what is not. The
architecture, technical-requirements, benchmark and release documents were
folded into it when this was archived.

Before you run any of this against real infrastructure, read `SECURITY.md`. It
is blunt about what is missing.
