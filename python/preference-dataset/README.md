# apature-preference-dataset

Offline prep tool that turns `judgment-engine`'s **revealed-preference verdicts**
into training-ready datasets for the **owned judge** (core §16 / #78).

It reads the tuples the TypeScript side already produces and emits KTO + SFT
JSONL plus a dataset card. It is pure and deterministic: **no network, no model,
no keys** — the same input always yields byte-identical output.

## Why Python (and why here, not in TS)

`judgment-engine` is correctly TypeScript: capture, context extraction, the
critique wire protocol, delivery, and the *verdict collection* all live in the
Node service. But the thing this package does — preparing a preference corpus
for a fine-tune and (next) grading checkpoints — lands in the **Python ML
ecosystem** (`trl`, HF `datasets`, `transformers`, vLLM). Re-implementing
`KTOTrainer`/`DPOTrainer` input shaping, tokenization, or offline batch grading
in TS would be swimming upstream. So the boundary is:

```
  TS (judgment-engine)                         Python (this package)
  ────────────────────                         ─────────────────────
  packages/feedback/preference-export.ts  ──►  read tuples (schema.py)
    exportPreferenceDataset() -> tuples          validate against the TS enums
  packages/feedback/dvc-export.ts         ──►  read DVC dataset dir (reader.py)
    buildDvcDataset() -> content-addressed       verify md5 / .dir integrity
        │                                         │
        └─ verdict + KTO label per tuple          └─ build.py -> kto.jsonl,
                                                        sft.jsonl, dataset-card.json
                                                             │
                                                             └─► trl KTOTrainer /
                                                                 SFTTrainer (out of
                                                                 scope: the GPU run)
```

The TS side owns *data production and governance* (consent #74, PII #74, rater
weighting #42, DVC versioning #75). This package owns *ML data shaping*. It never
reaches back into TS.

## Data contract (mirrored, not invented)

The input tuple is a faithful mirror of the `PreferenceExample` interface in
`packages/feedback/src/preference-export.ts`; the enum spaces
(`Dimension`/`Severity`/`Viewport`) are copied verbatim from
`packages/types/src/findings.ts`. Validation **rejects** any value outside them,
so a schema drift on the TS side fails loudly here instead of silently poisoning
a training set. `verdict` and `label` must agree (`endorsed`⇔`desirable`).

`canonical_json` reproduces `dvc-export.ts`'s `canonicalJson` (sorted keys,
compact separators, UTF-8), so md5 content-addresses match byte-for-byte across
the boundary and the DVC `.dir` integrity check is identical to `pullDataset()`.

## Inputs it accepts

- A **JSON array** — what `exportPreferenceDataset()` returns, dumped.
- **JSONL** — one tuple per line (large sets).
- A **DVC dataset directory** — the content-addressed layout from
  `buildDvcDataset()` / `pushDataset()` (`.dir` manifest + `files/md5/…`).

## Outputs

- `kto.jsonl` — `{prompt, completion, label}` per tuple (`trl.KTOTrainer`).
- `sft.jsonl` — `{prompt, completion}` for endorsed tuples only.
- `dataset-card.json` — counts, class balance, per-dimension/severity/source
  breakdown, a reproducible DVC-style `version`, and suggested KTO class weights.

`prompt` carries **references** (`imageRef`, `contextHash`, route, viewport), not
pixels/text: resolving those object-storage artifacts is an ops seam (DVC / R2),
kept out so this stays a pure transform.

## Usage

```bash
uv venv && uv pip install -e '.[dev]'

# from a flat export
preference-dataset build --input tuples.json --out ./out

# from JSONL, one prompt version, collaborators only
preference-dataset build --input tuples.jsonl --prompt-version v2 \
  --training-grade-only --out ./out

# from a DVC dataset directory
preference-dataset build \
  --dvc-manifest fixtures/dvc/manifest.dir.json \
  --dvc-cache-root fixtures/dvc --out ./out
```

## Tests

```bash
uv run pytest        # or: .venv/bin/pytest
```

## Status / scope

Spike scaffold. **Additive and standalone** — it is not wired into the TS build,
CI, or `pnpm` workspace; it consumes exported artifacts only. Downstream (the
actual TRL fine-tune / offline batch grading of a checkpoint, §16) is
deliberately **not** in this package — see the roadmap in the PR description.
