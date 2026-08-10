# Security Policy

## This project is archived and unmaintained

Apature has been wound down. This repository is published as a historical
archive of the Judgment Engine. There is **no active security support**:

- No supported versions. Nothing here is patched, on any branch or tag.
- No security releases and no advisories will be published.
- No bug bounty. No reward of any kind is offered for a report.
- No response time commitment.

## Reporting a vulnerability anyway

If you find something and want to report it, use GitHub's private vulnerability
reporting: the **Security** tab of this repository, then **Report a
vulnerability**. That opens a private draft advisory rather than a public issue.

Please do not file a vulnerability as a normal public issue.

Be realistic about what happens next. A report here may go unread, and if it is
read, the most likely outcome is that it stays open. If the Security tab offers
no reporting option, there is no private channel at all. In either case, treat
the issue as permanently unfixed and act accordingly: fork and fix.

## Before you run this code

This was production-shaped infrastructure, not a toy, and that cuts both ways.
Read this before pointing it at anything you care about.

**Dependencies are frozen at their mid-2026 versions.** Automated dependency
updates have been turned off and nothing will be merged again. Assume the
lockfiles accumulate known CVEs from the archive date onward. Re-resolve
`pnpm-lock.yaml`, `rust/capture-dedup/Cargo.lock`, and the `python/*`
environments, and run your own scan, before running any of this.

**It expects real secrets.** The production composition root refuses to start
without `DATABASE_URL`, `ENGINE_HMAC_SECRET`, `MODEL_API_KEY`,
`OBJECT_STORE_ACCESS_KEY_ID`, `OBJECT_STORE_SECRET_ACCESS_KEY`, and
`CAPTURE_API_TOKEN`. `packages/secrets` implements a KMS envelope scheme and
log/trace redaction, but none of it has had an external security audit. Do not
give an unmaintained service your production credentials, your object store, or
customer data.

**Capture runs a real browser, and the isolation this design depends on is not
in this repository.** `captureWithBrowser` drives headless Chromium in your own
process. Capture is meant to render third-party preview deploys, meaning
attacker-influenced URLs and pages, and the design called for one Firecracker
microVM per job with `nftables` egress enforcement. That sandbox was never
implemented here. `packages/capture/src/egress.ts` holds the egress/SSRF policy,
including cloud-metadata endpoint blocking, but it is policy logic that nothing
enforces at the network layer, and the live capture path does not call it. Point
the CLI at pages you trust, or provide the isolation yourself.

**The API's only caller authentication is a shared HMAC secret.** There is no
user authentication; tenancy is caller-asserted and scoped by the HMAC over the
job contract. It was designed to sit behind Apature's own trust boundary, not on
the open internet.

**Model output is untrusted input.** Findings are schema-validated and passed
through the drop-and-count hallucination gate, but the resulting text is still
model-authored. Escape it wherever you render it. The instruction-hierarchy
defense against injection embedded in a screenshot lives in
`packages/critique/src/prompt.ts` and is sent on every deep pass, but treat it as
a partial mitigation: the load-bearing defenses are the schema-constrained output
and the grounding gate.

**`Dockerfile` and `fly.toml` are the old staging configuration.** They reflect
Apature's deployment, not a hardened general-purpose one. Review them rather
than reusing them as-is.

The MIT license's "AS IS, WITHOUT WARRANTY OF ANY KIND" applies in full, and
security is exactly where it applies.
