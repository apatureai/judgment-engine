import type { ObjectStore, PutOptions } from "./types.js";

interface StoredObject {
  body: Uint8Array;
  contentType?: string;
}

/**
 * In-memory `ObjectStore` for tests. `signedGetUrl` returns a deterministic URL
 * carrying the expiry so TTL behaviour can be asserted without a live bucket.
 */
export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  constructor(private readonly scheme = "memory") {}

  async put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<void> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    this.objects.set(key, { body: bytes, contentType: opts?.contentType });
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.body ?? null;
  }

  async signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    const expires = Date.now() + ttlSeconds * 1000;
    return `${this.scheme}://${key}?expires=${expires}`;
  }

  /** Test helper: whether an object exists. */
  has(key: string): boolean {
    return this.objects.has(key);
  }

  /** Test helper: stored content type for a key. */
  contentType(key: string): string | undefined {
    return this.objects.get(key)?.contentType;
  }
}
