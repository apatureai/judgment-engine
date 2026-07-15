import { createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bundleCanonicalDigest,
  buildDerivedEvidenceBundle,
  BundleIntegrityError,
  canonicalBytes,
  signDerivedEvidenceBundle,
  type BuildBundleInput,
  type Ed25519SignerPort,
  type UnsignedDerivedEvidenceBundle,
} from "../src/index.js";

/**
 * The cross-repo golden: the RFC 8785 canonical digest of the shared example
 * bundle. Entropy's `EvidenceAcceptanceGate` recomputes this exact digest from
 * the same bytes, so pinning it here anchors byte-for-byte agreement across the
 * two repositories. If this changes, the entropy consumer golden must change in
 * lock-step (both-sides CI drift check).
 */
const GOLDEN_DIGEST = "sha256:418ba460a58cc440aa388e9db64922fc32d8a57c27014cf935c9110602942904";

const unsignedExample = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/unsigned-bundle.example.json", import.meta.url)), "utf8"),
) as UnsignedDerivedEvidenceBundle;

/** A local Ed25519 signer for the test — production wires a KMS-backed port. */
function localSigner(keyId: string): { port: Ed25519SignerPort; rawPublicKey: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return {
    port: { keyId, sign: (m) => new Uint8Array(cryptoSign(null, Buffer.from(m), privateKey)) },
    rawPublicKey,
  };
}

/** Mirror of Entropy's `nodeEd25519Verifier` — proves the gate would verify the signature. */
const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
function verifyEd25519(message: Uint8Array, signature: Uint8Array, rawPublic: Uint8Array): boolean {
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + rawPublic.length);
  spki.set(ED25519_SPKI_PREFIX, 0);
  spki.set(rawPublic, ED25519_SPKI_PREFIX.length);
  const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signature));
}

describe("DerivedEvidenceBundleV1 canonical digest — cross-repo golden (#156)", () => {
  it("computes the pinned RFC 8785 canonical digest for the shared example bundle", () => {
    expect(bundleCanonicalDigest(unsignedExample)).toBe(GOLDEN_DIGEST);
  });

  it("identity is stable under input key reordering (display metadata cannot change the digest)", () => {
    const reordered = Object.fromEntries(Object.entries(unsignedExample).reverse()) as UnsignedDerivedEvidenceBundle;
    expect(bundleCanonicalDigest(reordered)).toBe(GOLDEN_DIGEST);
  });
});

describe("signDerivedEvidenceBundle — a bundle Entropy's gate accepts (#156, TRD §3.2)", () => {
  it("produces sha256:<hex> digest + base64 Ed25519 signature over the same canonical bytes", async () => {
    const { port, rawPublicKey } = localSigner("je-signing-key-2026-07");
    const signed = await signDerivedEvidenceBundle(unsignedExample, port);

    expect(signed.signature).toMatchObject({ algorithm: "Ed25519", keyId: "je-signing-key-2026-07", canonicalization: "RFC8785" });
    expect(signed.signature.digest).toBe(GOLDEN_DIGEST);

    // Re-run the gate's exact verification path: strip signature → canonicalize →
    // sha256 must equal the digest; base64 value must Ed25519-verify.
    const { signature: _omit, ...rest } = signed;
    const canonical = canonicalBytes(rest);
    expect(`sha256:${createHash("sha256").update(canonical).digest("hex")}`).toBe(signed.signature.digest);
    expect(verifyEd25519(canonical, new Uint8Array(Buffer.from(signed.signature.value, "base64")), rawPublicKey)).toBe(true);
  });

  it("a tampered field fails the digest check (the gate rejects it)", async () => {
    const { port, rawPublicKey } = localSigner("k");
    const signed = await signDerivedEvidenceBundle(unsignedExample, port);
    const tampered = { ...signed, commitSha: "deadbeef" };
    const { signature: _omit, ...rest } = tampered;
    const canonical = canonicalBytes(rest);
    // digest no longer matches, and the signature is over the original bytes.
    expect(`sha256:${createHash("sha256").update(canonical).digest("hex")}`).not.toBe(signed.signature.digest);
    expect(verifyEd25519(canonical, new Uint8Array(Buffer.from(signed.signature.value, "base64")), rawPublicKey)).toBe(false);
  });
});

describe("buildDerivedEvidenceBundle (#156)", () => {
  const base: BuildBundleInput = {
    bundleId: "b1",
    requestId: "r1",
    tenantId: "t1",
    repositoryId: "acme/app",
    commitSha: "abc123",
    uiDna: { version: "dna_1", digest: "sha256:aa" },
    execution: { profileId: "p", profileVersion: "1", sandboxProfile: "s", repositoryCodeExecuted: false, executedInputs: [], adapterRuns: [] },
    repositoryManifestRef: "ref://m",
    repositoryManifestHash: "sha256:m",
    evidenceIrRef: "ref://ir",
    evidenceIrHash: "sha256:ir",
    uiGraphSnapshotRefs: [],
    artifactRefs: [],
    coverage: [],
    diagnostics: [],
    generatedAt: "2026-07-15T00:00:00Z",
    producerVersion: "1.4.0",
  };

  it("stamps the schema version + judgment-engine producer and is deterministic", () => {
    const a = buildDerivedEvidenceBundle(base);
    expect(a.schemaVersion).toBe("1.0.0");
    expect(a.producer).toEqual({ service: "judgment-engine", version: "1.4.0" });
    expect(bundleCanonicalDigest(a)).toBe(bundleCanonicalDigest(buildDerivedEvidenceBundle(base)));
  });

  it("enforces the static-only invariant: executedInputs must be empty when code was not executed", () => {
    expect(() =>
      buildDerivedEvidenceBundle({
        ...base,
        execution: { ...base.execution, repositoryCodeExecuted: false, executedInputs: [{ kind: "configuration", path: "x", contentHash: "sha256:x" }] },
      }),
    ).toThrow(BundleIntegrityError);
  });
});
