import { describe, expect, it } from "vitest";
import {
  hammingDistance,
  hashesWithin,
  runStabilityGate,
  type StabilitySample,
} from "../src/index.js";

describe("hamming distance", () => {
  it("counts differing bits across hex hashes", () => {
    expect(hammingDistance("00", "00")).toBe(0);
    expect(hammingDistance("0f", "00")).toBe(4);
    expect(hammingDistance("ff", "0f")).toBe(4);
    expect(hashesWithin("ff", "fe", 1)).toBe(true);
    expect(hashesWithin("ff", "f0", 1)).toBe(false);
  });

  it("rejects mismatched hash lengths", () => {
    expect(() => hammingDistance("ff", "f")).toThrow();
  });
});

describe("runStabilityGate", () => {
  it("declares stable as soon as a consecutive pair matches", async () => {
    const samples: StabilitySample[] = [
      { phash: "ffff", structuralHash: "00" },
      { phash: "fffe", structuralHash: "00" }, // within phash threshold + identical structure
    ];
    const result = await runStabilityGate((i) => Promise.resolve(samples[i]!), { maxAttempts: 3 });
    expect(result.stable).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.confidenceUnstable).toBe(false);
  });

  it("caps confidence when the page never settles", async () => {
    const drift = (i: number): Promise<StabilitySample> =>
      Promise.resolve({ phash: ["0000", "ffff", "0f0f"][i]!, structuralHash: String(i) });
    const result = await runStabilityGate(drift, { maxAttempts: 3 });
    expect(result.stable).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.confidenceUnstable).toBe(true);
  });

  it("treats a structural change as instability even when phash matches", async () => {
    const samples: StabilitySample[] = [
      { phash: "ffff", structuralHash: "00" },
      { phash: "ffff", structuralHash: "ff" }, // phash identical, structure shifted
    ];
    const result = await runStabilityGate((i) => Promise.resolve(samples[i]!), {
      maxAttempts: 2,
      structuralThreshold: 0,
    });
    expect(result.stable).toBe(false);
  });

  it("requires at least 2 attempts", async () => {
    await expect(
      runStabilityGate(() => Promise.resolve({ phash: "00", structuralHash: "00" }), {
        maxAttempts: 1,
      }),
    ).rejects.toThrow();
  });
});
