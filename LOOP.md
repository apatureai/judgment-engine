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
5. Flip `PROGRESS.md`, commit (plain message, **no AI attribution**), push.
   **PR scope: one PR per milestone, not one ever-growing PR.** Keep a single
   open build PR for the *current* milestone (EM0/EM1/…) with `Closes #<N>` per
   issue landed; when that milestone's issues are all done, leave it for human
   review/merge and open a fresh PR for the next milestone (base `main`). Don't
   merge it yourself. Milestone-sized PRs (~10–25 commits) actually get reviewed
   and merged, which keeps `agent/build` close to `main`; a giant 80-commit PR is
   unreviewable. (Learned 2026-06-20: the one rolling PR had to be split into
   stacked review PRs after the fact — do it incrementally instead.)
   - Any post-hoc review branches must be cut from an `agent/build` that has
     ALREADY merged latest `main`, or early snapshots conflict on the lockfile.
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

- 2026-06-21 (run 19): shipped #113 — **orchestrator quality follow-ups** (three
  pure refactors in `@engine/review` `runReview`, the non-blocking findings from
  the PR #110 independent review, captured so they couldn't be lost). (1) The
  empty-capture result stamped `resolvePassModel(input.depth)` — it reported the
  *triage* model on `depth==="triage"` and ignored `deps.passModels`; now reports
  the resolved **deep**-pass model (passModels-aware), matching the main path.
  (2) Both the empty-capture and triage short-circuit results were hand-built wire
  literals that bypassed the #68 version-stamp assertion — now routed through the
  SAME builders as the main path (`assembleCritique([], …)` → `toEngineReviewResult`),
  so they inherit the non-empty stamp and can't drift from the contract (the
  short-circuit carries the triage summary through as `overall`). (3) Per-route
  genome retrieval (#104) was awaited serially in the deep-pass loop (N embed
  round-trips); now ONE batched `embedder([...queries])` up front + per-route
  `retrieveGenomeRules` ranking — identical deterministic result, one round-trip.
  Lesson: edge/short-circuit paths that hand-assemble a "happy empty" result are
  exactly where a contract invariant (the version stamp) silently rots — route
  every wire result through the one builder, even the empty ones. +5 tests (391
  total): spy-embedder asserts a SINGLE batch; passModels override flows to the
  empty-result model; both short-out paths pass `assertVersionStamped` + golden
  shape. Mock model + stub capture + fake/spy embedder only. typecheck+test+lint
  green; golden byte-unchanged.
- 2026-06-21 (run 18): shipped #107 — **judge confidence calibration** (ECE/Brier
  + reliability table + seeded ECE bootstrap + optional PAVA isotonic map) in a
  new `@engine/eval/calibration.ts`. Pure eval stats, additive to the #46 suite;
  composes with #45 (golden ground truth supplies `{confidence, correct}`), #84
  (same hand-derived-reference + seeded-mulberry32-bootstrap discipline), and the
  eval gate #48/#71. Key point baked into the docs + the code header: the #33
  0.55 floor and #70 0.6 ceiling are **derived from the measured reliability
  curve, not guessed constants** — the actual threshold re-derivation RUNS IN THE
  OFFLINE EVAL (the golden-set batch is the live seam), so this issue ships the
  measurement + the optional monotonic remap, and leaves the live re-fit eval-
  gated. +12 tests (386 total), golden unchanged. Learnings:
  - **Hand-derive references with independent arithmetic** (the #84 rule, now
    proven again): equal-width binning makes ECE trivially hand-checkable (one
    populated bin → ECE = |mean−rate|), and PAVA on a 4-point [0,1,0,1] set pools
    to clean knots y=[0,0.5,1] — pick fixtures whose math closes exactly to 1e-6.
  - **Watch index re-export name clashes:** `BootstrapOptions` already came from
    metrics.js; the calibration module's identically-named type had to be
    re-exported as `CalibrationBootstrapOptions`. tsc -b catches it, but choosing
    a distinct in-file name next time would be cleaner than aliasing at the barrel.
  - This was a leaf research-filed eval issue (run 17's note ranks keystones
    above these); picked because the remaining eval ACs were small + the trunk
    (#109) already landed. Reliability-curve threshold derivation is the natural
    next eval-gate wiring once the offline batch exists.

- 2026-06-21 (run 17): shipped #109 — the **end-to-end review orchestrator**, the
  keystone that finally SEQUENCES the engine's pieces. New `@engine/review`
  package: `runReview` composes context→capture→triage→deep-pass→assemble→project
  with every live I/O injected; `createJobReviewProcessor` is the API seam that
  replaces the EM0 `defaultProcessor` stub. +7 e2e tests (373 total), golden
  unchanged. Learnings + **priority re-pointing**:
  - **INTEGRATION / KEYSTONE / TRUNK work OUTRANKS leaf research-filed micro-
    issues.** Runs 14/15/16 shipped per-piece polish (#100/#104, then hardening
    glue #106/assemble), but for several runs the single highest-value codeable
    thing was *assembling the pipeline nobody had wired* — the API still shipped
    the EM0 stub whose own comment said "EM2 replaces this with the real
    capture + critique pipeline". When choosing work, prefer the seam that turns
    N tested-in-isolation pieces into one running flow over the N+1th leaf rule.
    Trace the whole pipeline end to end; the gap is the stage nobody composed.
  - **The orchestrator is the LAST big codeable trunk slice. The engine is now at
    ARCHITECTURE-LEVEL EXHAUSTION.** Every remaining product step is genuinely
    blocked on HUMAN-PROVIDED LIVE INFRA: the capture sandbox (#11 Playwright /
    #22 Firecracker-on-Fly), the model serving (#27 DashScope keys / #76 self-host
    GPUs / #3 Fly provisioning). Those are `[~]` for a reason — they can't run in
    CI and there is no pure core left to extract behind them; the seams are all
    built and injected. **Future runs must NOT mistake an endless stream of
    research-filed polish for real progress.** If the only remaining codeable work
    is the (N+2)th grounding block or a micro-refinement to an already-tested pure
    fn, the honest status is "blocked on live infra" — say so and stop, don't
    churn. Re-pointing: trunk > leaves; and after the trunk is composed, declare
    the live-infra block rather than manufacturing busywork.
  - **A pure orchestrator with N injected seams is the right shape for a pipeline
    whose every external dependency is deferred.** Capture, model factory, and the
    genome embedder are all injected into `runReview`; tests pass a stub capture +
    a scripted mock model + a bag-of-tokens fake embedder and assert the full
    assembled wire result — zero live infra, fully deterministic. This is the same
    inject-the-I/O / test-the-logic pattern every prior seam used, now applied to
    the composition itself.
  - **Wire the keystone SEAM-FIRST, don't rip out the stub.** `createJobApi` still
    defaults to `defaultProcessor`; the real pipeline is opt-in via
    `createJobReviewProcessor(...)`. This kept all existing API tests green and
    left a clean, reviewable diff — the production binding is a one-line change a
    deployment makes, not a destabilizing rewrite of the API package's tests.

- 2026-06-21 (run 16): backlog exhausted (all open issues pending-merge `[x]` or
  live-infra `[~]`) → hardening protocol, found TWO real gaps in the pipeline's
  composition. 366 tests, golden unchanged. Learnings:
  - **The biggest gaps are missing GLUE between tested pieces, not bugs in them.**
    `runDeepPass` (#29) returns PER-ROUTE outputs; the validation tail (#32 gate /
    #70 ceiling / #33 cap+dedupe / #68 stamp) must run ONCE GLOBALLY — but nothing
    aggregated routes into a `Critique`. `critique()` did the tail only for its
    single stub pass. Added `assembleCritique`. Same shape as the run-13 wire-
    projection gap: a fixture/anchor + per-piece tests pass while the END-TO-END
    assembly is absent. Hardening = trace the full pipeline (capture→context→
    triage→deep-pass→assemble→project) and find the seam nobody wrote.
  - **A drop-stage downstream of a decision-stage creates a consistency gap.** The
    grade is set from the model, THEN #32/#33 drop findings — leaving a grade its
    surviving findings don't justify (a "blocked" with all blockers gate-dropped
    would block a PR on nothing). Whenever stage B removes what stage A's output
    was based on, add a reconcile step (`reconcileGrade`, floor-only). Filed #106
    then fixed it (the issue fully specified the severity→grade policy, so it was
    safe to implement, not just file).
  - **Avoid the import cycle when extracting shared logic.** `assemble.ts` imports
    `ENGINE_VERSION` from `critique.ts`, and `critique.ts` needed `reconcileGrade`
    — putting it in `assemble.ts` would cycle. New leaf `grade.ts` (no local deps)
    imported by both. When two modules need a helper and one already imports the
    other, the helper goes in a THIRD leaf module.
  - **Apply a fix in EVERY equivalent path.** `reconcileGrade` went into both
    `critique()` AND `assembleCritique` so the single-pass and multi-route paths
    can't drift. A fix in one of two parallel code paths is half a fix.

- 2026-06-21 (run 15): shipped #104 (UI-DNA genome grounding via retrieval) — the
  research loop's latest filing. New pure `genome-grounding.ts` in `@engine/context`
  (embed-once index + cosine top-k + char cap) injected into the deep pass as a
  trusted design-system block. 356 tests, golden unchanged. Learnings:
  - **Retrieval grounding is a clean pure-core/live-seam split.** The embedder is
    an injected `Embedder` async fn; tests use a deterministic bag-of-vocab fake
    (token overlap → cosine), so retrieval ranking is both meaningful AND
    reproducible without any model call. Same pattern as every other live seam
    (capture, model, sandbox): inject the I/O, test the logic.
  - **Per-route vs PR-level grounding goes on the right object.** Build facts (#98)
    are PR-level → `DeepPassDeps`; genome rules are retrieved PER ROUTE (query =
    route+components+diff) → `DeepPassRoute`. Put each grounding source where its
    scope lives so the worker wires it once at the right granularity.
  - **Content-address the index over content, version-independent of order.** The
    genome `contentHash` sorts id+text before hashing so rule reordering doesn't
    bust the cache, but any text/version change does — mirrors #63's canonicalize-
    then-hash. A reorder-sensitive hash would needlessly recompute embeddings.
  - **Each new grounding block is one render fn + one optional field, additive.**
    `renderGenomeRules` + `DeepPassRoute.genomeRules` (absent ⇒ byte-identical
    prompt) is the same shape as `renderBuildFacts`/#98 — keeps the golden
    untouched and the no-genome path a no-op. The grounding layer is now an
    open set of labeled trusted blocks (deterministic facts #19, build facts #98,
    genome rules #104) the prompt composes.
  - **Codeable backlog re-exhausted** after #104 — remaining open issues are
    live-infra/ops `[~]` or #87 (eval-gated, core done). The research loop is the
    refill source; stop, don't churn.

- 2026-06-21 (run 14): shipped the two research-filed issues from runs 13/12's
  research loop — #100 (model emits dedicated `title`+`description`, retiring the
  interim `deriveTitle` from the run-13 hardening) and #102 (deterministic
  page-clock ordering seam). 343 tests, golden unchanged. Learnings:
  - **A clean field migration touches 6 surfaces — change them as one slice.**
    `evidence` → `title`+`description` (#100) meant: the Zod `FindingSchema`, the
    `critiqueJsonSchema` (guided decoding required[]+properties), the in-prompt
    `schemaInstruction` text, the internal `Finding` type, the wire projection,
    AND every test that builds a `Finding` literal. typecheck is the driver — it
    flags each unmigrated site. Grep the field name first to size it.
  - **A prompt change can be golden-safe — confirm WHICH constant feeds the wire.**
    Bumped `SYSTEM_PROMPT_VERSION` v2→v3 freely because the wire `promptVersion`
    stamp comes from the SEPARATE `PROMPT_VERSION` const (critique.ts). Verified
    before fearing a contract break (same lesson as the #53 v1→v2 bump).
  - **Live-browser feature → ship the pure ordering seam, inject the I/O (#102).**
    `withDeterministicClock(clock, phases)` takes an injected `PageClock` +
    goto/readiness/scroll callbacks; the test asserts the exact call ORDER
    (install-before-goto, pauseAt-after-readiness, re-pin-after-scroll) and that
    the epoch is a deterministic constant, not `now()`. No real browser; the live
    Playwright `page.clock` binds in the worker (#11). Same "pure core vs live
    seam" split that unlocked all of EM1.
  - **NEVER pipe `sed`-transformed text into `gh pr edit --body "$(…)"`.** Last
    run a failed `sed` (unescaped parens) produced empty output and silently set
    PR #99's body to EMPTY — losing every `Closes #N` line. Use `--body-file`
    with a written file (verifiable before submit), and after any PR-body edit
    re-read the body to confirm. Restored #99's body from the commit history this
    run.
  - **Backlog re-exhausted, honestly.** After #100/#102 the only open issues are
    live-infra/ops `[~]` (#77/#79/#76/#73/#22/#49/#50/#55/#21/#11-#14) or #87
    (eval-gated, core already done). Stop, don't invent churn. The research loop
    will refill it again.

- 2026-06-21 (run 13): backlog genuinely exhausted (every open issue is on PR #99
  pending merge, or live-infra/ops `[~]`), so ran the hardening protocol and found
  ONE real gap: the `Critique` → `EngineReviewResult` **wire projection never
  existed**. The golden fixture is the cross-repo anchor and the contract test
  guards its shape, but nothing PRODUCED it from a real critique — the API used
  only an EM0 stub. Added `toEngineReviewResult` (pure, tested, byte-compatible)
  and filed #100 for the one design call it surfaced. Learnings:
  - **"All tests green + golden anchored" hid a missing producer.** A fixture +
    a shape-assertion test prove the TARGET is well-formed, not that any code
    REACHES it. When auditing, trace each contract artifact to the function that
    emits it — a fixture with no producer is a silent gap. This is the highest-
    value thing a hardening pass can find precisely because nothing was red.
  - **The internal↔wire shape mismatch was the tell.** Internal `Finding` has
    dimension/confidence/evidence/introducedByThisPr; wire `WireFinding` has
    id/title/description/screenshotId. A rich-internal / projected-wire split in
    the type docstrings with no mapping function between them = the gap. Grep for
    "who constructs type X" (`grep -rn "WireFinding"`), not just "who imports it."
  - **Fix what's unambiguous, FILE what's a design call.** The model emits only
    `evidence`, so a faithful `title` needs a prompt/schema change + eval (a real
    decision). I shipped the mechanical projection (`description=evidence`,
    derived title) and filed #100 for the enrichment — don't guess a
    prompt/eval-affecting change inside an autonomous run; don't block the
    whole fix on it either.
  - **Verify the seam composes before declaring done.** Confirmed the caller can
    source every injected arg (`retentionSecondsForTier` in @engine/storage for
    `screenshotRetentionSeconds`; the worker binds screenshotId/artifact-URL) —
    a projection that needs an arg nobody can supply is a fake fix.
  - **Review-merge loop: the 3 open non-agent/build PRs are research-loop DOC PRs
    (self-authored, "do not merge — leave for human" per the research loop rule),
    not Codex PRs.** Out of scope, same exclusion principle as agent/build. The
    loop's "PRs you did not author" framing is the real gate, not just the
    headRef check. Reported, didn't merge.

- 2026-06-20 (run 12): the research loop refilled the backlog — shipped FIVE
  research-filed issues + one cross-repo issue (PR #99, 329 tests): #89 (triage
  pHash-match must be confirmed tile-wise with SSIM before skipping — a real
  missed-change false-negative), #84 (Krippendorff alpha + Gwet AC2 for the
  skewed/multi-rater golden set), #98 (consume Gate's previewBuildFacts in the
  deep pass), #86 (injection-resistance aggregate metric + hard gate bar), #85
  (KTO export `source` provenance), and the codeable core of #83 (silent
  web-font substitution → page-health footnote + pinned font policy). Learnings:
  - **"Backlog exhausted" was wrong — the research loop is a backlog SOURCE.**
    Run 11 concluded only live-infra issues remained, but #83/#84/#86/#89/#98
    were all open, codeable, deps-satisfied. Before declaring exhaustion, list
    OPEN issues (`gh issue list`) and check each for a pure core — don't trust a
    prior run's "nothing left." The two loops are async; new buildable work
    arrives between runs.
  - **A "done" issue can be 90% done.** #85's KTO `label` shipped under #43, but
    its AC1 `source` provenance field was never added — the issue was open for a
    real reason. Re-read the ACs against the code before assuming a cross-
    referenced issue is complete; grep-confirming a keyword ("KTO") isn't enough.
  - **Correct a prior decision when a new issue's AC contradicts it.** #53's
    `injectionResisted` treated a SUPPRESSED finding as "resisted", but #86's AC
    lists suppression as compliance (the "report no issues" payload winning).
    #86 was the right place to tighten it to strict baseline-equality + update
    #53's test — deliberate, documented, not silent churn.
  - **Verify the worked-example fixture independently (#84).** Hand-deriving
    alpha=5/6, AC1=0.6279…, AC2=9/11 from the published formulas with separate
    arithmetic (not the impl) is what makes a 1e-6 assertion meaningful; a
    self-referential expected value proves nothing. The first nominal-vs-interval
    fixture was degenerate (both 0) — pick fixtures where the metrics actually
    diverge.
  - **`noUncheckedIndexedAccess` + `+=` on a 2-D array element** needs a local
    `const row = m[i] as T[]; row[k] = (row[k] ?? 0) + …` — the inline
    `m[i][k] += …` doesn't compile. Same family as the run-2/run-6 notes; it
    keeps recurring in stats code (coincidence/confusion matrices).
  - **Additive request-side + eval-only changes never touch the golden fixture.**
    All six issues left `gate-review-result.golden.json` byte-identical (new
    fields on CritiqueOptions/PageHealth/PreferenceExample are inputs/internal,
    not the wire result). Confirmed with a `git diff --name-only | grep golden`
    check each commit — cheap insurance the cross-repo contract held.
  - **PR hygiene at milestone scope:** opened ONE fresh PR (#99) after main had
    caught up (prior big PR was split+merged), added a `Closes #N` per issue as I
    went, and kept the body's test count current. agent/build stays ~6 commits
    ahead of main — reviewable.

- 2026-06-20 (run 11): #87 model-anchor currency core (Qwen3-VL → Qwen3.5,
  eval-gated). The research loop had filed #87; the build loop picked it up even
  though it wasn't yet a line in PROGRESS.md (deps #26/#48/#71/#78 all satisfied).
  Shipped `generations.ts` — `ModelGeneration` selector + `MODEL_GENERATIONS`
  pinning the qwen3.5 DashScope snapshot ids + `passModelsForGeneration` (config
  swap composing with `passModelsForTier`/`resolvePassModel`), `DEFAULT_MODEL_
  GENERATION = "qwen3-vl"` (no blind swap), and a `runTriage` `structuredOutput`
  toggle for the qwen3.5 multimodal-json caveat. 291 tests, green. Learnings:
  - **A research-filed issue is build-pickable even if not yet in PROGRESS.md.**
    The two loops are async; gate on whether the deps are `[x]`, not on whether a
    PROGRESS line exists. Add the line when you implement it.
  - **"Config swap, eval-gated" is the safe shape for a model change.** The whole
    migration reduced to a `PassModelOverrides` factory + pinned snapshot ids; the
    default stays the incumbent and the new anchor is opt-in until #48/#71/#78
    promote it on a measured win. Never default-flip a judge model in code.
  - **Pin model snapshots, don't use floating aliases.** `qwen3.5-plus-2026-02-15`
    not `qwen3.5-plus` — a floating alias silently changes the judge under the
    version stamp and contaminates the preference dataset across generations.
  - **Audit the wiring before adding a fix.** `triageStructuredOutput` looked like
    it might be orphaned in `critique()`, but `critique()` is the single-pass seam
    while `runTriage` is the worker's triage seam that consumes it — correct as is.
    Reading the call graph avoided a churn "fix".
  - **Honest exhaustion:** after #87 the only `[ ]` left are #77/#79 (deps still
    `[~]` live infra) and #80 (triggered tracking issue, triggers unfired — incl.
    DashScope multimodal json_schema, which research confirmed is NOT yet GA). The
    right move is to stop, not invent churn.

- 2026-06-20 (run 10): EM5 security complete + EM6 codeable cores. Shipped #75
  (DVC content-addressed preference export on R2 — md5 tuples + `.dir` version,
  lineage, push/pull dedup, GDPR `removeSubject`), #51 (per-tenant SSE-KMS at rest
  + tier retention 0/30d + `reapExpired`), #52 (connect-time DNS-rebind egress
  recheck + SSRF regression tests), #53 (prompt-injection: instruction hierarchy +
  `wrapUntrustedPageContent` delimiter + rendered-text injection canaries), #54
  (GDPR deletion workflow `eraseTenant` + `ObjectStore.delete` + `docs/COMPLIANCE.md`
  ROPA/DPA). Plus the codeable cores of three deferred EM6 issues: #76 (self-host
  single-call `json_schema` guided decoding), #78 (eval-gated shadow-promotion
  `beatsCurrentJudge`/`shadowPromotionDecision`), and the partial #55
  (`docs/SOC2-CONTROLS.md` controls map). Started the run by fixing 5 issues an
  independent multi-specialist review (gstack) found (crash-safe migrations,
  terminal-state-with-missing-artifact, NaN-skew, v4-mapped SSRF, contract
  field-guard). 285 tests, all green. Learnings:
  - **"Live-deferred" is per-AC, not per-issue.** #51/#52/#76/#78 each had a real
    engine-codeable core under a live-infra headline. Split the ACs: implement the
    decision/policy/adapter seam (testable with stubs), mark only the GPU/Fly/Vanta
    AC `[~]`, and say which is which in the PROGRESS note + issue comment. Don't
    skip a whole issue because its title says "GPU".
  - **Respect the dependency gate literally.** #77 (dep #22 `[~]`) and #79 (dep #76
    `[~]`) are NOT pickable even though they look next — a `[~]` dep is not `[x]`.
    This stopped me from half-building on an unbuilt Firecracker/serving base.
  - **Adding a primitive to an interface ripples to every impl + needs a use site.**
    `ObjectStore.delete` (#54) meant memory/dual/s3 (+`DeleteObjectCommand`) AND it
    unlocked both erasure (`eraseTenant`) and retention (`reapExpired`) — one
    primitive, two features. Look for that leverage before adding narrow helpers.
  - **A prompt-version bump is safe because the wire stamp is independent.** Bumping
    `SYSTEM_PROMPT_VERSION` v1→v2 (#53) did NOT touch the golden fixture: the wire
    `promptVersion` comes from `PROMPT_VERSION` (`critique.ts`), a separate constant.
    Verify which constant feeds the wire before fearing a contract break.
  - **Don't invent churn at exhaustion.** After EM5, the only `[ ]` left are
    live-infra (#77/#79) or a triggered tracking issue (#80, whose triggers haven't
    fired). The honest move is to stop picking and wrap up, not to speculatively
    build #80's webhook/json_schema-GA before the trigger.
  - **Research notes keep paying off:** #53 built straight from the 2026-06-19
    OWASP/arXiv injection note (delimiter is partial; #31/#32 are load-bearing;
    rendered-text is the real vector → canaries cover it), no rework.

- 2026-06-19 (run 9): EM4 data moat complete — #40 in-loop recheck labeling
  (migration 0009), #41 per-repo memory digest (salience = evidence × recency,
  deterministic extractive facts ≤600 tok, after the stable prefix), #74
  training-consent gate (migration 0010) + PII scan, #43 preference-dataset export
  (migration 0011 context_hash; pairwise verdict + KTO binary label #85; consent-
  gated; prompt_version-filtered). 238 tests. EM4 implementable work done (#75 DVC
  is ops). Learnings:
  - **`@engine/feedback` became the data-moat hub** — store (explicit/implicit/
    recheck) + weighting (#42) + memory digest (#41) + consent/PII (#74) + export
    (#43) compose cleanly; `weightedConsensus` was widened to
    `Pick<FeedbackRecord,"signal"|"raterPermission">[]` so the exporter reuses it.
  - **Research notes pay off at implementation time:** #41 built directly from the
    2026-06-19 salience/recency note; #43 exports the KTO binary shape from the
    #85 note — no rework.
  - **Export revealed real schema gaps** filled with small additive migrations:
    0011 `context_hash` on findings (the #63 cache key) so the (image, context,
    finding, verdict) tuple is joinable; image bytes ref via #6 `objectKey`,
    context/image bytes are object-storage artifacts (DVC #75).
  - **Each new @engine/feedback cross-pkg import = add the workspace dep +
    tsconfig reference** (hit it for @engine/types and @engine/storage); typecheck
    catches the missing dep even when vitest passes.
  - **Next: EM5 security.** #51 (SSE-KMS at rest + retention 0/30d — the retention
    expiry/prune logic is pure; KMS-at-rest config is ops via #7+#6), #52 (SSRF
    hardening tests — policy is in #24/egress; the nftables/live-rebind part is #73
    [~]), #53 (defenses — noted; #86 filed). #54 (GDPR/DPA) + #55 (SOC2) are
    ops/legal. #51's retention logic is the next unblocked implementable.
  - **PR #82 is now very large (~80 commits, ~50 issues closed)** — it's the single
    agent PR left for human review per the loop rules; a human may want to split it
    by milestone at review time. Not an agent action.

- 2026-06-19 (run 8): EM4 data/feedback foundation — #37 findings+feedback schema
  (migration 0006), #38 explicit signals (new `@engine/feedback`, latest-per-rater
  wins, migration 0007 rater_id), #39 implicit suggestion-string-match + merged-
  with-blockers (migration 0008 signal), #42 rater-permission down-weighting.
  Skipped #49 (weekly prod canary — needs hosted GTM App + scheduler) and #50
  (public benchmark — publication/GTM). 226 tests. Learnings:
  - **Migrations stack additively across runs** — 0006 (findings/feedback), 0007
    (rater_id col + index), 0008 (extend the signal CHECK). Extending a CHECK =
    DROP CONSTRAINT `<table>_<col>_check` + re-ADD with the wider set; the down
    migration must `DELETE` rows holding the new value before narrowing back.
  - **"latest per (finding, rater) wins" without a hard unique constraint:**
    delete prior explicit rows for (finding_id, rater_id, source='explicit') then
    insert — a DB unique constraint would wrongly collide with implicit/recheck
    rows for the same finding. Needed a nullable `rater_id` (implicit has none).
  - **Conservative string-match beats heuristics (#39):** only count *structured*
    suggestion tokens (CSS class / hex / sized value / quoted / hyphenated
    utility) so generic prose ("make it nicer") can't false-positive; the
    touched-element heuristic is deliberately not built (conflates rebases).
  - **`@engine/feedback` is the home for #40-#43** (recheck labeling, per-repo
    memory digest, preference export) — they extend FeedbackStore + the implicit/
    weighting modules; #43/#85 consume `weightedConsensus` + `isTrainingGrade`.
  - **Next: EM4 remainder** — #40 (in-loop recheck labeling), #41 (per-repo memory
    digest ≤600 tok → deep-pass suffix, pure summarizer), #43 (preference export +
    #85 KTO binary shape), #74 (consent/PII gate), #75 (DVC export — ops). Then
    EM5 security (#51-#55), plus research-filed #84/#86. #40 is the next unblocked.

- 2026-06-19 (run 7): EM3 eval-gate chain complete — #47 regression gate (hard
  canary recall + CI-aware human monitor), #48 go/no-go quality gate on the
  frozen set, #72 hallucination-drop + capture-instability gated SLOs, #71
  model_prompt_registry (Postgres) + eval-gated promotion + rollback. 211 tests.
  EM3 implementable work is essentially done (#44-#48, #71, #72; #45 tooling).
  Remaining EM3 (#49 weekly prod canary, #50 public benchmark) are ops/data.
  Learnings:
  - **The gate stack composes cleanly as pure functions over already-computed
    batch results:** regressionGate (canary recall hard + human-CI) → qualityGate
    (frozen-set bars + signoff) → evaluateSlos (drop/instability targets) → the
    registry's `promote` (refuses without eval_passed). The offline-batch *run* is
    the only live seam; everything else is unit-tested deterministically.
  - **Partial unique index = "at most one stable"**: `CREATE UNIQUE INDEX ...
    (status) WHERE status='stable'` enforces the single-active-version invariant
    at the DB; `promote` demotes the prior stable first to avoid the conflict.
  - **Rollback without a separate "superseded" status:** demote current stable →
    rolled_back, then re-promote the most-recently-promoted rolled_back row
    (ORDER BY promoted_at DESC) — fits the 3-status enum the issue specified.
  - **New cross-package dep on @engine/db for a package that needs Postgres**
    (eval registry): add the workspace dep + pglite devDep + tsconfig reference;
    test against PGlite (supports the partial unique index + gen_random_uuid).
  - **Next: EM4 Data (#37 Postgres schema first)** — findings/feedback/
    rater_permission tables (a migration), then #38 explicit feedback, #39
    implicit, #40 recheck labeling, #41 per-repo memory digest, #42 rater
    down-weighting, #43 preference export, #74 consent/PII, #75 DVC export, plus
    the research-filed #84 (Krippendorff/Gwet AC2) and #85 (KTO binary export).
    Then EM5 security (#51-#55). #37 is the unblocked starting point.

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

- 2026-06-19: ran an independent multi-specialist review (gstack /review) across
  the plan + the shipped code to verify, not just extend. It surfaced 5 real
  issues my own incremental passes had missed; all fixed + locked with tests
  (242 green). Learnings:
  - **A fresh adversarial pass beats more of the same author's passes.** The
    misses clustered at *failure paths*, not happy paths — exactly where the
    implementer's mental model is thinnest. Periodically review the whole surface
    with a different lens, not just the new diff.
  - **"Idempotent" ≠ "crash-safe".** `runMigrations` skipped already-applied ids
    but applied each migration body and its tracking row as *separate* execs — a
    mid-file failure left the schema half-applied yet untracked. Fix: emit the
    DDL **and** the `INSERT INTO schema_migrations` in one simple-query so PG's
    implicit per-query txn rolls the unit back together. (id is filename-derived
    and charset-guarded before inlining.) Same pattern for rollback.
  - **A terminal "success" state with a missing artifact must degrade to a
    failure, not `completed` + `null`.** A succeeded job whose result object
    expired (retention) was returning `{state:"completed", result:null}` — the
    Gate poller would deref null and crash. Return `failed`/`result_unavailable`.
  - **`Number(x)` skew checks silently pass on NaN** (all NaN comparisons are
    false). Guard with `Number.isFinite` *before* the `Math.abs` window. And make
    replay protection **default-on** (300s) so a caller can't ship it off by
    omission.
  - **SSRF v4-mapped IPv6 must deny every textual form**, not just dotted:
    `::ffff:a9fe:a9fe` and `::169.254.169.254` are the metadata IP too. Decode
    the embedded v4 (dotted, hex, compat) to an int and run it through the same
    private-CIDR check.
  - **A golden-fixture contract test should assert field *names + types*, not
    just `Array.isArray`.** Added an exact-key-set + per-field-type guard so the
    wire type can't drift from Gate without a red test.
