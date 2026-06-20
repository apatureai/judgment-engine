import { describe, expect, it } from "vitest";
import { captureInSandbox } from "../src/index.js";

describe("captureInSandbox (stub)", () => {
  it("produces a capture per route × viewport implementing the shared interface", async () => {
    const capture = await captureInSandbox("https://preview.example.com", {
      installationId: "1",
      viewports: ["mobile", "desktop"],
      darkMode: false,
      isFork: false,
      routes: ["/", "/pricing"],
    });
    expect(capture.images).toHaveLength(4); // 2 routes × 2 viewports
    expect(capture.images[0]).toMatchObject({ route: "/", viewport: "mobile" });
    expect(capture.pageHealth.unstable).toBe(false);
    expect(typeof capture.captureVersion).toBe("string");
  });
});
