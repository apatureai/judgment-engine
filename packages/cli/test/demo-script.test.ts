import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `demo.mjs` is the repository's one-command entry point. It has to run before
 * anything is installed or built, so it is plain JavaScript at the repository
 * root rather than a workspace package, and it is imported here by URL: the
 * helpers it exports are what decide whether a reader is told the truth about
 * their Node version and about which files the run actually produced.
 *
 * Importing it must not run it. That is the first assertion below, and it is the
 * one that keeps this test file from installing a workspace as a side effect.
 */
interface DemoModule {
  REQUIRED_NODE_MAJOR: number;
  parseNodeMajor(version: string): number | null;
  nodeVersionProblem(version: string, required?: number): string | null;
  outDirFrom(argv: string[], fallback?: string): string;
  stepLine(index: number, total: number, title: string): string;
  formatBytes(bytes: number): string;
  artifactLines(entries: Array<{ path: string; size: string; note: string }>): string[];
  listFiles(dir: string): string[];
  closingNote(modelBacked: boolean | null): string;
  readModelBacked(path: string): boolean | null;
  selectRunArtifacts(files: string[]): { screenshots: string[]; documents: string[] };
  openCommand(platform: string): string | null;
}

const demo = (await import(new URL("../../../demo.mjs", import.meta.url).href)) as DemoModule;

describe("demo.mjs module shape", () => {
  it("imports without running the demo", () => {
    // No install, no build and no browser launch happened on import: the module
    // only self-executes when it is the process entry point.
    expect(demo.REQUIRED_NODE_MAJOR).toBe(24);
    expect(typeof demo.nodeVersionProblem).toBe("function");
  });
});

describe("parseNodeMajor", () => {
  it("reads the major version out of a Node version string", () => {
    expect(demo.parseNodeMajor("v24.14.0")).toBe(24);
    expect(demo.parseNodeMajor("24.0.1")).toBe(24);
    expect(demo.parseNodeMajor(" v26.1.0 ")).toBe(26);
  });

  it("returns null for anything that is not a version", () => {
    expect(demo.parseNodeMajor("")).toBeNull();
    expect(demo.parseNodeMajor("node")).toBeNull();
    expect(demo.parseNodeMajor("v24")).toBeNull();
  });
});

describe("nodeVersionProblem", () => {
  it("passes a Node at or above the floor", () => {
    expect(demo.nodeVersionProblem("v24.14.0")).toBeNull();
    expect(demo.nodeVersionProblem("v30.0.0")).toBeNull();
  });

  it("explains an old Node and names a way to fix it", () => {
    const problem = demo.nodeVersionProblem("v20.11.0");
    expect(problem).toContain("v20.11.0");
    expect(problem).toContain("24");
    expect(problem).toContain("nvm");
  });

  it("explains an unreadable version rather than guessing", () => {
    expect(demo.nodeVersionProblem("banana")).toContain("Could not read a version number");
  });

  it("honours a caller-supplied floor", () => {
    expect(demo.nodeVersionProblem("v24.14.0", 26)).toContain("too old");
  });
});

describe("outDirFrom", () => {
  it("defaults to out/", () => {
    expect(demo.outDirFrom([])).toBe("out");
    expect(demo.outDirFrom(["--routes", "/"])).toBe("out");
  });

  it("follows the --out the review will actually use", () => {
    expect(demo.outDirFrom(["--out", "run-2"])).toBe("run-2");
    expect(demo.outDirFrom(["--routes", "/", "--out", "run-2", "--model", "mock"])).toBe("run-2");
  });

  it("ignores --out=dir, which the CLI itself rejects", () => {
    // Claiming to honour a spelling the run would reject would point the reader
    // at a directory nothing was written to.
    expect(demo.outDirFrom(["--out=run-2"])).toBe("out");
  });

  it("ignores a trailing --out with no value", () => {
    expect(demo.outDirFrom(["--out"])).toBe("out");
  });
});

describe("stepLine", () => {
  it("numbers a step against the total", () => {
    expect(demo.stepLine(2, 5, "Installing dependencies")).toBe("[2/5] Installing dependencies");
  });
});

describe("formatBytes", () => {
  it("scales to B, KB and MB", () => {
    expect(demo.formatBytes(90)).toBe("90 B");
    expect(demo.formatBytes(2048)).toBe("2 KB");
    expect(demo.formatBytes(1024 * 1024 * 3)).toBe("3.0 MB");
  });
});

describe("artifactLines", () => {
  it("aligns paths and right-aligns sizes", () => {
    const lines = demo.artifactLines([
      { path: "out/screenshots/index/desktop.png", size: "163 KB", note: "the page" },
      { path: "out/review.json", size: "5 KB", note: "the wire result" },
    ]);
    expect(lines[0]).toBe("  out/screenshots/index/desktop.png  163 KB  the page");
    expect(lines[1]).toBe("  out/review.json                      5 KB  the wire result");
  });

  it("survives an empty listing", () => {
    expect(demo.artifactLines([])).toEqual([]);
  });

  it("does not leave trailing space when a note is missing", () => {
    expect(demo.artifactLines([{ path: "out/notes.txt", size: "1 KB", note: "" }])).toEqual([
      "  out/notes.txt  1 KB",
    ]);
  });
});

describe("selectRunArtifacts", () => {
  it("keeps the screenshots and the top-level documents", () => {
    const selected = demo.selectRunArtifacts([
      "deterministic-facts.txt",
      "geometry.json",
      "report.txt",
      "review.json",
      "screenshots/index/desktop.png",
      "screenshots/pricing/mobile.png",
      "system-prompt.txt",
    ]);
    expect(selected.screenshots).toEqual([
      "screenshots/index/desktop.png",
      "screenshots/pricing/mobile.png",
    ]);
    expect(selected.documents).toEqual([
      "deterministic-facts.txt",
      "geometry.json",
      "report.txt",
      "review.json",
      "system-prompt.txt",
    ]);
  });

  it("leaves another writer's files out of this run's listing", () => {
    // The local job server writes under serve/. Listing its output as "produced
    // by the run above" would be false in the one place that tells the reader
    // what they are now holding.
    const selected = demo.selectRunArtifacts([
      "review.json",
      "serve/jobs/abc/review.json",
      "serve/jobs/abc/screenshots/index/desktop.png",
    ]);
    expect(selected.documents).toEqual(["review.json"]);
    expect(selected.screenshots).toEqual([]);
  });
});

describe("listFiles", () => {
  it("returns every file under a directory, relative and sorted", () => {
    const root = mkdtempSync(join(tmpdir(), "demo-list-"));
    mkdirSync(join(root, "screenshots", "index"), { recursive: true });
    writeFileSync(join(root, "review.json"), "{}");
    writeFileSync(join(root, "screenshots", "index", "desktop.png"), "png");
    expect(demo.listFiles(root)).toEqual(["review.json", "screenshots/index/desktop.png"]);
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(demo.listFiles(join(tmpdir(), "demo-listing-that-is-not-there"))).toEqual([]);
  });
});

describe("closingNote", () => {
  it("says no model saw the page on an unjudged run, and how to change that", () => {
    const note = demo.closingNote(false);
    expect(note).toContain("No model saw this page");
    expect(note).toContain("MODEL_API_KEY");
    expect(note).toContain("--model live");
  });

  it("does not claim the page was unjudged when a model did judge it", () => {
    // `node demo.mjs --model live` with an endpoint configured is one flag away.
    const note = demo.closingNote(true);
    expect(note).toContain("model_backed: true");
    expect(note).not.toContain("No model saw this page");
  });

  it("says it does not know rather than guessing when review.json is unreadable", () => {
    const note = demo.closingNote(null);
    expect(note).toContain("could not read that file");
    expect(note).not.toContain("No model saw this page");
  });

  it("always points at reviewing your own site", () => {
    for (const state of [true, false, null]) {
      expect(demo.closingNote(state)).toContain("--url https://your-preview-deploy");
    }
  });
});

describe("readModelBacked", () => {
  const write = (contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "demo-provenance-"));
    const path = join(dir, "review.json");
    writeFileSync(path, contents);
    return path;
  };

  it("reads the provenance stamp the engine writes", () => {
    expect(demo.readModelBacked(write('{"provenance":{"model_backed":true}}'))).toBe(true);
    expect(demo.readModelBacked(write('{"provenance":{"model_backed":false}}'))).toBe(false);
  });

  it("returns null for a missing, malformed or unstamped file", () => {
    expect(demo.readModelBacked(join(tmpdir(), "demo-review-that-is-not-there.json"))).toBeNull();
    expect(demo.readModelBacked(write("{not json"))).toBeNull();
    expect(demo.readModelBacked(write("{}"))).toBeNull();
    expect(demo.readModelBacked(write('{"provenance":{"model_backed":"yes"}}'))).toBeNull();
  });
});

describe("openCommand", () => {
  it("names the platform's opener, and nothing when there is no obvious one", () => {
    expect(demo.openCommand("darwin")).toBe("open");
    expect(demo.openCommand("linux")).toBe("xdg-open");
    expect(demo.openCommand("win32")).toBe("start");
    expect(demo.openCommand("aix")).toBeNull();
  });
});
