import { createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_BUNDLE_MUTATIONS,
  buildNegativeCorpus,
  corruptBundle,
  signedContentBytes,
  type Ed25519SignerPort,
  type UnsignedDerivedEvidenceBundle,
} from "../src/index.js";

const unsigned = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/unsigned-bundle.example.json", import.meta.url)), "utf8"),
) as UnsignedDerivedEvidenceBundle;

function localSigner(keyId: string): { port: Ed25519SignerPort; rawPublicKey: Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { port: { keyId, sign: (m) => new Uint8Array(cryptoSign(null, Buffer.from(m), privateKey)) }, rawPublicKey };
}

const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
function verify(message: Uint8Array, signature: Uint8Array, rawPublic: Uint8Array): boolean {
  const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + rawPublic.length);
  spki.set(ED25519_SPKI_PREFIX, 0);
  spki.set(rawPublic, ED25519_SPKI_PREFIX.length);
  try {
    const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

describe("producer negative corpus (#156)", () => {
  it("builds one gate-rejectable bundle per mutation, each naming its expected gate code", async () => {
    const { port } = localSigner("k1");
    const corpus = await buildNegativeCorpus(unsigned, port);
    expect(corpus.map((c) => c.mutation).sort()).toEqual([...ALL_BUNDLE_MUTATIONS].sort());
    for (const c of corpus) expect(c.expectedGateCode).toBeTruthy();
  });

  it("IDENTITY mutations keep a VALID signature over the wrong bytes (gate rejects on binding, not signature)", async () => {
    const { port, rawPublicKey } = localSigner("k1");
    const cases: Array<["wrong_tenant" | "wrong_commit" | "wrong_dna_digest", (b: typeof unsigned) => unknown]> = [
      ["wrong_tenant", (b) => b.tenantId],
      ["wrong_commit", (b) => b.commitSha],
      ["wrong_dna_digest", (b) => b.uiDna.digest],
    ];
    for (const [mutation, field] of cases) {
      const c = await corruptBundle(unsigned, port, mutation);
      expect(c.signatureValidOverBytes).toBe(true);
      // the signature genuinely verifies over the (mutated) signed content
      const sig = new Uint8Array(Buffer.from(c.bundle.signature.value, "base64"));
      expect(verify(signedContentBytes(c.bundle), sig, rawPublicKey)).toBe(true);
      // but the bound identity field really changed vs the original
      expect(field(c.bundle as unknown as typeof unsigned)).not.toEqual(field(unsigned));
    }
  });

  it("INTEGRITY mutations break verification (tamper-after-sign / forged / unsigned)", async () => {
    const { port, rawPublicKey } = localSigner("k1");
    for (const mutation of ["tampered_after_signing", "forged_signature", "unsigned"] as const) {
      const c = await corruptBundle(unsigned, port, mutation);
      expect(c.signatureValidOverBytes).toBe(false);
      const sig = c.bundle.signature.value ? new Uint8Array(Buffer.from(c.bundle.signature.value, "base64")) : new Uint8Array();
      expect(verify(signedContentBytes(c.bundle), sig, rawPublicKey)).toBe(false);
    }
  });

  it("stale_major carries an unsupported schema version", async () => {
    const { port } = localSigner("k1");
    const c = await corruptBundle(unsigned, port, "stale_major");
    expect(c.bundle.schemaVersion).toBe("2.0.0");
    expect(c.expectedGateCode).toBe("unsupported_major");
  });
});
