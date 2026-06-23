import { describe, expect, it } from "vitest";
import { extractCssCustomProperties } from "../src/index.js";

describe("extractCssCustomProperties", () => {
  it("collects :root custom properties as base tokens", () => {
    const { base } = extractCssCustomProperties(`
      :root { --color-bg: #ffffff; --space-1: 4px; }
    `);
    expect(base).toEqual({ "--color-bg": "#ffffff", "--space-1": "4px" });
  });

  it("captures theme-scoped blocks: [data-theme], .dark, and prefers-color-scheme", () => {
    const result = extractCssCustomProperties(`
      :root { --color-bg: #ffffff; }
      [data-theme="dark"] { --color-bg: #000000; }
      @media (prefers-color-scheme: dark) { :root { --color-fg: #eeeeee; } }
      .dark { --accent: #8b5cf6; }
    `);
    expect(result.base).toEqual({ "--color-bg": "#ffffff" });
    expect(result.themes.dark).toEqual({
      "--color-bg": "#000000",
      "--color-fg": "#eeeeee",
      "--accent": "#8b5cf6",
    });
  });

  it("ignores component-scoped custom properties (not design tokens)", () => {
    const result = extractCssCustomProperties(`
      .button { --btn-x: 1px; }
      :root { --real: 2px; }
    `);
    expect(result.base).toEqual({ "--real": "2px" });
    expect(result.themes).toEqual({});
  });

  it("ignores theme-prefixed component scopes (`.dark .button`) — not a theme token", () => {
    const result = extractCssCustomProperties(`
      .dark .button { --bg: #111; }
      .light .button { --bg: #eee; }
    `);
    expect(result.base).toEqual({});
    expect(result.themes).toEqual({});
  });

  it("ignores component scopes inside a prefers-color-scheme media query", () => {
    const result = extractCssCustomProperties(`
      @media (prefers-color-scheme: dark) {
        .button { --bg: #111; }
      }
    `);
    expect(result.base).toEqual({});
    expect(result.themes).toEqual({});
  });

  it("ignores theme classes compounded with a component (`.dark.fancy`)", () => {
    const result = extractCssCustomProperties(`
      .dark.fancy { --bg: #111; }
    `);
    expect(result.base).toEqual({});
    expect(result.themes).toEqual({});
  });

  it("still captures legitimate base-scoped theme blocks (no regression)", () => {
    const result = extractCssCustomProperties(`
      :root { --color-bg: #ffffff; }
      .dark { --accent: #8b5cf6; }
      [data-theme="brand"] { --accent: #ff0066; }
      @media (prefers-color-scheme: dark) { :root { --color-fg: #eeeeee; } }
    `);
    expect(result.base).toEqual({ "--color-bg": "#ffffff" });
    expect(result.themes.dark).toEqual({
      "--accent": "#8b5cf6",
      "--color-fg": "#eeeeee",
    });
    expect(result.themes.brand).toEqual({ "--accent": "#ff0066" });
  });
});
