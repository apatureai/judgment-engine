import { describe, expect, it } from "vitest";
import { extractTailwindV4 } from "../src/index.js";

describe("extractTailwindV4", () => {
  it("collects @theme custom properties as tokens", () => {
    const result = extractTailwindV4(`
      @import "tailwindcss";
      @theme {
        --color-brand: #bada55;
        --spacing-gutter: 24px;
        --font-display: "Satoshi", sans-serif;
      }
    `);
    expect(result.tokens).toEqual({
      "--color-brand": "#bada55",
      "--spacing-gutter": "24px",
      "--font-display": '"Satoshi", sans-serif',
    });
    expect(result.configPath).toBeNull();
  });

  it("surfaces a @config directive path for #56 resolution", () => {
    const result = extractTailwindV4(`@config "./tailwind.config.ts";\n@theme { --color-x: #000; }`);
    expect(result.configPath).toBe("./tailwind.config.ts");
    expect(result.tokens["--color-x"]).toBe("#000");
  });

  it("returns empty results for CSS with no Tailwind v4 directives", () => {
    expect(extractTailwindV4(`.btn { color: red; }`)).toEqual({ tokens: {}, configPath: null });
  });
});
