import { describe, expect, it } from "vitest";
import { DEFAULT_SERVE_OPTIONS, parseServeArgs, SERVE_USAGE, ServeArgError } from "../src/args.js";

/**
 * `parseServeArgs` is pure, so every flag it accepts and every argument it
 * rejects is pinned here rather than discovered by starting a server.
 */

describe("parseServeArgs", () => {
  it("defaults to a loopback port with no model configured and no stability check", () => {
    expect(parseServeArgs([])).toEqual(DEFAULT_SERVE_OPTIONS);
    expect(DEFAULT_SERVE_OPTIONS.host).toBe("127.0.0.1");
    expect(DEFAULT_SERVE_OPTIONS.model).toBe("auto");
  });

  it("reads every value flag", () => {
    expect(
      parseServeArgs([
        "--port",
        "9100",
        "--host",
        "0.0.0.0",
        "--out",
        "/tmp/artifacts",
        "--context-dir",
        "/repo",
        "--script",
        "/repo/script.json",
        "--public-url",
        "https://engine.example",
        "--model",
        "mock",
        "--verify-stability",
      ]),
    ).toEqual({
      port: 9100,
      host: "0.0.0.0",
      outDir: "/tmp/artifacts",
      contextDir: "/repo",
      script: "/repo/script.json",
      publicBaseUrl: "https://engine.example",
      model: "mock",
      verifyStability: true,
      help: false,
    });
  });

  it("accepts port 0, which is how a test asks the OS for a free port", () => {
    expect(parseServeArgs(["--port", "0"]).port).toBe(0);
  });

  it("accepts each model choice and rejects any other", () => {
    for (const choice of ["auto", "mock", "canned", "live"] as const) {
      expect(parseServeArgs(["--model", choice]).model).toBe(choice);
    }
    expect(() => parseServeArgs(["--model", "gpt"])).toThrow(ServeArgError);
    expect(() => parseServeArgs(["--model", "gpt"])).toThrow(/expected auto, mock, canned or live/);
  });

  it("rejects a port that is not a port", () => {
    for (const port of ["-1", "65536", "http", "8080.5"]) {
      expect(() => parseServeArgs(["--port", port])).toThrow(/--port must be a port number/);
    }
  });

  it("rejects a value flag with no value and an argument it does not know", () => {
    expect(() => parseServeArgs(["--out"])).toThrow(/--out requires a value/);
    expect(() => parseServeArgs(["--stealth"])).toThrow(/unknown argument "--stealth"/);
  });

  it("recognises both spellings of help", () => {
    expect(parseServeArgs(["-h"]).help).toBe(true);
    expect(parseServeArgs(["--help"]).help).toBe(true);
  });

  it("documents the secret it refuses to default and the offline behaviour", () => {
    expect(SERVE_USAGE).toContain("ENGINE_HMAC_SECRET");
    expect(SERVE_USAGE).toContain("provenance saying no model judged the page");
  });
});
