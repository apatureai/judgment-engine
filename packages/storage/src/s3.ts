import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStore, PutOptions } from "./types.js";

/**
 * Presign function dependency, injected so the adapter is testable without the
 * network. Defaults to the real `@aws-sdk/s3-request-presigner` implementation.
 */
export type Presigner = (
  client: S3Client,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

/**
 * S3-API object store. The same adapter serves Cloudflare R2 (S3-compatible):
 * point the injected `S3Client` at the R2 endpoint. Signed GET URLs are minted
 * on demand with a short TTL and never persisted.
 */
export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly presign: Presigner = getSignedUrl as unknown as Presigner,
  ) {}

  async put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts?.contentType,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = res.Body;
    if (!body) return null;
    return body.transformToByteArray();
  }

  async signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.presign(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }
}
