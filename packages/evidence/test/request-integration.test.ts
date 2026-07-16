import { createHash, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertBundleBindsToRequest,
  bundleBindsToRequest,
  corruptBundle,
  EVIDENCE_REQUEST_SCHEMA_VERSION,
  RequestBindingError,
  signDerivedEvidenceBundle,
  signedContentBytes,
  type Ed25519SignerPort,
  type EvidenceRequestV1,
  type UnsignedDerivedEvidenceBundle,
} from "../src/index.js";

const unsigned = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/unsigned-bundle.example.json", import.meta.url)), "utf8"),
) as UnsignedDerivedEvidenceBundle;

/** The request the example bundle was produced for (binds by construction). */
const request: EvidenceRequestV1 = {
  schemaVersion: EVIDENCE_REQUEST_SCHEMA_VERSION,
  requestId: unsigned.requestId,
  tenantId: unsigned.tenantId,
  repositoryId: unsigned.repositoryId,
  commitSha: unsigned.commitSha,
  uiDna: { version: unsigned.uiDna.version, digest: unsigned.uiDna.digest },
};

function localSigner(keyId: string): { port: Ed25519SignerPort; rawPublicKey: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { port: { keyId, sign: (m) => new Uint8Array(cryptoSign(null, Buffer.from(m), privateKey)) }, rawPublicKey };
}

const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
function verifySig(message: Uint8Array, signature: Uint8Array, rawPublic: Uint8Array): boolean {
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + rawPublic.length);
  spki.set(ED25519_SPKI_PREFIX, 0);
  spki.set(rawPublic, ED25519_SPKI_PREFIX.length);
  try {
    return cryptoVerify(null, Buffer.from(message), createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" }), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Mirror of the gate's accept path: identity binding + digest + signature all hold. */
function gateWouldAccept(bundle: Parameters<typeof signedContentBytes>[0], req: EvidenceRequestV1, rawPublic: Uint8Array): boolean {
  if (!bundleBindsToRequest(bundle, req).bound) return false;
  const canonical = signedContentBytes(bundle);
  if (bundle.signature.digest !== `sha256:${createHash("sha256").update(canonical).digest("hex")}`) return false;
  if (!bundle.signature.value) return false;
  return verifySig(canonical, new Uint8Array(Buffer.from(bundle.signature.value, "base64")), rawPublic);
}

describe("EvidenceRequestV1 binding (#156)", () => {
  it("a bundle produced for a request binds to it; a mismatched field is named", () => {
    expect(bundleBindsToRequest(unsigned, request)).toEqual({ bound: true, mismatches: [] });
    expect(bundleBindsToRequest({ ...unsigned, commitSha: "x" }, request).mismatches).toEqual(["commitSha"]);
    expect(() => assertBundleBindsToRequest(unsigned, request)).not.toThrow();
    expect(() => assertBundleBindsToRequest({ ...unsigned, tenantId: "wrong" }, request)).toThrow(RequestBindingError);
  });
});

describe("end-to-end: request → signed bundle → gate accepts; altered fails closed (#156)", () => {
  it("a request-bound, signed bundle would be accepted by the gate", async () => {
    const { port, rawPublicKey } = localSigner("je-key");
    const bound = assertBundleBindsToRequest(unsigned, request);
    const signed = await signDerivedEvidenceBundle(bound, port);
    expect(gateWouldAccept(signed, request, rawPublicKey)).toBe(true);
  });

  it("an identity-forged copy (valid signature, wrong tenant) fails the binding check", async () => {
    const { port, rawPublicKey } = localSigner("je-key");
    const forged = await corruptBundle(unsigned, port, "wrong_tenant");
    // its signature is genuinely valid over its (wrong) bytes...
    expect(verifySig(signedContentBytes(forged.bundle), new Uint8Array(Buffer.from(forged.bundle.signature.value, "base64")), rawPublicKey)).toBe(true);
    // ...but it does not bind to the original request, so the gate rejects it.
    expect(gateWouldAccept(forged.bundle, request, rawPublicKey)).toBe(false);
    expect(bundleBindsToRequest(forged.bundle, request).mismatches).toContain("tenantId");
  });

  it("a tampered-after-signing copy fails the digest/signature check", async () => {
    const { port, rawPublicKey } = localSigner("je-key");
    const tampered = await corruptBundle(unsigned, port, "tampered_after_signing");
    expect(gateWouldAccept(tampered.bundle, request, rawPublicKey)).toBe(false);
  });
});
