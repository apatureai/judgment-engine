import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deterministicChecks,
  toInteractiveElements,
  toTextNodeStyles,
  type ExtractedPage,
} from "../src/index.js";

/**
 * The checks, replayed against what Chromium actually produced for real pages.
 *
 * Every unit test in this package feeds the checks a hand-written
 * `overflow-x` or a hand-written rect, which is exactly why three
 * false-positive classes shipped: the hand-written input agreed with the
 * check's assumption, and a browser did not. The pages in
 * `fixtures/pages/*.html` are the three shapes, `scripts/record-capture-fixtures.mjs`
 * renders them in the same Chromium the capture uses, and the payloads below
 * are what came back. No browser is needed to run this; one was needed to write it.
 *
 * Each page carries a control: a genuine violation of the same kind that must
 * survive. A guard that silences the false positive by silencing the check is
 * not a fix, and the control is what tells the two apart.
 */

const load = (name: string): ExtractedPage =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/extracted/${name}.json`, import.meta.url)), "utf8"),
  ) as ExtractedPage;

function findingsFor(page: string, viewport: "mobile" | "desktop") {
  const extracted = load(`${page}.${viewport}`);
  return deterministicChecks({
    textNodes: toTextNodeStyles(extracted, `/${page}`, viewport),
    interactive: toInteractiveElements(extracted, `/${page}`, viewport),
  });
}

const byId = (page: ExtractedPage, id: string) => page.elements.find((el) => el.id === id);

describe("real page: scroll containers", () => {
  it("Chromium reports the fields the overflow guard depends on", () => {
    const page = load("scroll-containers.desktop");

    // A `<pre>` with a scrollbar. The measurement that made it look broken is
    // real (734 > 480) and so is the reason it is not.
    const pre = byId(page, "scrollable-pre");
    expect(pre?.text?.contentWidthPx).toBeGreaterThan(pre?.rect.width ?? 0);
    expect(pre?.text?.overflowX).toBe("auto");

    // A wide row inside a `.table-wrap`. The row itself does NOT scroll.
    const row = byId(page, "wide-row");
    expect(row?.text?.contentWidthPx).toBeGreaterThan(row?.rect.width ?? 0);
    expect(row?.text?.overflowX).toBe("visible");
    expect(row?.text?.ancestorScrollsX).toBe(true);

    // The control: nothing scrolls, the line escapes its box and paints over
    // the page. This one is the page coming apart.
    const spill = byId(page, "spilling-line");
    expect(spill?.text?.overflowX).toBe("visible");
    expect(spill?.text?.ancestorScrollsX).toBe(false);
  });

  it("reports only the line that really escapes, at both viewports", () => {
    for (const viewport of ["mobile", "desktop"] as const) {
      const findings = findingsFor("scroll-containers", viewport);
      expect(findings.map((f) => f.selector)).toEqual(["#spilling-line"]);
      expect(findings[0]?.kind).toBe("overflow");
      expect(findings[0]?.blockEligible).toBe(true);
    }
  });
});

describe("real page: pointer targets", () => {
  it("Chromium reports the fields the touch-target guard depends on", () => {
    const page = load("pointer-targets.mobile");

    expect(byId(page, "toolbar-bold")?.rect).toMatchObject({ width: 32, height: 32 });
    expect(byId(page, "packed-a")?.rect).toMatchObject({ width: 20, height: 20 });
    expect(byId(page, "isolated-star")?.rect).toMatchObject({ width: 20, height: 20 });
    // A link inside a sentence: sized by the line-height of the prose.
    expect(byId(page, "inline-terms")?.inlineTarget).toBe(true);
    expect(byId(page, "packed-a")?.inlineTarget).toBe(false);
  });

  it("reports only the two crowded 20px controls, and only on touch", () => {
    const mobile = findingsFor("pointer-targets", "mobile");
    expect(mobile.map((f) => f.selector)).toEqual(["#packed-a", "#packed-b"]);
    expect(mobile.every((f) => f.blockEligible === true)).toBe(true);
    expect(mobile[0]?.detail).toBe(
      "touch target 20x20px is below the 24x24px minimum in WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA",
    );

    // The same page under a mouse. 2.5.8 is about a finger.
    expect(findingsFor("pointer-targets", "desktop")).toEqual([]);
  });

  it("the 32px desktop control and the isolated 20px one are AAA-only findings", () => {
    const page = load("pointer-targets.mobile");
    const strict = deterministicChecks({
      textNodes: [],
      interactive: toInteractiveElements(page, "/pointer-targets", "mobile"),
      touchTargetCriterion: "AAA",
    });
    expect(strict.map((f) => f.selector)).toEqual([
      "#toolbar-bold",
      "#packed-a",
      "#packed-b",
      "#isolated-star",
    ]);
    expect(strict[0]?.detail).toContain("WCAG 2.2 SC 2.5.5 Target Size (Enhanced), level AAA");
    // The inline link stays exempt: 2.5.5 carries the Inline exception too.
    expect(strict.map((f) => f.selector)).not.toContain("#inline-terms");
  });
});

describe("real page: text over a photograph", () => {
  it("Chromium reports the fields the contrast guard depends on", () => {
    const page = load("text-over-photo.desktop");

    // White text on a dusk sky, on a white page. Flattening COLOURS alone gives
    // white on white: 1.00:1, a ratio no reader experiences.
    const hero = byId(page, "hero-caption");
    expect(hero?.text?.color).toBe("rgb(255, 255, 255)");
    expect(hero?.text?.backdropObscured).toBe(true);

    // A backdrop-filter is the same problem by another route.
    expect(byId(page, "frosted-caption")?.text?.backdropObscured).toBe(true);

    // The control: no image anywhere, and #8f8f8f on white really does fail AA.
    expect(byId(page, "faint-note")?.text?.backdropObscured).toBe(false);
  });

  it("declines the two unmeasurable backdrops and keeps the real failure", () => {
    for (const viewport of ["mobile", "desktop"] as const) {
      const findings = findingsFor("text-over-photo", viewport);
      expect(findings.map((f) => f.selector)).toEqual(["#faint-note"]);
      expect(findings[0]?.detail).toBe("text contrast 3.23:1 is below WCAG AA 4.5:1");
      expect(findings[0]?.blockEligible).toBe(true);
    }
  });
});
