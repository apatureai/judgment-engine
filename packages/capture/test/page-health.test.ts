import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_FONTS,
  FONT_RENDER_HINTING_FLAG,
  blockedFonts,
  buildPageHealth,
  fontStabilityLaunchFlags,
  pageHealthFootnote,
} from "../src/index.js";

describe("buildPageHealth", () => {
  it("counts console errors (not warnings/logs) and failed requests", () => {
    const health = buildPageHealth({
      console: [
        { level: "error", text: "boom" },
        { level: "warning", text: "meh" },
        { level: "log", text: "hi" },
        { level: "ERROR", text: "caps" },
      ],
      failedRequests: [{ url: "/a", status: 500 }, { url: "/b", status: null }],
    });
    expect(health.consoleErrors).toBe(2);
    expect(health.failedRequests).toBe(2);
    expect(health.unstable).toBe(false);
  });
});

describe("pageHealthFootnote", () => {
  it("renders a footnote and is null when the page is clean", () => {
    expect(pageHealthFootnote({ consoleErrors: 0, failedRequests: 0, unstable: false })).toBeNull();
    const note = pageHealthFootnote({ consoleErrors: 1, failedRequests: 2, unstable: true });
    expect(note).toContain("1 console error(s)");
    expect(note).toContain("2 failed request(s)");
    expect(note).toContain("visually unstable");
  });
});

describe("the determinism check on the health summary (#15)", () => {
  it("omits stability entirely when the check did not run", () => {
    // Absent is "not checked". A zeroed `{ pagesCompared: 0 }` would claim a
    // check happened over nothing, which is the confusion this field removes.
    const health = buildPageHealth({ console: [], failedRequests: [] });
    expect(health.stability).toBeUndefined();
    expect(pageHealthFootnote(health)).toBeNull();
  });

  it("states a check that ran and passed, because silence cannot say that", () => {
    const health = buildPageHealth({
      console: [],
      failedRequests: [],
      stability: { pagesCompared: 6, unstablePages: 0 },
    });
    expect(health.stability).toEqual({ pagesCompared: 6, unstablePages: 0 });
    // The one clause here that is GOOD news, and the only reason a clean page
    // now produces a footnote at all: "verified stable" has to be readable as
    // something other than "nobody looked".
    expect(pageHealthFootnote(health)).toBe(
      "Page health: determinism check: 6 page(s) captured twice, all byte-identical.",
    );
  });

  it("names the pages that differed, beside the unstable flag they set", () => {
    const health = buildPageHealth({
      console: [],
      failedRequests: [],
      unstable: true,
      stability: { pagesCompared: 6, unstablePages: 2 },
    });
    const note = pageHealthFootnote(health);
    expect(note).toContain("visually unstable");
    expect(note).toContain("determinism check: 2 of 6 page(s) differed on a repeat capture");
  });
});

describe("blocked web-font detection (#83)", () => {
  it("flags any document.fonts entry not 'loaded' after fonts.ready", () => {
    const blocked = blockedFonts([
      { family: "Inter", status: "loaded" },
      { family: "Roboto", status: "error" }, // egress-blocked / CDN outage -> silent fallback
      { family: "Lato", status: "unloaded" },
    ]);
    expect(blocked.map((f) => f.family)).toEqual(["Roboto", "Lato"]);
  });

  it("records blocked fonts on the health summary and footnotes the silent substitution", () => {
    const health = buildPageHealth({
      console: [],
      failedRequests: [],
      fonts: [
        { family: "Inter", status: "loaded" },
        { family: "Roboto", status: "error" },
      ],
    });
    expect(health.blockedFonts).toBe(1);
    expect(pageHealthFootnote(health)).toContain("1 web font(s) blocked/substituted");
  });

  it("defaults blockedFonts to 0 when no font statuses were collected", () => {
    expect(buildPageHealth({ console: [], failedRequests: [] }).blockedFonts).toBe(0);
  });
});

describe("deterministic font policy (#83)", () => {
  it("pins the CJK/emoji-covering font set and the headless hinting flag", () => {
    expect(DETERMINISTIC_FONTS).toContain("Noto Sans CJK");
    expect(DETERMINISTIC_FONTS).toContain("Noto Color Emoji");
    expect(fontStabilityLaunchFlags()).toContain(FONT_RENDER_HINTING_FLAG);
    expect(FONT_RENDER_HINTING_FLAG).toBe("--font-render-hinting=none");
  });
});
