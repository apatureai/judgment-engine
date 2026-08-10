/**
 * Graceful-shutdown wiring shared by the process entrypoints.
 *
 * api-main.ts and worker-main.ts had byte-identical shutdown boilerplate: the
 * one-shot `stopping` guard, the `stop()` call, and the SIGTERM/SIGINT
 * registration. The two processes must shut down identically, so that logic
 * lives in one tested place; each entrypoint keeps only its own start call.
 */

/** The minimal surface graceful shutdown needs: a stoppable runtime. */
export interface Stoppable {
  stop(): Promise<void>;
}

/** Registers a signal handler; injectable so the wiring is testable without real signals. */
export type SignalRegistrar = (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;

const defaultRegistrar: SignalRegistrar = (signal, handler) => {
  process.once(signal, handler);
};

/**
 * Install a once-only graceful shutdown: on the first SIGTERM or SIGINT, call
 * `runtime.stop()` exactly once (a second signal while stopping is a no-op).
 * Returns the shutdown function so a caller/test can invoke it directly.
 */
export function installGracefulShutdown(
  runtime: Stoppable,
  register: SignalRegistrar = defaultRegistrar,
): () => Promise<void> {
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
  };
  register("SIGTERM", () => void shutdown());
  register("SIGINT", () => void shutdown());
  return shutdown;
}
