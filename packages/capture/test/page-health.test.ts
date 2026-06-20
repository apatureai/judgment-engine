import { describe, expect, it } from "vitest";
import { buildPageHealth, pageHealthFootnote } from "../src/index.js";

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
