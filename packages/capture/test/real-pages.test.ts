import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deterministicChecks,
  resolvedGradientBackdrops,
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
 * `fixtures/pages/*.html` are those shapes, `scripts/record-capture-fixtures.mjs`
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
      // Named rather than implied: these two are the pages the precision pass
      // silenced, and teaching the check to gate a clip must not wake them.
      const selectors = findings.map((f) => f.selector);
      expect(selectors).not.toContain("#scrollable-pre");
      expect(selectors).not.toContain("#wide-row");
      expect(selectors).toEqual(["#spilling-line"]);
      expect(findings[0]?.kind).toBe("overflow");
      expect(findings[0]?.blockEligible).toBe(true);
    }
  });
});

describe("real page: clipped content and deliberate truncation", () => {
  it("Chromium reports the properties the clip verdict depends on", () => {
    const page = load("clipped-text.desktop");

    // A card title cut on purpose, with the ellipsis that tells the reader so.
    const title = byId(page, "ellipsis-title");
    expect(title?.text?.contentWidthPx).toBeGreaterThan(title?.rect.width ?? 0);
    expect(title?.text?.overflowX).toBe("hidden");
    expect(title?.text?.textOverflow).toBe("ellipsis");
    expect(title?.text?.whiteSpace).toBe("nowrap");

    // The control: the same clip with nothing to show for it. The end of the
    // line is gone and the page does not say a word about it.
    const amount = byId(page, "clipped-amount");
    expect(amount?.text?.overflowX).toBe("hidden");
    expect(amount?.text?.textOverflow).toBe("clip");
    expect(amount?.text?.whiteSpace).toBe("nowrap");

    // A clip INSIDE a horizontal scroller. Chromium confirms both halves: the
    // wrapper scrolls, and the cell cuts its own content anyway.
    const cell = byId(page, "clipped-cell");
    expect(cell?.text?.overflowX).toBe("hidden");
    expect(cell?.text?.ancestorScrollsX).toBe(true);
  });

  it("gates the clips that lost content, and says nothing about the truncated title", () => {
    for (const viewport of ["mobile", "desktop"] as const) {
      const findings = findingsFor("clipped-text", viewport);
      const gated = findings.filter((f) => f.blockEligible === true);
      expect(gated.map((f) => f.selector)).toEqual(["#clipped-amount", "#clipped-cell"]);
      expect(gated[0]?.detail).toBe(
        "content width 350px exceeds container 140px and 210px of it is clipped away with no " +
          "truncation affordance (overflow-x: hidden, text-overflow: clip, white-space: nowrap)",
      );
      // The deliberate truncation produces nothing at all, and neither does the
      // rounded card, whose clip is for its corners and loses nothing.
      expect(findings.map((f) => f.selector)).not.toContain("#ellipsis-title");
      expect(findings.map((f) => f.selector)).not.toContain("#rounded-card");
    }
  });

  it("reports the two it cannot decide, without gating, and names the reason", () => {
    const advisory = findingsFor("clipped-text", "desktop").filter((f) => f.blockEligible !== true);
    expect(advisory.map((f) => f.selector)).toEqual(["#wrapping-blurb", "#sr-only-hint"]);
    // Neither is pushed into a verdict to make the numbers look better: an
    // ellipsis on wrapping text may or may not paint, and a 1x1px box is an
    // accessibility feature doing exactly what it was built to do.
    expect(advisory[0]?.detail).toContain(
      "not gated because a truncation mark on wrapping content may not be rendered at all",
    );
    expect(advisory[1]?.detail).toContain(
      "not gated because a 1x1px box is the visually-hidden idiom, not a box content is rendered in",
    );
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

  it("gates the two crowded 20px controls, advises on the 32px one, and only on touch", () => {
    const mobile = findingsFor("pointer-targets", "mobile");
    expect(mobile.map((f) => f.selector)).toEqual(["#toolbar-bold", "#packed-a", "#packed-b"]);

    // The two 20px controls: a 2.5.8 failure, and gateable.
    expect(mobile.filter((f) => f.blockEligible === true).map((f) => f.selector)).toEqual([
      "#packed-a",
      "#packed-b",
    ]);
    expect(mobile[1]?.detail).toBe(
      "touch target 20x20px is below the 24x24px minimum in WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA",
    );

    // The 32px toolbar button: real on a phone, not a 2.5.8 failure, and the
    // sentence says which bar it cleared and which it did not.
    expect(mobile[0]?.blockEligible).toBe(false);
    expect(mobile[0]?.detail).toBe(
      "advisory: touch target 32x32px meets the 24x24px minimum in WCAG 2.2 SC 2.5.8 " +
        "Target Size (Minimum), level AA, and is below the 44x44px minimum in " +
        "WCAG 2.2 SC 2.5.5 Target Size (Enhanced), level AAA",
    );

    // The isolated 20px control keeps its Spacing exception rather than
    // reappearing one tier down.
    expect(mobile.map((f) => f.selector)).not.toContain("#isolated-star");

    // The same page under a mouse. Both criteria are about a finger.
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

    // A photograph is still a photograph once the extractor reports what it is:
    // a `url(...)`, which resolves to no colour at all.
    expect(hero?.text?.backgroundImages?.some((image) => image.startsWith("url("))).toBe(true);
    expect(hero?.text?.backdropFiltered).toBe(false);

    // A backdrop-filter is the same problem by another route, and it is the
    // half that can never be resolved: it paints no image the parser could read.
    expect(byId(page, "frosted-caption")?.text?.backdropObscured).toBe(true);
    expect(byId(page, "frosted-caption")?.text?.backdropFiltered).toBe(true);

    // The control: no image anywhere, and #8f8f8f on white really does fail AA.
    expect(byId(page, "faint-note")?.text?.backdropObscured).toBe(false);
  });

  it("declines the two unmeasurable backdrops and keeps the real failure", () => {
    for (const viewport of ["mobile", "desktop"] as const) {
      const findings = findingsFor("text-over-photo", viewport);
      // Named rather than implied: the photograph and the frosted panel are the
      // page the precision pass made silent, and resolving gradients must not
      // wake either of them.
      const selectors = findings.map((f) => f.selector);
      expect(selectors).not.toContain("#hero-caption");
      expect(selectors).not.toContain("#frosted-caption");
      expect(selectors).toEqual(["#faint-note"]);
      expect(findings[0]?.detail).toBe("text contrast 3.23:1 is below WCAG AA 4.5:1");
      expect(findings[0]?.blockEligible).toBe(true);
    }
  });
});

/**
 * The half of "a background image" that IS computable.
 *
 * Declining every `background-image` kept a photograph out of the numbers and
 * took a two-stop `linear-gradient` with it, and a gradient states its
 * endpoints in plain sRGB. This page carries one real defect and three shapes
 * that have to stay silent, so the guard can be neither "any gradient is a
 * finding" nor "any image is not measurable".
 */
describe("real page: text over a gradient", () => {
  it("Chromium reports the gradient the contrast check resolves", () => {
    const page = load("text-over-gradient.desktop");

    // The gradient is painted by the ancestor and not by the element carrying
    // the text, so the resolver has to find it in the stack that was walked.
    const fade = byId(page, "fade-caption");
    expect(fade?.text?.color).toBe("rgb(255, 255, 255)");
    expect(fade?.text?.backdropObscured).toBe(true);
    expect(fade?.text?.backdropFiltered).toBe(false);
    expect(fade?.text?.backgroundImages).toEqual([
      "none",
      "linear-gradient(rgb(27, 58, 107), rgb(234, 242, 255))",
      "none",
      "none",
    ]);
    expect(
      resolvedGradientBackdrops(
        fade?.text?.backgroundStack ?? [],
        fade?.text?.backgroundImages,
        fade?.text?.backdropFiltered,
      ),
    ).toEqual(["rgb(27, 58, 107)", "rgb(234, 242, 255)"]);

    // A direction keyword in front of the stops does not make them unreadable.
    expect(byId(page, "ink-caption")?.text?.backgroundImages?.[1]).toBe(
      "linear-gradient(to right, rgb(255, 255, 255), rgb(234, 242, 255))",
    );

    // A stop in a colour space this engine does not parse, and a gradient laid
    // over a bitmap. Both come back with an image the resolver has to refuse.
    expect(byId(page, "wide-caption")?.text?.backgroundImages?.[1]).toContain("oklch");
    expect(byId(page, "layered-caption")?.text?.backgroundImages?.[1]).toContain("url(");
  });

  it("measures the worst stop, and declines everything it cannot resolve", () => {
    for (const viewport of ["mobile", "desktop"] as const) {
      const findings = findingsFor("text-over-gradient", viewport);
      expect(findings.map((f) => f.selector)).toEqual(["#fade-caption"]);

      // White text is comfortable at the #1b3a6b end and invisible at the
      // #eaf2ff end. The sentence says the number belongs to the worst stop and
      // not to the element, and the row gates nothing: the engine knows what
      // the element paints, not where inside it the glyphs landed.
      expect(findings[0]?.detail).toBe(
        "advisory: text contrast 1.13:1 at the worst stop of the background gradient " +
          "is below WCAG AA 4.5:1",
      );
      expect(findings[0]?.blockEligible).toBe(false);

      // #ink-caption is the control: same shape, resolved the same way, and
      // readable at both ends, so a resolved gradient is a measurement and not
      // a verdict. #wide-caption and #layered-caption cannot be resolved at
      // all, and silence is the only honest answer for them.
      const selectors = findings.map((f) => f.selector);
      expect(selectors).not.toContain("#ink-caption");
      expect(selectors).not.toContain("#wide-caption");
      expect(selectors).not.toContain("#layered-caption");
    }
  });
});
