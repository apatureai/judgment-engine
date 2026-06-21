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
