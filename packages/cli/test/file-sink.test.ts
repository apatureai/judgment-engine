import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileScreenshotSink } from "../src/index.js";

describe("FileScreenshotSink", () => {
  it("writes an object key to the matching path and records it", async () => {
    const root = await mkdtemp(join(tmpdir(), "je-sink-"));
    const sink = new FileScreenshotSink(root);
    await sink.put("screenshots/index/mobile.png", new Uint8Array([1, 2, 3]));

    expect(sink.keys).toEqual(["screenshots/index/mobile.png"]);
    const written = await readFile(join(root, "screenshots/index/mobile.png"));
    expect([...written]).toEqual([1, 2, 3]);
    expect(sink.urlFor("screenshots/index/mobile.png")).toBe(
      `file://${join(root, "screenshots/index/mobile.png")}`,
    );
  });

  it("inlines the bytes as a data URI for a live model that must fetch them", async () => {
    const root = await mkdtemp(join(tmpdir(), "je-sink-"));
    const sink = new FileScreenshotSink(root);
    await sink.put("screenshots/index/mobile.png", new Uint8Array([137, 80, 78, 71]));
    expect(await sink.dataUriFor("screenshots/index/mobile.png")).toBe("data:image/png;base64,iVBORw==");
  });

  it("refuses a key that escapes the output directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "je-sink-"));
    const sink = new FileScreenshotSink(root);
    await expect(sink.put("../escape.png", new Uint8Array([0]))).rejects.toThrow(/escapes the output directory/);
  });
});
