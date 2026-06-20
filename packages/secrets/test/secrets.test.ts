import { describe, expect, it } from "vitest";
import { LocalKms, openForRepo, sealForRepo } from "../src/index.js";

const kms = LocalKms.fromPassphrase("test-root-key-passphrase");

describe("per-repo envelope encryption", () => {
  it("round-trips a secret sealed under a per-tenant CMK + per-repo DEK", async () => {
    const scope = { cmkId: "tenant_42", repoId: "acme/web" };
    const sealed = await sealForRepo("super-secret-token", scope, kms);

    // The envelope carries only ciphertext + wrapped DEK, never plaintext.
    expect(sealed.ciphertext).not.toContain("super-secret-token");
    expect(sealed.cmkId).toBe("tenant_42");

    expect(await openForRepo(sealed, kms)).toBe("super-secret-token");
  });

  it("generates a distinct DEK + ciphertext per seal (fresh per-repo data key)", async () => {
    const scope = { cmkId: "tenant_42", repoId: "acme/web" };
    const a = await sealForRepo("same", scope, kms);
    const b = await sealForRepo("same", scope, kms);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(await openForRepo(a, kms)).toBe("same");
    expect(await openForRepo(b, kms)).toBe("same");
  });

  it("binds the secret to its repo: tampering the repoId fails authentication", async () => {
    const sealed = await sealForRepo("token", { cmkId: "tenant_42", repoId: "acme/web" }, kms);
    const crossRepo = { ...sealed, repoId: "acme/other" };
    await expect(openForRepo(crossRepo, kms)).rejects.toThrow();
  });

  it("isolates tenants: a different CMK cannot unwrap the DEK", async () => {
    const sealed = await sealForRepo("token", { cmkId: "tenant_42", repoId: "acme/web" }, kms);
    const wrongCmk = { ...sealed, cmkId: "tenant_99" };
    await expect(openForRepo(wrongCmk, kms)).rejects.toThrow();
  });

  it("rejects a too-short root key", () => {
    expect(() => new LocalKms(Buffer.alloc(16))).toThrow(/at least 32 bytes/);
  });
});
