import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  INSTALLATION_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signEngineRequest,
  verifyEngineRequest,
} from "../src/index.js";

/**
 * Unit coverage for the consumer -> engine HMAC handshake (TRD §8/§15.2). The
 * server integration tests exercise the happy path and a couple of failures over
 * HTTP; these lock down `verifyEngineRequest`/`signEngineRequest` directly so the
 * distinct `VerifyFailureReason` values and the security-relevant edge cases
 * (installationId binding, constant-time length handling, malformed signatures,
 * the anti-replay skew window) can't silently regress.
 */
const SECRET = "engine-hmac-secret";

/** Build a fully valid, verifiable request for a given body/installation. */
function validRequest(overrides: Partial<Parameters<typeof verifyEngineRequest>[0]> = {}) {
  const body = JSON.stringify({ idempotencyKey: "k1", depth: "deep" });
  const installationId = "inst-42";
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", SECRET)
    .update(`${timestamp}.${installationId}.${body}`)
    .digest("hex");
  return { body, installationId, timestamp, signature, secret: SECRET, ...overrides };
}

describe("signEngineRequest", () => {
  it("produces headers that verifyEngineRequest accepts (round-trip)", () => {
    const body = JSON.stringify({ prNumber: 7 });
    const headers = signEngineRequest({ body, installationId: "inst-1", secret: SECRET });

    expect(headers[INSTALLATION_HEADER]).toBe("inst-1");
    expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const result = verifyEngineRequest({
      body,
      installationId: headers[INSTALLATION_HEADER],
      timestamp: headers[TIMESTAMP_HEADER],
      signature: headers[SIGNATURE_HEADER],
      secret: SECRET,
    });
    expect(result).toEqual({ ok: true });
  });

  it("defaults the timestamp to now and honors an explicit one", () => {
    const headers = signEngineRequest({
      body: "",
      installationId: "inst-1",
      secret: SECRET,
      timestamp: 1_700_000_000_000,
    });
    expect(headers[TIMESTAMP_HEADER]).toBe("1700000000000");
  });
});

describe("verifyEngineRequest", () => {
  it("accepts a correctly signed request", () => {
    expect(verifyEngineRequest(validRequest())).toEqual({ ok: true });
  });

  it("accepts a signature with or without the sha256= prefix", () => {
    const req = validRequest();
    const withPrefix = { ...req, signature: `sha256=${req.signature}` };
    expect(verifyEngineRequest(withPrefix)).toEqual({ ok: true });
    expect(verifyEngineRequest(req)).toEqual({ ok: true });
  });

  it("reports missing_installation before checking the signature", () => {
    const req = validRequest({ installationId: "", signature: "" });
    expect(verifyEngineRequest(req)).toEqual({ ok: false, reason: "missing_installation" });
  });

  it("reports missing_signature when the signature header is absent", () => {
    expect(verifyEngineRequest(validRequest({ signature: "" }))).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("rejects a tampered body", () => {
    expect(verifyEngineRequest(validRequest({ body: '{"prNumber":999}' }))).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a signature made with the wrong secret", () => {
    const req = validRequest();
    const forged = createHmac("sha256", "not-the-secret")
      .update(`${req.timestamp}.${req.installationId}.${req.body}`)
      .digest("hex");
    expect(verifyEngineRequest({ ...req, signature: forged })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("binds installationId: swapping it after signing is rejected", () => {
    // Sign for one tenant, then present the same signature under another id.
    const req = validRequest();
    expect(verifyEngineRequest({ ...req, installationId: "inst-other" })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a malformed (non-hex) signature without throwing", () => {
    expect(verifyEngineRequest(validRequest({ signature: "not-hex-at-all" }))).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a length-mismatched signature without throwing (constant-time guard)", () => {
    // A short but valid-hex signature must not reach timingSafeEqual with unequal lengths.
    expect(verifyEngineRequest(validRequest({ signature: "abcd" }))).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  describe("anti-replay skew window", () => {
    it("does not check the timestamp when maxSkewMs is undefined", () => {
      const req = validRequest({ timestamp: "0" });
      // timestamp is stale but signed correctly; without a window it still passes.
      const signed = {
        ...req,
        signature: createHmac("sha256", SECRET)
          .update(`0.${req.installationId}.${req.body}`)
          .digest("hex"),
      };
      expect(verifyEngineRequest(signed)).toEqual({ ok: true });
    });

    it("accepts a timestamp within the window", () => {
      const now = 1_700_000_000_000;
      const timestamp = String(now - 1_000);
      const req = validRequest({ timestamp });
      const signed = {
        ...req,
        signature: createHmac("sha256", SECRET)
          .update(`${timestamp}.${req.installationId}.${req.body}`)
          .digest("hex"),
        maxSkewMs: 5_000,
        now,
      };
      expect(verifyEngineRequest(signed)).toEqual({ ok: true });
    });

    it("rejects a timestamp outside the window as timestamp_skew", () => {
      const now = 1_700_000_000_000;
      const timestamp = String(now - 60_000);
      const req = validRequest({ timestamp });
      const signed = {
        ...req,
        signature: createHmac("sha256", SECRET)
          .update(`${timestamp}.${req.installationId}.${req.body}`)
          .digest("hex"),
        maxSkewMs: 5_000,
        now,
      };
      expect(verifyEngineRequest(signed)).toEqual({ ok: false, reason: "timestamp_skew" });
    });

    it("rejects a future timestamp beyond the window (skew is absolute)", () => {
      const now = 1_700_000_000_000;
      const timestamp = String(now + 60_000);
      const req = validRequest({ timestamp });
      const signed = {
        ...req,
        signature: createHmac("sha256", SECRET)
          .update(`${timestamp}.${req.installationId}.${req.body}`)
          .digest("hex"),
        maxSkewMs: 5_000,
        now,
      };
      expect(verifyEngineRequest(signed)).toEqual({ ok: false, reason: "timestamp_skew" });
    });

    it("rejects a non-numeric timestamp instead of silently passing (NaN guard)", () => {
      const req = validRequest({ timestamp: "not-a-number" });
      const signed = {
        ...req,
        signature: createHmac("sha256", SECRET)
          .update(`not-a-number.${req.installationId}.${req.body}`)
          .digest("hex"),
        maxSkewMs: 5_000,
        now: 1_700_000_000_000,
      };
      expect(verifyEngineRequest(signed)).toEqual({ ok: false, reason: "timestamp_skew" });
    });

    it("checks the signature before the skew window (a forged stale request is a mismatch)", () => {
      // Skew failures must never mask an auth failure: bad signature wins.
      const req = validRequest({ timestamp: "1", signature: "deadbeef" });
      expect(verifyEngineRequest({ ...req, maxSkewMs: 5_000, now: 1_700_000_000_000 })).toEqual({
        ok: false,
        reason: "signature_mismatch",
      });
    });
  });
});
