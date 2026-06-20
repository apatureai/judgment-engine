import { describe, expect, it } from "vitest";
import { detectComponentLibraries } from "../src/index.js";

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
