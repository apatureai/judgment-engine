/**
 * Graceful shutdown extracted from the byte-identical api-main / worker-main
 * boilerplate. Pins the process-lifecycle contract both entrypoints depend on:
 * one SIGTERM/SIGINT triggers stop() exactly once, a second signal is a no-op,
 * and both signals are registered.
 */
import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown, type SignalRegistrar } from "../src/index.js";

function fakeSignals() {
  const handlers = new Map<string, () => void>();
  const register: SignalRegistrar = (signal, handler) => {
    handlers.set(signal, handler);
  };
  return { register, fire: (s: "SIGTERM" | "SIGINT") => handlers.get(s)?.(), signals: () => [...handlers.keys()] };
}

describe("installGracefulShutdown", () => {
  it("registers both SIGTERM and SIGINT", () => {
    const { register, signals } = fakeSignals();
    installGracefulShutdown({ stop: async () => {} }, register);
    expect(signals().sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("calls stop() exactly once even on repeated signals", async () => {
    const stop = vi.fn(async () => {});
    const { register, fire } = fakeSignals();
    installGracefulShutdown({ stop }, register);
    fire("SIGTERM");
    fire("SIGTERM");
    fire("SIGINT");
    await Promise.resolve();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("returns a shutdown function that is idempotent when called directly", async () => {
    const stop = vi.fn(async () => {});
    const { register } = fakeSignals();
    const shutdown = installGracefulShutdown({ stop }, register);
    await shutdown();
    await shutdown();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
