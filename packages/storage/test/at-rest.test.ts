import { GetObjectCommand, type PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  expiredKeys,
  InMemoryObjectStore,
  isExpired,
  objectKey,
  reapExpired,
  RETENTION_SECONDS,
  retentionSecondsForTier,
  S3ObjectStore,
  tenantKmsKeyId,
} from "../src/index.js";

describe("retention policy (§11, #51)", () => {
  it("defaults to 0 on free/public and 30 days on paid", () => {
    expect(retentionSecondsForTier("free")).toBe(0);
    expect(retentionSecondsForTier("public")).toBe(0);
    expect(retentionSecondsForTier("paid")).toBe(30 * 86_400);
    expect(RETENTION_SECONDS.paid).toBe(2_592_000);
  });

  it("treats a 0 window as ephemeral (always expired) and a positive window as time-bounded", () => {
    const now = 1_000_000_000_000;
    expect(isExpired({ uploadedAt: now, retentionSeconds: 0, now })).toBe(true);
    // within the 30d window -> retained
    expect(isExpired({ uploadedAt: now - 29 * 86_400_000, retentionSeconds: 30 * 86_400, now })).toBe(false);
    // past the 30d window -> expired
    expect(isExpired({ uploadedAt: now - 31 * 86_400_000, retentionSeconds: 30 * 86_400, now })).toBe(true);
  });

  it("expiredKeys selects only the objects past their retention", () => {
    const now = 2_000_000_000_000;
    const keys = expiredKeys(
      [
        { key: "free.png", uploadedAt: now, retentionSeconds: 0 },
        { key: "fresh-paid.png", uploadedAt: now - 86_400_000, retentionSeconds: 30 * 86_400 },
        { key: "stale-paid.png", uploadedAt: now - 40 * 86_400_000, retentionSeconds: 30 * 86_400 },
      ],
      now,
    );
    expect(keys).toEqual(["free.png", "stale-paid.png"]);
  });
});

describe("reapExpired (retention sweep ties policy -> deletion, #51)", () => {
  it("deletes only the expired objects and leaves retained ones", async () => {
    const now = 3_000_000_000_000;
    const store = new InMemoryObjectStore();
    await store.put("free.png", "a");
    await store.put("fresh.png", "b");
    await store.put("stale.png", "c");

    const reaped = await reapExpired(
      store,
      [
        { key: "free.png", uploadedAt: now, retentionSeconds: 0 },
        { key: "fresh.png", uploadedAt: now - 86_400_000, retentionSeconds: 30 * 86_400 },
        { key: "stale.png", uploadedAt: now - 40 * 86_400_000, retentionSeconds: 30 * 86_400 },
      ],
      now,
    );

    expect(reaped.sort()).toEqual(["free.png", "stale.png"]);
    expect(await store.get("free.png")).toBeNull();
    expect(await store.get("stale.png")).toBeNull();
    expect(await store.get("fresh.png")).not.toBeNull();
  });
});

describe("ObjectStore.delete", () => {
  it("removes an object and is idempotent on a missing key", async () => {
    const store = new InMemoryObjectStore();
    await store.put("k", "v");
    await store.delete("k");
    expect(await store.get("k")).toBeNull();
    await expect(store.delete("k")).resolves.toBeUndefined(); // no throw
  });
});

describe("tenantKmsKeyId (§11 hierarchy)", () => {
  it("paid tenants use their per-tenant CMK; free/public share the managed CMK", () => {
    const keys = { perTenantKeyId: "tenant-cmk", sharedKeyId: "shared-cmk" };
    expect(tenantKmsKeyId("paid", keys)).toBe("tenant-cmk");
    expect(tenantKmsKeyId("free", keys)).toBe("shared-cmk");
    expect(tenantKmsKeyId("public", keys)).toBe("shared-cmk");
    // Paid without a provisioned per-tenant key falls back to shared (never null).
    expect(tenantKmsKeyId("paid", { sharedKeyId: "shared-cmk" })).toBe("shared-cmk");
  });
});

describe("S3ObjectStore SSE-KMS at rest (#51)", () => {
  it("sends aws:kms + the per-tenant key id when kmsKeyId is set, and omits it otherwise", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fakeClient = {
      send: async (command: PutObjectCommand | GetObjectCommand) => {
        if (command instanceof GetObjectCommand) return { Body: null };
        sent.push(command.input as Record<string, unknown>);
        return {};
      },
    } as unknown as S3Client;

    const store = new S3ObjectStore(fakeClient, "engine-artifacts");
    const key = objectKey("job_1", "screenshot", "p.png");

    await store.put(key, new Uint8Array([1]), { contentType: "image/png", kmsKeyId: "tenant-cmk" });
    await store.put(key, new Uint8Array([1]), { contentType: "image/png" });

    expect(sent[0]).toMatchObject({
      Bucket: "engine-artifacts",
      Key: key,
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: "tenant-cmk",
    });
    expect(sent[1]).not.toHaveProperty("ServerSideEncryption");
    expect(sent[1]).not.toHaveProperty("SSEKMSKeyId");
  });
});
