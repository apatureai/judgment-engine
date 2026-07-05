/**
 * Log/trace redaction (§11). Secrets, signed URLs, storageState, and screenshot
 * contents must never reach logs or traces. `redact()` deep-clones a value,
 * masking sensitive keys by name and sensitive strings by shape, so it can wrap
 * anything before it is logged or attached to a span.
 */
export const REDACTED = "[REDACTED]";

/** Sentinels emitted when a payload exceeds the traversal bounds below. */
export const TRUNCATED_MAX_NODES = "[Truncated: max nodes]";
export const TRUNCATED_MAX_DEPTH = "[Truncated: max depth]";

/**
 * Hard bounds on a single `redact()` traversal. `redact()` sits in the log/trace
 * hot path and this product logs graph structures (ui-graph, diffs), so an
 * adversarial or accidentally shared-/deep-heavy payload must not turn a log
 * line into a CPU/memory bomb. Because `seen` only tracks the *ancestor path*
 * (so genuine DAGs are preserved, not mis-flagged as "[Circular]"), a shared
 * subtree is legitimately re-walked once per referencing path — which is
 * exponential for a nested diamond. These caps keep the walk O(nodes) and the
 * output bounded regardless of input shape.
 */
export const MAX_REDACT_DEPTH = 64;
export const MAX_REDACT_NODES = 10_000;

const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /private.?key/i,
  /webhook.?secret/i,
  /api.?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /authorization/i,
  /protection.?bypass/i,
  /storage.?state/i,
  /signed.?url/i,
  /\bbypass\b/i,
];

const SIGNED_URL_QUERY = /[?&](x-amz-signature|signature|sig|token|access_token)=/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

function looksLikeSignedUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && SIGNED_URL_QUERY.test(value);
}

function looksLikeImageData(value: string): boolean {
  return /^data:image\//i.test(value);
}

/** Mutable per-call traversal state, threaded through the recursion. */
interface RedactState {
  /** The *current ancestor path* — for cycle detection (see `redactValue`). */
  readonly path: WeakSet<object>;
  /** Global count of container nodes emitted so far this traversal. */
  nodes: number;
}

/**
 * Recursive worker. `state.path` tracks the *current ancestor path*, not every
 * node ever visited: each container is removed once its own subtree finishes.
 * This catches genuine cycles (a node reachable from itself) while NOT
 * mis-flagging a shared (diamond/DAG) reference — the same object referenced by
 * two siblings — as "[Circular]", which would silently drop data from the log.
 *
 * Preserving DAGs means a shared subtree is re-walked per referencing path, so
 * two bounds keep the walk safe: `MAX_REDACT_DEPTH` caps recursion and
 * `MAX_REDACT_NODES` caps total emitted containers. On either cap we return a
 * sentinel *in place of the subtree* rather than throwing or hanging.
 *
 * SECURITY: sensitive keys are replaced with `REDACTED` *before* any recursion,
 * so key scrubbing always applies to everything emitted. Truncation only ever
 * collapses/drops a non-sensitive subtree into a sentinel string — it can never
 * cause a sensitive value to be emitted unredacted.
 */
function redactValue(value: unknown, state: RedactState, depth: number): unknown {
  if (typeof value === "string") {
    return looksLikeSignedUrl(value) || looksLikeImageData(value) ? REDACTED : value;
  }

  const isArray = Array.isArray(value);
  const isObject = !isArray && value !== null && typeof value === "object";
  if (!isArray && !isObject) return value;

  const container = value as object;

  // Cycle detection first: a node reachable from itself is [Circular] even at
  // the depth/node bound, so genuine cycles never masquerade as truncation.
  if (state.path.has(container)) return "[Circular]";
  if (depth >= MAX_REDACT_DEPTH) return TRUNCATED_MAX_DEPTH;
  if (state.nodes >= MAX_REDACT_NODES) return TRUNCATED_MAX_NODES;
  state.nodes += 1;

  state.path.add(container);
  let out: unknown;
  if (isArray) {
    out = (value as unknown[]).map((item) => redactValue(item, state, depth + 1));
  } else {
    const obj: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      obj[key] = isSensitiveKey(key) ? REDACTED : redactValue(val, state, depth + 1);
    }
    out = obj;
  }
  state.path.delete(container);
  return out;
}

/**
 * Return a redacted deep copy of `value` safe to log. Sensitive keys are masked
 * by name and sensitive strings (signed URLs, image data) by shape. The
 * traversal is bounded (see `MAX_REDACT_DEPTH` / `MAX_REDACT_NODES`) so it stays
 * fast and finite even on deeply nested, cyclic, or shared-reference-heavy
 * payloads; over-bound subtrees are collapsed to a truncation sentinel.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, { path: new WeakSet<object>(), nodes: 0 }, 0);
}
