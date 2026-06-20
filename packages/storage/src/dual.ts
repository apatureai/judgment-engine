import type { ObjectStore, PutOptions } from "./types.js";

/**
 * Writes every object to two backends (R2 primary + S3 secondary) so artifacts
 * survive a single-provider outage. Reads and signed URLs come from the primary
 * (R2) for zero-egress (TRD §7.1); the secondary is durability/DR.
 */
export class DualWriteObjectStore implements ObjectStore {
  constructor(
    private readonly primary: ObjectStore,
    private readonly secondary: ObjectStore,
  ) {}

  async put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<void> {
    await Promise.all([this.primary.put(key, body, opts), this.secondary.put(key, body, opts)]);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.primary.get(key);
  }

  async delete(key: string): Promise<void> {
    // Erasure/retention must purge BOTH copies, or the secondary keeps the data.
    await Promise.all([this.primary.delete(key), this.secondary.delete(key)]);
  }

  async signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.primary.signedGetUrl(key, ttlSeconds);
  }
}
