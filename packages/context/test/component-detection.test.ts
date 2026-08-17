import { describe, expect, it } from "vitest";
import {
  COMPONENT_LIBRARY_IDS,
  detectComponentLibraries,
  resolveComponentLibraries,
} from "../src/index.js";

describe("detectComponentLibraries", () => {
  it("detects shadcn (cva signature) and radix primitives", () => {
    const libs = detectComponentLibraries({
      dependencies: {
        "class-variance-authority": "^0.7.0",
        "@radix-ui/react-dialog": "^1.0.0",
      },
    });
    const ids = libs.map((l) => l.id).sort();
    expect(ids).toEqual(["radix", "shadcn/ui"]);
    expect(libs.find((l) => l.id === "shadcn/ui")?.rubricAddendum).toContain("CSS-variable");
  });

  it("detects MUI/Chakra/Mantine by scoped prefix from any dep section", () => {
    expect(detectComponentLibraries({ dependencies: { "@mui/material": "^5" } })[0]?.id).toBe("mui");
    expect(detectComponentLibraries({ devDependencies: { "@chakra-ui/react": "^2" } })[0]?.id).toBe(
      "chakra",
    );
    expect(detectComponentLibraries({ peerDependencies: { "@mantine/core": "^7" } })[0]?.id).toBe(
      "mantine",
    );
  });

  it("is a no-op when no known library is present", () => {
    expect(detectComponentLibraries({ dependencies: { react: "^18", lodash: "^4" } })).toEqual([]);
    expect(detectComponentLibraries({})).toEqual([]);
  });
});

/**
 * The other half of detection, for the callers that hold a repository this
 * engine does not: they name the libraries, the engine writes the rubric.
 */
describe("resolveComponentLibraries", () => {
  it("gives a caller's ids this engine's own addenda, never the caller's prose", () => {
    const libs = resolveComponentLibraries(["mui"]);
    expect(libs).toEqual(detectComponentLibraries({ dependencies: { "@mui/material": "^5" } }));
    expect(libs[0]?.rubricAddendum).toContain("8px spacing system");
  });

  it("drops an id it has no rubric for instead of failing the request", () => {
    // A newer caller detecting a library this engine has never heard of should
    // produce a review grounded on the libraries it does know, not a rejection.
    expect(resolveComponentLibraries(["radix", "vuetify", ""]).map((l) => l.id)).toEqual(["radix"]);
    expect(resolveComponentLibraries(["nothing-here"])).toEqual([]);
    expect(resolveComponentLibraries([])).toEqual([]);
  });

  it("is order-independent, because the context block is a prefix-cache key", () => {
    // Two requests naming the same libraries in different orders describe the
    // same repository and must serialize to the same block, or they miss each
    // other's cache entry for no reason.
    expect(resolveComponentLibraries(["radix", "mui"])).toEqual(
      resolveComponentLibraries(["mui", "radix"]),
    );
  });

  it("publishes the vocabulary both sides of the contract have to agree on", () => {
    expect([...COMPONENT_LIBRARY_IDS].sort()).toEqual([
      "chakra",
      "mantine",
      "mui",
      "radix",
      "shadcn/ui",
    ]);
    // Every published id resolves; the list is the contract, not a hint.
    expect(resolveComponentLibraries(COMPONENT_LIBRARY_IDS)).toHaveLength(
      COMPONENT_LIBRARY_IDS.length,
    );
  });
});
