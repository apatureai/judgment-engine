import { describe, expect, it } from "vitest";
import {
  EnvSecretStore,
  LocalKms,
  MAX_REDACT_DEPTH,
  MAX_REDACT_NODES,
  openRepoSecret,
  redact,
  REDACTED,
  sealRepoSecret,
  TRUNCATED_MAX_DEPTH,
  TRUNCATED_MAX_NODES,
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

  it("keeps a shared (non-circular) sub-object on both siblings, not '[Circular]'", () => {
    // A diamond/DAG: the same object referenced by two siblings is not a cycle.
    // It must be redacted on BOTH paths, never collapsed to "[Circular]" (which
    // would silently drop the second occurrence from the log line).
    const shared = { color: "#fff", route: "/pricing" };
    const out = redact({ first: shared, second: shared }) as Record<string, unknown>;

    expect(out.first).toEqual({ color: "#fff", route: "/pricing" });
    expect(out.second).toEqual({ color: "#fff", route: "/pricing" });
    // A deep copy: the clones are independent, not aliases of the input.
    expect(out.first).not.toBe(shared);
    expect(out.second).not.toBe(shared);
  });

  it("still breaks genuine cycles with '[Circular]'", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redact(cyclic) as Record<string, unknown>;

    expect(out.a).toBe(1);
    expect(out.self).toBe("[Circular]");

    // Cycle through an array is broken too.
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(redact(arr)).toEqual([1, "[Circular]"]);
  });

  it("bounds a deep, shared-reference-heavy graph quickly instead of blowing up", () => {
    // Nested diamond: each level references the level below it twice, so the
    // number of *paths* doubles per level. Path-based cycle tracking correctly
    // keeps this a DAG (no false [Circular]), but without a cap it would be
    // re-walked exponentially. 40 levels = ~2^40 paths, which must stay bounded.
    let node: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 40; i++) {
      node = { left: node, right: node, depth: i };
    }

    const started = Date.now();
    const out = redact(node);
    const elapsedMs = Date.now() - started;

    // Fast: without the cap this took ~11s; bounded it is well under a second.
    expect(elapsedMs).toBeLessThan(1000);

    // Bounded: the serialized output cannot be astronomically large.
    const size = JSON.stringify(out).length;
    expect(size).toBeLessThan(2_000_000);

    // The bound is actually exercised: a truncation sentinel appears somewhere.
    expect(JSON.stringify(out)).toContain("[Truncated:");
  });

  it("truncates past the max depth with a depth sentinel", () => {
    // A single deep chain (no sharing) exceeds MAX_REDACT_DEPTH before it could
    // exhaust the node budget, so it collapses with the depth sentinel.
    let node: Record<string, unknown> = { end: true };
    for (let i = 0; i < MAX_REDACT_DEPTH + 20; i++) {
      node = { next: node };
    }

    let cursor = redact(node) as Record<string, unknown>;
    let depth = 0;
    while (cursor && typeof cursor === "object" && "next" in cursor) {
      cursor = cursor.next as Record<string, unknown>;
      depth++;
    }
    expect(cursor).toBe(TRUNCATED_MAX_DEPTH);
    expect(depth).toBe(MAX_REDACT_DEPTH);
  });

  it("truncates a very wide graph with the node sentinel", () => {
    // A flat array wider than the node budget collapses trailing entries to the
    // node sentinel rather than the depth one.
    const wide = Array.from({ length: MAX_REDACT_NODES + 100 }, () => ({ x: 1 }));
    const out = redact(wide) as unknown[];
    expect(out).toContain(TRUNCATED_MAX_NODES);
    expect(out).not.toContain(TRUNCATED_MAX_DEPTH);
  });

  it("still breaks a cycle that also contains a shared (non-cyclic) ref", () => {
    // The shared object is referenced twice (DAG), and the graph also contains a
    // real back-edge. The shared ref must survive on both paths while the true
    // cycle is still collapsed to [Circular].
    const shared = { token: "sk-shared-secret", route: "/pricing" };
    const root: Record<string, unknown> = { a: shared, b: shared };
    root.loop = root; // genuine cycle

    const out = redact(root) as Record<string, unknown>;

    // Sensitive key redacted on BOTH copies of the shared ref.
    expect((out.a as Record<string, unknown>).token).toBe(REDACTED);
    expect((out.b as Record<string, unknown>).token).toBe(REDACTED);
    // Non-sensitive field of the shared ref preserved on both paths.
    expect((out.a as Record<string, unknown>).route).toBe("/pricing");
    expect((out.b as Record<string, unknown>).route).toBe("/pricing");
    // The genuine cycle is still broken.
    expect(out.loop).toBe("[Circular]");
  });

  it("redacts a sensitive key under a shared/duplicated ref on ALL copies", () => {
    // Security invariant: a shared object carrying a secret is masked wherever it
    // appears, even when reached through many aliases.
    const shared = { apiKey: "sk-live-DEADBEEF", label: "prod" };
    const out = redact({ one: shared, two: shared, nest: { three: shared } }) as Record<
      string,
      unknown
    >;

    const serialized = JSON.stringify(out);
    // The raw secret never appears anywhere in the redacted output...
    expect(serialized).not.toContain("sk-live-DEADBEEF");
    // ...and every copy shows the mask.
    for (const copy of [
      out.one,
      out.two,
      (out.nest as Record<string, unknown>).three,
    ] as Record<string, unknown>[]) {
      expect(copy.apiKey).toBe(REDACTED);
      expect(copy.label).toBe("prod");
    }
  });
});
