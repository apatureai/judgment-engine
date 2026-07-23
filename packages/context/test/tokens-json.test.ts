import { describe, expect, it } from "vitest";
import { mergeTokens, parseTokensJson, resolveTokenAliases, sortTokens } from "../src/index.js";

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

  it("resolves DTCG aliases to the referenced token's value", () => {
    const doc = {
      color: { brand: { $value: "#2563EB", $type: "color" } },
      button: { bg: { $value: "{color.brand}", $type: "color" } },
    };
    expect(parseTokensJson(doc)).toEqual({
      "color.brand": "#2563EB",
      "button.bg": "#2563EB", // resolved, not "{color.brand}"
    });
  });

  it("does NOT mistake a serialized composite for an alias", () => {
    const doc = { shadow: { card: { $value: { x: 0, y: 1, blur: 2 } } } };
    // composite stays JSON-serialized, never treated as a reference
    expect(parseTokensJson(doc)).toEqual({ "shadow.card": '{"x":0,"y":1,"blur":2}' });
  });
});

describe("resolveTokenAliases", () => {
  it("follows alias chains to the concrete value", () => {
    expect(resolveTokenAliases({ "a": "16px", "b": "{a}", "c": "{b}" })).toEqual({
      "a": "16px", "b": "16px", "c": "16px",
    });
  });

  it("leaves a dangling reference as its original literal (never dropped)", () => {
    expect(resolveTokenAliases({ "a": "{missing.token}" })).toEqual({ "a": "{missing.token}" });
  });

  it("leaves a reference cycle as its original literal (never loops)", () => {
    expect(resolveTokenAliases({ "a": "{b}", "b": "{a}" })).toEqual({ "a": "{b}", "b": "{a}" });
    expect(resolveTokenAliases({ "self": "{self}" })).toEqual({ "self": "{self}" });
  });

  it("is a no-op on concrete values and composites", () => {
    const map = { "color.brand": "#fff", "shadow.card": '{"x":0,"y":1}' };
    expect(resolveTokenAliases(map)).toEqual(map);
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
