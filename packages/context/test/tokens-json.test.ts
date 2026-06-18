import { describe, expect, it } from "vitest";
import { mergeTokens, parseTokensJson, sortTokens } from "../src/index.js";

describe("parseTokensJson", () => {
  it("parses the W3C design-tokens shape ($value/$type)", () => {
    const doc = {
      color: {
        brand: {
          primary: { $value: "#ff0000", $type: "color" },
          secondary: { $value: "#00ff00", $type: "color" },
        },
      },
      space: { sm: { $value: "4px", $type: "dimension" } },
    };
    expect(parseTokensJson(doc)).toEqual({
      "color.brand.primary": "#ff0000",
      "color.brand.secondary": "#00ff00",
      "space.sm": "4px",
    });
  });

  it("parses the classic Style Dictionary shape (value)", () => {
    const doc = { size: { font: { base: { value: 16 } } } };
    expect(parseTokensJson(doc)).toEqual({ "size.font.base": "16" });
  });

  it("ignores $-prefixed metadata and serializes composite tokens deterministically", () => {
    const doc = {
      $description: "ignore me",
      shadow: { card: { $value: { x: 0, y: 1, blur: 2 } } },
    };
    expect(parseTokensJson(doc)).toEqual({ "shadow.card": '{"x":0,"y":1,"blur":2}' });
  });

  it("returns an empty map for non-object input", () => {
    expect(parseTokensJson(null)).toEqual({});
    expect(parseTokensJson("nope")).toEqual({});
  });
});

describe("token merge + sort", () => {
  it("merges sources with later-source-wins and sorted keys", () => {
    const merged = mergeTokens([
      { source: "tailwind", tokens: { "color.b": "1", "color.a": "2" } },
      { source: "css-vars", tokens: { "color.b": "override" } },
    ]);
    expect(Object.keys(merged)).toEqual(["color.a", "color.b"]); // sorted
    expect(merged["color.b"]).toBe("override"); // later source wins
  });

  it("sortTokens is order-independent (deterministic)", () => {
    expect(JSON.stringify(sortTokens({ b: "1", a: "2" }))).toBe(
      JSON.stringify(sortTokens({ a: "2", b: "1" })),
    );
  });
});
