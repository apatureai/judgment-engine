import { describe, expect, it } from "vitest";
import { extractTailwindTokens, resolveTailwindV3Tokens } from "../src/index.js";

describe("resolveTailwindV3Tokens", () => {
  it("resolves a user config (merged with defaults) and flattens custom tokens", () => {
    const tokens = resolveTailwindV3Tokens({
      content: [],
      theme: {
        extend: {
          colors: { brand: { DEFAULT: "#bada55", dark: "#4a5d23" } },
          spacing: { gutter: "24px" },
          borderRadius: { card: "12px" },
        },
      },
    });
    expect(tokens).not.toBeNull();
    expect(tokens?.["colors.brand"]).toBe("#bada55"); // DEFAULT collapses onto parent
    expect(tokens?.["colors.brand.dark"]).toBe("#4a5d23");
    expect(tokens?.["spacing.gutter"]).toBe("24px");
    expect(tokens?.["borderRadius.card"]).toBe("12px");
    // Preset/required defaults are present (not missed, unlike static AST parsing).
    expect(tokens?.["colors.white"]).toBeTruthy();
  });

  it("returns null on a config that throws (caller degrades to CSS extraction)", () => {
    const exploding = {
      get theme(): never {
        throw new Error("config read env / imported app code");
      },
    };
    expect(resolveTailwindV3Tokens(exploding)).toBeNull();
  });
});

describe("extractTailwindTokens", () => {
  it("flattens fontFamily stacks and fontSize tuples", () => {
    const tokens = extractTailwindTokens({
      fontFamily: { sans: ["Inter", "system-ui", "sans-serif"] },
      fontSize: { base: ["1rem", { lineHeight: "1.5rem" }] },
      screens: { sm: "640px" },
    });
    expect(tokens["fontFamily.sans"]).toBe("Inter, system-ui, sans-serif");
    expect(tokens["fontSize.base"]).toBe("1rem");
    expect(tokens["screens.sm"]).toBe("640px");
  });
});
