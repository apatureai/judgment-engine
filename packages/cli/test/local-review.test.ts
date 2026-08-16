import type {
  CaptureBrowser,
  CapturePage,
  ExtractedPage,
  ScreenshotSink,
} from "@engine/capture";
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  PassModelConfig,
} from "@engine/critique";
import type { ContextBlockInput } from "@engine/context";
import { describe, expect, it } from "vitest";
import { runLocalReview, type LocalReviewOutcome } from "../src/index.js";

/**
 * The shipped local pipeline (#2): the same function the terminal CLI and the
 * HTTP job server both run, driven against a fake browser and a scripted model.
 *
 * What it pins: the deterministic breakage the capture measures reaches triage,
 * and a triage answer that declines a deep review does NOT get the last word
 * over a measurement. Before this, `deterministicBreakage` was a field the
 * orchestrator threaded, the triage pass honoured, and nothing on either shipped
 * surface ever populated, so the only thing that could force a deep review in
 * production was the cheap model agreeing to one.
 */

function fakePng(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 780);
  view.setUint32(20, 1688);
  return bytes;
}

/**
 * One landmark the model can cite, one paragraph whose content is wider than its
 * box (measured overflow: breakage) and one undersized button (measured
 * touch-target: a real defect that is deliberately NOT breakage).
 */
function extracted(options: { overflowing: boolean }): ExtractedPage {
  return {
    bodyText: "pricing",
    documentHeight: 1400,
    canvasBackground: "rgb(255, 255, 255)",
    fonts: [],
    elements: [
      {
        tag: "h1",
        id: "hero-title",
        testId: null,
        role: null,
        cssPath: "body > main > h1",
        rect: { x: 32, y: 80, width: 600, height: 44 },
        animated: false,
        interactive: false,
        text: null,
      },
      {
        tag: "button",
        id: "icon-close",
        testId: null,
        role: null,
        cssPath: "body > main > button",
        rect: { x: 700, y: 80, width: 28, height: 28 },
        animated: false,
        interactive: true,
        text: null,
      },
      {
        tag: "p",
        id: "hero-subtitle",
        testId: null,
        role: null,
        cssPath: "body > main > p",
        rect: { x: 32, y: 140, width: 400, height: 24 },
        animated: false,
        interactive: false,
        text: {
          fontSizePx: 17,
          fontWeight: 400,
          color: "rgb(20, 20, 20)",
          backgroundStack: ["rgb(255, 255, 255)"],
          contentWidthPx: options.overflowing ? 900 : 380,
        },
      },
    ],
  };
}

function fakeBrowser(options: { overflowing: boolean }): CaptureBrowser {
  const page: CapturePage = {
    clock: { async install() {}, async pauseAt() {} },
    async goto() {},
    async waitForSelector() {},
    async addStyleTag() {},
    async emulateReducedMotion() {},
    async freezeAnimations() {},
    async evaluate<R>(expression: string): Promise<R> {
      if (expression.startsWith("Math.max")) return 1400 as R;
      if (expression.startsWith("(window.scrollTo")) return null as R;
      return extracted(options) as unknown as R;
    },
    async waitForFontsReady() {},
    async waitForLayoutStable() {},
    async wait() {},
    async screenshot() {
      return fakePng();
    },
    consoleEvents: () => [],
    failedRequests: () => [],
    async close() {},
  };
  return {
    async newContext() {
      return {
        async newPage() {
          return page;
        },
        async close() {},
      };
    },
    async close() {},
  };
}

const memorySink = (): ScreenshotSink => ({
  async put(key: string) {
    return key;
  },
});

const CONTEXT: ContextBlockInput = {
  tokens: {},
  brand: null,
  componentLibraries: [],
  uiDnaVersion: null,
  routes: ["/pricing"],
};

/**
 * A triage pass that always answers "no deep review needed, no suspects", and a
 * deep pass that reports one grounded finding if it is ever reached. That is the
 * exact shape the fix is about: the measurement, not the model, has to be what
 * decides here.
 */
function decliningModel(): {
  factory: (config: PassModelConfig) => ModelClient;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    backend: "mock",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      const system = request.messages.find((m) => m.role === "system")?.content ?? "";
      let text = "prose";
      if (system.startsWith("You are triaging")) {
        text = JSON.stringify({ needsDeepReview: false, suspectRoutes: [], obviousBreakage: [] });
      } else if (request.responseFormat === "json_object" || request.responseFormat === "json_schema") {
        text = JSON.stringify({
          grade: "needs_work",
          overall: "The subtitle overflows its container.",
          findings: [
            {
              dimension: "responsiveness",
              severity: "major",
              confidence: 0.9,
              route: "/pricing",
              viewport: "desktop",
              elementRef: "#hero-title",
              title: "Subtitle overflows",
              description: "The subtitle text runs past the edge of its container.",
              suggestion: "Wrap the text.",
              introducedByThisPr: true,
            },
          ],
          notReviewed: [],
        });
      }
      return {
        text,
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        finishReason: "stop",
      };
    },
  };
  return { factory: () => client, requests };
}

async function review(overflowing: boolean): Promise<{
  outcome: LocalReviewOutcome;
  requests: ModelRequest[];
}> {
  const { factory, requests } = decliningModel();
  const outcome = await runLocalReview(
    {
      url: "http://127.0.0.1:5000",
      routes: ["/pricing"],
      viewports: ["desktop"],
      installationId: "test",
      depth: "deep",
      context: CONTEXT,
    },
    { browser: fakeBrowser({ overflowing }), sink: memorySink(), modelFactory: factory },
  );
  return { outcome, requests };
}

describe("runLocalReview threads the measured breakage into triage", () => {
  it("forces a deep review over a triage pass that declined one", async () => {
    const { outcome, requests } = await review(true);

    // The capture measured it, with no model involved.
    expect(outcome.capture.deterministicFindings.map((f) => f.kind)).toContain("overflow");
    // The triage model said no. A deep pass ran anyway, and judged the route.
    const deepCalls = requests.filter(
      (r) => !(r.messages.find((m) => m.role === "system")?.content ?? "").startsWith("You are triaging"),
    );
    expect(deepCalls.length).toBeGreaterThan(0);
    expect(outcome.result.coverage?.routesReviewed).toEqual(["/pricing"]);
    expect(outcome.result.findings).toHaveLength(1);
    expect(outcome.result.grade).toBe("needs_work");
  });

  it("still takes the triage pass at its word when nothing was measured as broken", async () => {
    const { outcome, requests } = await review(false);

    expect(outcome.capture.deterministicFindings.map((f) => f.kind)).not.toContain("overflow");
    const deepCalls = requests.filter(
      (r) => !(r.messages.find((m) => m.role === "system")?.content ?? "").startsWith("You are triaging"),
    );
    expect(deepCalls).toHaveLength(0);
    // And the run says so rather than grading the page: triage had no baseline
    // to decline against, so nothing judged this page.
    expect(outcome.result.coverage?.routesReviewed).toEqual([]);
    expect(outcome.result.gradeUnavailableReason).toBe("nothing_reviewed");
    expect(outcome.result.overall).toContain("Nothing was reviewed");
  });

  it("does not treat contrast or an undersized touch target as breakage", async () => {
    // The same page always carries an undersized button. On the non-overflowing
    // run above that measurement exists and did NOT force a deep review, which
    // is the classification `BREAKAGE_KINDS` makes and this pins from the
    // shipped surface rather than from the helper.
    const { outcome } = await review(false);
    expect(outcome.capture.deterministicFindings.map((f) => f.kind)).toContain("touch_target");
    expect(outcome.result.coverage?.routesReviewed).toEqual([]);
  });
});
