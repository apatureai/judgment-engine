# Apature Judgment Engine - Product Requirements Document

Created: 2026-06-15
Source: extracted from Apature's internal product spec as of 2026-06-15.

## 1. Product Summary

Apature Judgment Engine is the shared technical substrate behind Apature's product surfaces. It captures rendered UI, extracts repository context, runs grounded VLM critique, validates findings, records feedback, and exposes a stable `critique(images, context) -> Findings` contract to Gate, MCP Review, UI DNA, Entropy Engine, and Source Of Truth.

It is not a buyer-facing product. It is the reusable engine that makes the products credible.

## 2. Responsibilities

Judgment Engine owns the parts that make a generic vision model act like a trusted reviewer:

- deterministic capture,
- repo-specific design context,
- model abstraction,
- schema validation,
- evaluation harness,
- feedback labels,
- privacy and security controls,
- operational reliability.

## 3. Consumers

Internal consumers:

- Gate: PR review and Check Run delivery.
- MCP Review: in-loop review and recheck tools.
- UI DNA: extraction and rendered visual evidence.
- Entropy Engine: rendered drift evidence and feedback loops.
- Source Of Truth: approved context blocks and provenance.

## 4. Scope

In scope:

- Playwright capture pipeline.
- Sandbox and egress controls.
- Screenshot tiling, resizing, and coordinate normalization.
- DOM geometry, accessibility tree, computed style, console and network capture.
- Repo context extraction: tokens, design config, route mapping, component library detection, diff context.
- Qwen3-VL model adapter and swappable model interface.
- Structured output coercion and post-parse validation.
- Deterministic checks for contrast, overflow, touch targets, and referential validity.
- Evaluation harness, canaries, and regression gates.
- Feedback store and preference dataset export.
- Shared observability, secrets, storage, and rate-limiting primitives.

Out of scope:

- GitHub PR comment UX. Gate owns that.
- MCP tool UX. MCP Review owns that.
- Product dashboards and buyer-facing workflows except shared data APIs.
- Code edits, commits, or generated fixes.

## 5. Core Contract

Primary interface:

```ts
critique(images, context) -> Findings
```

The contract must be stable enough that product surfaces can evolve independently.

Required output:

- Overall grade.
- Findings with dimension, severity, confidence, route, viewport, element reference, evidence, suggestion, and introduced-by-this-PR flag.
- Not-reviewed reasons.
- Validation metadata.
- Model, prompt, capture, and context versions.

## 6. Capture Requirements

Capture must prioritize trust over cleverness.

Required behavior:

- `domcontentloaded` navigation, then explicit readiness signals.
- Never use `networkidle` as the readiness arbiter.
- Wait for fonts.
- Freeze animations and emulate reduced motion.
- Scroll once for lazy loading.
- Use perceptual hash stability checks.
- Tile long pages at viewport height with overlap.
- Capture mobile, tablet, and desktop when requested.
- Capture dark mode from a fresh context before navigation.
- Record DOM geometry and deterministic style facts.
- Mark unstable or partially reviewed pages explicitly.

## 7. Context Requirements

Context extraction must ground the model in the actual repo.

Required extractors:

- Tailwind v3 resolved config in a sandboxed worker.
- Tailwind v4 `@theme` and `@config` via PostCSS.
- CSS custom properties.
- W3C or Style Dictionary token files.
- Component library detection.
- `.designreview.yml` brand block.
- Diff-to-route mapping.
- Repo README and approved visual anchors where available.

Context blocks must be deterministic and versioned.

## 8. Model Requirements

Current default:

- Qwen3-VL.
- DashScope path for v1.
- Self-hosted vLLM or SGLang for enterprise data residency (deferred).

Rules:

- Models sit behind the shared interface.
- DashScope structured JSON uses a two-step path when thinking and JSON mode conflict.
- Zod or equivalent validation remains mandatory after model output.
- Findings referencing unknown routes or element refs are dropped.
- Hallucination drops are emitted as metrics.
- Claude-era image and cache constants are not canonical for Qwen3-VL.

## 9. Evaluation

Before product launch, Judgment Engine must support:

- Synthetic canary generator.
- Human-labeled PR snapshot set.
- Precision and recall by dimension.
- Blocker recall.
- Nit precision.
- Weighted kappa with confidence intervals.
- Hard regression gate on canary recall.
- Monitored human eval set with confidence intervals.
- Weekly production injected-defect canaries.

## 10. Data And Learning

Judgment Engine owns the feedback substrate:

- findings table,
- feedback table,
- rater permission weighting,
- in-loop recheck labels,
- per-repo memory digest generation,
- preference dataset export,
- prompt and rubric evolution metadata.

Label quality is load-bearing, so automated link unfurlers and weak implicit signals must not contaminate labels.

## 11. Security And Privacy

Required controls:

- No `contents: write` permissions.
- SSRF hardening with DNS rebind checks.
- Deny internal, metadata, and link-local egress.
- Allow public asset egress with limits so pages render honestly.
- Screenshots encrypted at rest.
- Tenant-scoped keys with per-repo data keys.
- Auth storage state encrypted, origin-scoped, and disabled on fork PRs.
- Prompt-injection defenses for DOM text and rendered screenshot text.
- Apature manages model serving by default; consumers never bring or manage a model key.
- Self-hosted / in-VPC path for enterprise data residency, when screenshots must stay in the customer's cloud.

## 12. Operations

Shared operational primitives:

- Redis queues and token buckets.
- Neon/Postgres schema and migrations.
- Object storage and signed URL service.
- OpenTelemetry traces.
- Grafana dashboards and alerts.
- KMS-backed secrets.
- Fly.io/Fly Machines substrate where applicable.

Operational choices should stay behind interfaces so product surfaces do not depend on vendor-specific details.

## 13. Success Metrics

Quality:

- Eval precision and recall by dimension.
- Hallucination-drop rate.
- Capture instability rate.

Reliability:

- End-to-end critique latency.
- Queue backpressure.
- Model rate-limit incidents.
- Stale-review prevention success.

Data:

- Labeled finding tuples.
- Recheck resolution labels.
- Per-repo memory quality.

Reuse:

- Number of product surfaces using the shared interface.
- API stability across product repos.

## 14. Repository Boundary

This repo owns shared judgment infrastructure. It should stay product-surface agnostic and expose clean contracts to the repos that ship customer-facing workflows.
