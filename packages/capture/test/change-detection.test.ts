import { describe, expect, it } from "vitest";
import {
  allRoutesConfirmedUnchanged,
  detectBaselineChange,
  type BaselineChangeInput,
} from "../src/index.js";

const match = { baselinePhash: "ffff", currentPhash: "ffff" } as const;

describe("detectBaselineChange (#89)", () => {
  it("treats a missing baseline as changed (cannot conclude unchanged)", () => {
    expect(detectBaselineChange({ currentPhash: "ffff", tileScores: [{ ssim: 1 }] })).toEqual({
      changed: true,
      reason: "no_baseline",
    });
  });

  it("short-circuits a phash MISMATCH to changed with no sensitive diff needed", () => {
    expect(detectBaselineChange({ baselinePhash: "0000", currentPhash: "ffff" })).toEqual({
      changed: true,
      reason: "phash_mismatch",
    });
  });

  it("confirms unchanged only when phash matches AND every non-animated tile is above threshold", () => {
    expect(detectBaselineChange({ ...match, tileScores: [{ ssim: 1 }, { ssim: 0.995 }] })).toEqual({
      changed: false,
      reason: "confirmed_unchanged",
    });
  });

  it("REGRESSION: phash match but a tile SSIM below threshold ⇒ changed (the missed-change hole)", () => {
    expect(detectBaselineChange({ ...match, tileScores: [{ ssim: 1 }, { ssim: 0.5 }] })).toEqual({
      changed: true,
      reason: "tile_changed",
    });
  });

  it("supports an AA-aware pixel-diff ratio as the sensitive metric", () => {
    expect(detectBaselineChange({ ...match, tileScores: [{ diffRatio: 0 }, { diffRatio: 0.0005 }] }).changed).toBe(false);
    expect(detectBaselineChange({ ...match, tileScores: [{ diffRatio: 0.02 }] })).toEqual({
      changed: true,
      reason: "tile_changed",
    });
  });

  it("excludes known-animated tiles so a carousel does not force a false change", () => {
    // The only changed tile is animated → excluded; the rest confirm unchanged.
    expect(
      detectBaselineChange({ ...match, tileScores: [{ ssim: 1 }, { ssim: 0.1, animated: true }] }),
    ).toEqual({ changed: false, reason: "confirmed_unchanged" });
  });

  it("fails open when a phash match has no tile scores", () => {
    expect(detectBaselineChange(match)).toEqual({ changed: true, reason: "unconfirmable" });
    expect(detectBaselineChange({ ...match, tileScores: [] })).toEqual({ changed: true, reason: "unconfirmable" });
  });

  it("fails open when every tile is animated (nothing left to confirm)", () => {
    expect(detectBaselineChange({ ...match, tileScores: [{ ssim: 1, animated: true }] })).toEqual({
      changed: true,
      reason: "unconfirmable",
    });
  });

  it("fails open when a non-animated tile has no usable score (ambiguous)", () => {
    expect(detectBaselineChange({ ...match, tileScores: [{ ssim: 1 }, {}] })).toEqual({
      changed: true,
      reason: "unconfirmable",
    });
    // NaN is not a usable score either.
    expect(detectBaselineChange({ ...match, tileScores: [{ ssim: Number.NaN }] }).reason).toBe("unconfirmable");
  });

  it("honors custom thresholds", () => {
    // A 0.97 tile is "changed" at the default 0.99 but "unchanged" at a 0.95 bar.
    expect(detectBaselineChange({ ...match, tileScores: [{ ssim: 0.97 }] }).changed).toBe(true);
    expect(detectBaselineChange({ ...match, tileScores: [{ ssim: 0.97 }] }, { ssimThreshold: 0.95 }).changed).toBe(false);
  });
});

describe("allRoutesConfirmedUnchanged (#89)", () => {
  const confirmed: BaselineChangeInput = { ...match, tileScores: [{ ssim: 1 }] };

  it("is true only when every route is positively confirmed unchanged", () => {
    expect(allRoutesConfirmedUnchanged([confirmed, confirmed])).toBe(true);
  });

  it("is false if any route changed, is unconfirmable, or lacks a baseline", () => {
    expect(allRoutesConfirmedUnchanged([confirmed, { ...match, tileScores: [{ ssim: 0.2 }] }])).toBe(false);
    expect(allRoutesConfirmedUnchanged([confirmed, match])).toBe(false); // unconfirmable
    expect(allRoutesConfirmedUnchanged([confirmed, { currentPhash: "ffff", tileScores: [{ ssim: 1 }] }])).toBe(false);
  });

  it("is false on an empty set (nothing proven unchanged)", () => {
    expect(allRoutesConfirmedUnchanged([])).toBe(false);
  });
});
