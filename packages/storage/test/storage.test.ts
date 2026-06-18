import { GetObjectCommand, type PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  DualWriteObjectStore,
  InMemoryObjectStore,
  objectKey,
  S3ObjectStore,
  jobPrefix,
  type Presigner,
} from "../src/index.js";

describe("object keys", () => {
  it("namespaces every artifact under the job id", () => {
    expect(objectKey("job_1", "screenshot", "home-desktop.png")).toBe(
      "jobs/job_1/screenshots/home-desktop.png",
    );
    expect(objectKey("job_1", "critique", "result.json")).toBe("jobs/job_1/critique/result.json");
    expect(jobPrefix("job_1")).toBe("jobs/job_1/");
  });
});

describe("InMemoryObjectStore", () => {
  it("round-trips put/get keyed by job id and records content type", async () => {
    const store = new InMemoryObjectStore();
    const key = objectKey("job_1", "critique", "result.json");
    await store.put(key, '{"grade":"ship"}', { contentType: "application/json" });

    const bytes = await store.get(key);
    expect(bytes && new TextDecoder().decode(bytes)).toBe('{"grade":"ship"}');
    expect(store.contentType(key)).toBe("application/json");
    expect(await store.get("missing")).toBeNull();
  });

  it("mints a short-TTL signed URL on demand and never stores it", async () => {
    const store = new InMemoryObjectStore();
    const key = objectKey("job_1", "screenshot", "home.png");
    await store.put(key, new Uint8Array([1, 2, 3]));

    const before = Date.now();
    const url = await store.signedGetUrl(key, 60);
    const expires = Number(new URL(url).searchParams.get("expires"));
    // TTL is ~60s out and the URL is computed, not persisted (no setter exists).
    expect(expires).toBeGreaterThanOrEqual(before + 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe("DualWriteObjectStore", () => {
  it("writes to both R2 and S3, reads/signs from the primary", async () => {
    const r2 = new InMemoryObjectStore("r2");
    const s3 = new InMemoryObjectStore("s3");
    const store = new DualWriteObjectStore(r2, s3);
    const key = objectKey("job_2", "dom", "snapshot.json");

    await store.put(key, "dom");
    expect(r2.has(key)).toBe(true);
    expect(s3.has(key)).toBe(true); // fanned out to the secondary

    // Reads and signed URLs come from the primary (R2 = zero egress).
    expect(await store.get(key)).not.toBeNull();
    expect(await store.signedGetUrl(key, 30)).toMatch(/^r2:\/\//);
  });
});

describe("S3ObjectStore", () => {
  it("issues S3 PutObject/GetObject keyed by bucket + key and presigns on demand", async () => {
    const sent: Array<{ type: string; input: Record<string, unknown> }> = [];
    const fakeClient = {
      send: async (command: PutObjectCommand | GetObjectCommand) => {
        sent.push({ type: command.constructor.name, input: command.input as Record<string, unknown> });
        if (command instanceof GetObjectCommand) {
          return { Body: { transformToByteArray: async () => new Uint8Array([7, 8, 9]) } };
        }
        return {};
      },
    } as unknown as S3Client;

    const presigned: Array<{ key: unknown; expiresIn: number }> = [];
    const presign: Presigner = async (_client, command, options) => {
      presigned.push({ key: command.input.Key, expiresIn: options.expiresIn });
      return `https://signed.example/${String(command.input.Key)}?X-Expires=${options.expiresIn}`;
    };

    const store = new S3ObjectStore(fakeClient, "engine-artifacts", presign);
    const key = objectKey("job_3", "screenshot", "p.png");

    await store.put(key, new Uint8Array([1]), { contentType: "image/png" });
    const bytes = await store.get(key);
    const url = await store.signedGetUrl(key, 120);

    expect(bytes).toEqual(new Uint8Array([7, 8, 9]));
    expect(sent[0]).toMatchObject({
      type: "PutObjectCommand",
      input: { Bucket: "engine-artifacts", Key: key, ContentType: "image/png" },
    });
    expect(sent[1]).toMatchObject({ type: "GetObjectCommand", input: { Bucket: "engine-artifacts", Key: key } });
    expect(presigned).toEqual([{ key, expiresIn: 120 }]);
    expect(url).toContain("X-Expires=120");
  });
});
