import { describe, expect, it } from "vitest";
import {
  EnvSecretStore,
  LocalKms,
  openRepoSecret,
  redact,
  REDACTED,
  sealRepoSecret,
} from "../src/index.js";

const kms = LocalKms.fromPassphrase("test-root-key-passphrase");

describe("EnvSecretStore (one typed accessor)", () => {
  it("resolves a known secret from its env var", async () => {
    const store = new EnvSecretStore({ MODEL_API_KEY: "sk-test" });
    expect(await store.get("modelApiKey")).toBe("sk-test");
  });

  it("throws a typed error when a secret is missing", async () => {
    const store = new EnvSecretStore({});
    await expect(store.get("engineHmacSecret")).rejects.toThrow(/Missing secret: engineHmacSecret/);
  });
});

describe("per-repo secrets are stored KMS-encrypted", () => {
  it("seals storageState / protection_bypass to ciphertext and round-trips", async () => {
    const scope = { cmkId: "tenant_1", repoId: "acme/web" };
    const sealed = await sealRepoSecret("storageState", '{"cookies":[]}', scope, kms);

    expect(sealed.ciphertext).not.toContain("cookies");
    expect(await openRepoSecret("storageState", sealed, kms)).toBe('{"cookies":[]}');
  });

  it("does not let one secret kind be opened as another", async () => {
    const scope = { cmkId: "tenant_1", repoId: "acme/web" };
    const sealed = await sealRepoSecret("protectionBypass", "bypass-token", scope, kms);
    await expect(openRepoSecret("storageState", sealed, kms)).rejects.toThrow(/not a storageState/);
  });
});

describe("redact keeps secrets out of logs/traces", () => {
  it("masks sensitive keys and signed URLs / image data", () => {
    const logLine = redact({
      installationId: "1",
      storageState: '{"cookies":["session=abc"]}',
      protection_bypass: "bypass-token",
      apiKey: "sk-secret",
      screenshotUrl: "https://r2.example/x.png?X-Amz-Signature=deadbeef",
      thumbnail: "data:image/png;base64,AAAA",
      route: "/pricing",
    }) as Record<string, unknown>;

    expect(logLine.storageState).toBe(REDACTED);
    expect(logLine.protection_bypass).toBe(REDACTED);
    expect(logLine.apiKey).toBe(REDACTED);
    expect(logLine.screenshotUrl).toBe(REDACTED);
    expect(logLine.thumbnail).toBe(REDACTED);
    // Non-sensitive fields pass through unchanged.
    expect(logLine.installationId).toBe("1");
    expect(logLine.route).toBe("/pricing");
  });
});
