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

describe("extractCssCustomProperties — resolves whole-value var() references", () => {
  it("resolves a base var() reference to the referenced value, following chains", () => {
    const { base } = extractCssCustomProperties(`
      :root {
        --color-brand: #2563EB;
        --button-bg: var(--color-brand);
        --cta-bg: var(--button-bg);
      }
    `);
    expect(base).toEqual({
      "--color-brand": "#2563EB",
      "--button-bg": "#2563EB",
      "--cta-bg": "#2563EB",
    });
  });

  it("uses the var() fallback when the referenced variable is undefined", () => {
    const { base } = extractCssCustomProperties(`
      :root { --pad: var(--space-2, 8px); }
    `);
    expect(base).toEqual({ "--pad": "8px" });
  });

  it("resolves a theme var() against the theme layered over base (CSS cascade)", () => {
    const result = extractCssCustomProperties(`
      :root { --color-brand: #2563EB; --btn: var(--color-brand); }
      [data-theme="dark"] { --color-brand: #60a5fa; --btn: var(--color-brand); }
    `);
    expect(result.base["--btn"]).toBe("#2563EB"); // :root brand
    expect(result.themes.dark["--btn"]).toBe("#60a5fa"); // theme overrides brand
  });

  it("leaves a dangling reference (no fallback) and a cycle as literals — never loops", () => {
    const { base } = extractCssCustomProperties(`
      :root { --a: var(--missing); --x: var(--y); --y: var(--x); --self: var(--self); }
    `);
    expect(base["--a"]).toBe("var(--missing)");
    expect(base["--x"]).toBe("var(--y)");
    expect(base["--y"]).toBe("var(--x)");
    expect(base["--self"]).toBe("var(--self)");
  });

  it("leaves an embedded var() (not a whole-value reference) untouched", () => {
    const { base } = extractCssCustomProperties(`
      :root { --shadow-color: #0003; --shadow: 0 1px 2px var(--shadow-color); }
    `);
    expect(base["--shadow"]).toBe("0 1px 2px var(--shadow-color)");
  });
});
