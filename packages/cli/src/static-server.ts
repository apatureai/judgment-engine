import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";

/**
 * Minimal static file server for the bundled demo site, so the quickstart needs
 * no external service, no network access and no port guessing. It binds to
 * 127.0.0.1 on an ephemeral port and serves exactly one directory.
 *
 * Extensionless routes resolve to `<name>.html`, so a review of `/pricing`
 * captures `pricing.html` — the same route shape a real preview deployment has.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export interface StaticSite {
  /** Base URL the site is reachable at, e.g. `http://127.0.0.1:53411`. */
  baseUrl: string;
  close(): Promise<void>;
}

/** Map a request path to a file path inside `root`, or null if it escapes it. */
export function resolveRequestPath(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  const candidate = resolve(root, relative);
  const rootResolved = resolve(root);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) return null;
  return candidate;
}

/** Candidate files for a request path, in order: exact, `.html`, `index.html`. */
export function candidateFiles(filePath: string): string[] {
  if (extname(filePath).length > 0) return [filePath];
  return [`${filePath}.html`, join(filePath, "index.html")];
}

async function readFirst(candidates: string[]): Promise<{ path: string; body: Buffer } | null> {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return { path: candidate, body: await readFile(candidate) };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Serve `root` on 127.0.0.1 at an ephemeral port. */
export async function serveDirectory(root: string): Promise<StaticSite> {
  const server: Server = createServer((request, response) => {
    const filePath = resolveRequestPath(root, request.url ?? "/");
    if (filePath === null) {
      response.writeHead(403).end("forbidden");
      return;
    }
    void readFirst(candidateFiles(filePath)).then((found) => {
      if (!found) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(found.path)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(found.body);
    });
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
  };
}
