# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Anything else | No |

There are no tagged releases yet, so `main` is the supported version and security fixes land there.
When releases start, this table will list the supported line.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: the **Security** tab of this repository, then **Report
a vulnerability**. That opens a private draft advisory rather than a public issue. Please do not file
a vulnerability as a normal public issue.

Include what you need to make it reproducible: affected file or package, the version or commit, the
steps, and what an attacker gets out of it.

What to expect:

- **Acknowledgement within 3 business days.** If you have not heard anything by then, a public issue
  saying only "I sent a private report, please check" is a fine nudge and leaks nothing.
- **An initial assessment within 10 business days**, saying whether it is accepted, and if so the
  rough severity and the planned fix.
- **A fix on `main`** for accepted reports, with a GitHub Security Advisory published once the fix is
  out.
- **Credit** in the advisory unless you would rather stay anonymous.
- No bug bounty. This is not a funded program, and there is no monetary reward.

Coordinated disclosure: please give the fix a chance to land before publishing. 90 days is the
default window, and if a fix is going to take longer than that we will tell you rather than let the
clock run out silently.

## Threat model, and what is not defended yet

This is production-shaped infrastructure, so be deliberate about where you point it. These are known
and stated up front rather than discovered later. Several are roadmap items in
[README.md](README.md#status-and-roadmap).

**Capture runs a real browser and the isolating sandbox is not implemented.**
`captureWithBrowser` drives headless Chromium in your own process. Capture is meant to render
preview deploys, which means attacker-influenced URLs and pages. The design calls for one microVM per
job with `nftables` egress enforcement, and that sandbox is not in this repository.
`packages/capture/src/egress.ts` holds the egress/SSRF policy including cloud-metadata endpoint
blocking, but it is policy logic that nothing enforces at the network layer, and the live capture
path does not call it. Until that is wired, point the CLI at pages you trust or provide the isolation
yourself (a container with a locked-down egress policy is the practical answer today).

**Model output is untrusted input.** Findings are schema-validated and passed through the
drop-and-count hallucination gate, but the surviving text is still model-authored. Escape it wherever
you render it. The instruction-hierarchy defense against injection embedded in a screenshot lives in
`packages/critique/src/prompt.ts` and is sent on every deep pass; treat it as a partial mitigation.
The load-bearing defenses are the schema-constrained output and the grounding gate, which bound what
a compliant model could actually emit.

**The service's only caller authentication is a shared HMAC secret.** There is no user
authentication; tenancy is caller-asserted and scoped by the HMAC over the job contract. It is
designed to sit behind your own trust boundary, not on the open internet. Do not expose
`packages/runtime` directly.

**Secrets handling has not had an external audit.** The production composition root refuses to start
without `DATABASE_URL`, `ENGINE_HMAC_SECRET`, `MODEL_API_KEY`, `OBJECT_STORE_ACCESS_KEY_ID`,
`OBJECT_STORE_SECRET_ACCESS_KEY` and `CAPTURE_API_TOKEN`. `packages/secrets` implements a KMS
envelope scheme plus log and trace redaction, and it is unit-tested, but no third party has reviewed
it.

**No rate limiting is wired.** `packages/redis` implements the token bucket, per-tenant quota and
fairness gate, but nothing imports it, so the service runs unthrottled. Put your own limits in front
of it.

**`Dockerfile` and `fly.toml` are a starting point.** They build and smoke-test in CI. They are not a
hardened production configuration; review them before deploying rather than reusing them unchanged.

**Dependencies.** `pnpm-lock.yaml`, `rust/capture-dedup/Cargo.lock` and the `python/*` environments
are pinned so builds are reproducible. Run your own scan against your own policy before deploying,
and open an issue or a pull request if you find a lockfile entry that needs bumping.

## Scope

In scope: anything in this repository, including the capture lifecycle, the API's authentication and
idempotency handling, the job store, secret handling, and the grounding and injection defenses.

Out of scope: vulnerabilities in third-party dependencies with no exploitable path through this code
(report those upstream), and the known gaps listed above, which are tracked in the roadmap rather
than as vulnerabilities. If you can show one of those gaps is exploitable in a way the roadmap does
not describe, that is in scope and worth reporting.
