# apature-preference-dataset

Offline prep tool that turns `judgment-engine`'s **revealed-preference verdicts**
into training-ready datasets for the **owned judge** (#78).

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
compact separators, UTF-8), and the DVC `.dir` listing is sorted by canonical
UTF-8 bytes of `relpath` on both sides. That keeps md5 content-addresses and
dataset `version` ids byte-for-byte stable across Python, Node, host locales,
and ICU versions; the integrity check is identical to `pullDataset()`.

## Inputs it accepts

- A **JSON array** — what `exportPreferenceDataset()` returns, dumped.
- **JSONL** — one tuple per line (large sets).
- A **DVC dataset directory** — the content-addressed layout from
  `buildDvcDataset()` / `pushDataset()` (`.dir` manifest + `files/md5/…`).

## Outputs

- `kto.jsonl` — `{prompt, completion, label}` per tuple (`trl.KTOTrainer`).
- `sft.jsonl` — `{prompt, completion}` for endorsed tuples only.
- `dpo.jsonl` — `{prompt, chosen, rejected}` pairs (`trl.DPOTrainer` /
  `trl.ORPOTrainer`). See below.
- `dataset-card.json` — counts, class balance, per-dimension/severity/source
  breakdown, a reproducible DVC `version` (the same content-addressed `.dir` id
  `dvc-export.ts` computes), suggested KTO class weights, and a `dpo` block with
  pair counts + skip provenance.

`prompt` carries **references** (`imageRef`, `contextHash`, route, viewport), not
pixels/text: resolving those object-storage artifacts is an ops seam (DVC / R2).
`build` keeps it out so it stays a pure transform; the `resolve` step below
closes that seam behind a pluggable resolver.

## Resolve step (`resolve`) — hydrate refs into multimodal records

`resolve` turns the reference-carrying tuples into training-ready multimodal
records by mapping each `imageRef` (and, when present, `contextHash`) to a
concrete local artifact via a pluggable **`ArtifactResolver`**. A record reuses
`build.to_kto_row`'s `{prompt, completion, label}` and adds the hydrated image:

```json
{"prompt": {...}, "completion": {...}, "label": "desirable",
 "image_path": "jobs/job-1/screenshots/pricing-desktop", "context_path": "ctx-abc"}
```

- `image_path` is stored **relative to the resolver root** (portable and
  reproducible; a loader recomposes `root / image_path`). With `embed_bytes=True`
  the record instead carries raw `image_bytes` for an in-memory HF `datasets`
  loader (not JSONL-writable).
- **Missing-artifact policy** (explicit, never a silent drop):
  `imageRef is None` -> `skipped_no_ref`; `imageRef` set but the artifact absent
  -> `on_missing="skip"` counts `skipped_missing`, `on_missing="error"` raises
  `ArtifactNotFoundError`. The three buckets always sum to the input count.
- `contextHash` is hydrated opportunistically (`context_path`, counted by
  `context_resolved`); a missing context is non-fatal since context can ride
  inline in the prompt.
- Deterministic: tuples are visited in sorted `findingId` order; same input +
  same fixture tree -> same records and counts.

### Resolvers: fixture-only in v1, remote is a documented stub

- **`LocalFixtureResolver(root)`** — the only implementation. Maps a ref to a
  file under a local directory (`root / ref`), treating the ref as an opaque
  object key; rejects refs that escape `root`. **No network, no credentials, no
  secrets** — the tests run entirely against a committed fixture tree, no GPU.
- **`RemoteArtifactResolver`** — a documented **interface stub** that raises
  `NotImplementedError`. The production backend pulls artifacts from the DVC
  remote / Cloudflare-R2 bucket `dvc-export.ts` pushes to, with object-store
  credentials and a content-addressed cache. It is deliberately unbuilt here so
  this package stays network- and secret-free, and it was never wired up.

### DPO/ORPO pairing (#124)

A DPO/ORPO pair is a team's *revealed preference between two candidate critiques
of the same screen*, so the pairing key is the shared evidence: the rendered-UI
screenshot (`imageRef`) **and** the repo-context hash (`contextHash`). Within
each such context an **endorsed** finding becomes `chosen` and a **dismissed**
finding becomes `rejected`; the full endorsed×dismissed cross-product is emitted.
Because DPO requires the prompt to be byte-identical across `chosen`/`rejected`,
the DPO `prompt` carries only that shared context (not the per-finding
route/viewport, which may differ between the two findings).

Contexts that cannot form a pair are **skipped and counted** (never silently
dropped) in the card's `dpo` block: `skipped_only_endorsed`,
`skipped_only_dismissed`, and `skipped_no_context` (a tuple missing `imageRef`
or `contextHash`). Pairing is deterministic and input-order-independent: groups
are visited in sorted-key order and both sides sorted by `findingId`.

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

# hydrate imageRef/contextHash refs into multimodal records (local fixture dir)
preference-dataset resolve --input tuples.json \
  --fixture-root ./artifacts --out ./out          # writes resolved.jsonl + resolve-report.json
# fail instead of skipping when an artifact is missing:
preference-dataset resolve --input tuples.json \
  --fixture-root ./artifacts --on-missing error --out ./out
```

## Tests

```bash
uv run pytest        # or: .venv/bin/pytest
```

## Status / scope

Spike scaffold. **Additive and standalone** — it is not part of the TS build or
the `pnpm` workspace (CI does run its pytest suite); it consumes exported
artifacts only. Downstream work is deliberately **not** in this package:
`python/eval` is the offline batch grader, and the TRL fine-tune it prepares
data for was never run.
