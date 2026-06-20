# Apature Judgment Engine

The shared substrate that turns a generic vision model into a trusted reviewer:
an async job API, deterministic capture in an isolated sandbox, repo-context
extraction, grounded Qwen3-VL critique, validation + version-stamping, and the
feedback that becomes the data moat. Consumed by Gate (and later mcp-review,
pointer, …).

## Boundary

The engine owns capture/model/eval/feedback/storage. Product surfaces (Gate, …)
own delivery. The seam is the async job API (`POST/GET/DELETE /jobs`) and the
contract in `@engine/types`. `@engine/types/fixtures/gate-review-result.golden.json`
is the **cross-repo contract anchor** — identical to Gate's golden fixture, so the
engine's wire result and Gate's consumer can't drift (`x-schema-version` guards it).

## Packages

- `@engine/types` — single source for `critique()` + `captureInSandbox()` + the
  `Finding`/`Critique` types and the consumer wire result.
- `@engine/capture` — capture sandbox (stub; EM1 implements Firecracker+Playwright).
- `@engine/critique` — critique pipeline (stub; EM2 implements the Qwen3-VL passes).

## Develop

`pnpm install`, then `pnpm typecheck` · `pnpm test` · `pnpm lint`. Build against a
**mock model/sandbox** (never live GPUs/Firecracker in tests). The build loop
works `PROGRESS.md` top-down (EM0 → EM6).
