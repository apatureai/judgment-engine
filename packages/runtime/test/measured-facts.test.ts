import { signEngineRequest } from "@engine/api";
import type { ModelClientFactory, ModelRequest, ModelResponse } from "@engine/critique";
import { pgliteExecutor, runMigrations } from "@engine/db";
import { JobStore, type JobRecord } from "@engine/jobs";
import { InMemoryObjectStore } from "@engine/storage";
import type { CaptureContext, EngineReviewResult } from "@engine/types";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEngineRuntime,
  HttpCaptureClient,
  measuredRoutes,
  measurementGap,
  toReviewInput,
  type CaptureClient,
  type EngineRuntime,
  type MeasuredCapture,
} from "../src/index.js";

/**
 * The measured half of a review, on the path that is actually deployed.
 *
 * `factsForRoute` and `breakageForRoute` had exactly one call site,
 * `packages/cli/src/local-review.ts`, so everything the engine measures reached
 * the prompt only when a review ran in-process. The service composition builds
 * its routes in `toReviewInput`, which runs before capture and emitted bare
 * `{ route }` objects, and its capture client parsed the fleet's answer with a
 * `.strict()` schema that had no field for a measurement at all. So the
 * deployable engine -- the one behind the HTTP API that Gate calls -- ran every
 * deep prompt with no measured facts and every triage pass with nothing that
 * could overrule a model declining to look.
 *
 * These tests pin the fix at the two ends that matter: the wire contract can
 * carry a measurement, and a measurement that arrives changes what the deployed
 * pipeline does.
 */

const SECRET = "measured-facts-secret";
const VIEWPORT = "desktop" as const;

function reviewRequest(routes: string[] = ["/"]) {
  return {
    installationId: "tenant_1",
    repository: { owner: "apatureai", name: "demo", defaultBranch: "main" },
    pullRequest: {
      number: 42,
      headSha: "head-sha",
      baseSha: "base-sha",
      title: "Demo PR",
      body: null,
    },
    preview: { url: "https://preview.example.test", provider: "vercel" as const, environment: "Preview" },
    config: {
      preview: {
        source: "vercel" as const,
        environment: "Preview",
        urlTemplate: null,
        waitSeconds: 0,
        readySelector: null,
        readyPath: null,
        readyStatus: null,
        protectionBypassSecretName: null,
        authStateSecretName: null,
        forkPreview: false,
      },
      routes: { always: routes, maxPerPr: 5, map: {} },
      viewports: [VIEWPORT],
      darkMode: false,
      brand: null,
      rules: { gate: "none" as const, minSeverityToComment: "nit" as const, suppress: [] },
      tokens: { source: null, values: {} },
    },
    publishMode: "advisory" as const,
    depth: "deep" as const,
  };
}

function job(input: unknown = reviewRequest()): JobRecord {
  const now = new Date();
  return {
    id: "job_measured",
    consumer: "gate",
    installationId: "tenant_1",
    intentType: "pr_review",
    idempotencyKey: "gate:tenant_1:pr_review:measured",
    depth: "deep",
    status: "running",
    input,
    priority: 0,
    resultPointer: null,
    error: null,
    attempts: 1,
    claimGeneration: 1,
    leaseOwner: "w-test",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    heartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
  } as unknown as JobRecord;
}

/** An overflow on "/" at two viewports plus a contrast failure on "/" and "/pricing". */
function measuredCapture(routes: string[] = ["/"]): MeasuredCapture {
  return {
    images: routes.map((route) => ({
      route,
      viewport: VIEWPORT,
      objectKey: `jobs/test/capture${route}.png`,
      width: 1280,
      height: 720,
    })),
    geometry: [],
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
    captureVersion: "capture-http@1",
    deterministicFindings: [
      {
        kind: "overflow",
        route: "/",
        viewport: "mobile",
        selector: "#pricing-table",
        detail: "content width 520px exceeds container 375px (horizontal overflow)",
      },
      {
        kind: "overflow",
        route: "/",
        viewport: "tablet",
        selector: "#pricing-table",
        detail: "content width 520px exceeds container 375px (horizontal overflow)",
      },
      {
        kind: "contrast",
        route: "/",
        viewport: "desktop",
        selector: "#hero-subtitle",
        detail: "text contrast 2.31:1 is below WCAG AA 4.5:1",
      },
      {
        kind: "touch_target",
        route: "/pricing",
        viewport: "mobile",
        selector: "#buy",
        detail: "touch target 30x30px is below 44x44px",
      },
    ],
    pageText: { "/": "Pricing that scales with you" },
  };
}

function captureClientFor(capture: MeasuredCapture): CaptureClient {
  return {
    forJob: (_jobId: string, signal: AbortSignal) => async (_url: string, _ctx: CaptureContext) => {
      if (signal.aborted) throw new Error("aborted");
      return capture;
    },
    cancel: async () => undefined,
    ready: async () => true,
  };
}

/**
 * A judge that DECLINES a deep review at triage and names no route, and that
 * emits one finding if a deep pass ever runs. With no measured breakage the run
 * ends at the triage short-circuit with nothing judged; measured breakage is the
 * only thing that can overrule it.
 */
function decliningModelFactory(seen: { triage: string[]; deep: string[] }): ModelClientFactory {
  return () => ({
    backend: "mock",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const system = request.messages.find((message) => message.role === "system")?.content ?? "";
      const user = request.messages.find((message) => message.role === "user")?.content ?? "";
      if (system.startsWith("You are triaging")) {
        seen.triage.push(user);
        return {
          text: JSON.stringify({ needsDeepReview: false, suspectRoutes: [], obviousBreakage: [] }),
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
          finishReason: "stop",
        };
      }
      // The deep pass is two calls: the grounded critique over the images, then a
      // JSON coercion of its prose. Only the first carries the route's inputs.
      if (!system.startsWith("Convert the review")) seen.deep.push(user);
      return {
        text: JSON.stringify({
          grade: "needs_work",
          overall: "The pricing table overflows its container.",
          findings: [{
            dimension: "responsiveness",
            severity: "major",
            confidence: 0.8,
            route: "/",
            viewport: VIEWPORT,
            elementRef: null,
            title: "Pricing table overflows",
            description: "The pricing table is wider than its container.",
            suggestion: "Constrain the table width.",
            introducedByThisPr: true,
          }],
          notReviewed: [],
        }),
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        finishReason: "stop",
      };
    },
  });
}

describe("measuredRoutes", () => {
  it("carries facts, deduplicated breakage and page text onto the routes it is given", () => {
    const routes = measuredRoutes(["/", "/pricing"], measuredCapture(["/", "/pricing"]));
    const home = routes[0];
    expect(home?.route).toBe("/");
    // Every measurement for the route, viewport-labelled, in the deep prompt's
    // fact form. The contrast failure is a fact and not breakage.
    expect(home?.facts).toEqual([
      "- [overflow] #pricing-table (mobile): content width 520px exceeds container 375px (horizontal overflow)",
      "- [overflow] #pricing-table (tablet): content width 520px exceeds container 375px (horizontal overflow)",
      "- [contrast] #hero-subtitle (desktop): text contrast 2.31:1 is below WCAG AA 4.5:1",
    ]);
    // One broken element measured at two widths is one reason to look, not two.
    expect(home?.deterministicBreakage).toEqual([
      "[overflow] / #pricing-table: content width 520px exceeds container 375px (horizontal overflow)",
    ]);
    expect(home?.pageText).toBe("Pricing that scales with you");

    const pricing = routes[1];
    expect(pricing?.facts).toEqual([
      "- [touch_target] #buy (mobile): touch target 30x30px is below 44x44px",
    ]);
    // A touch target is a defect on a page that rendered correctly, so it never
    // overrules triage.
    expect(pricing?.deterministicBreakage).toBeUndefined();
    expect(pricing?.pageText).toBeUndefined();
  });

  it("leaves a clean route byte-identical to the bare route it replaced", () => {
    const clean: MeasuredCapture = { ...measuredCapture(), deterministicFindings: [], pageText: {} };
    expect(measuredRoutes(["/"], clean)).toEqual([{ route: "/" }]);
  });

  it("keeps a capture with no measurements from inventing any", () => {
    const unmeasured: MeasuredCapture = {
      images: [],
      geometry: [],
      pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
      captureVersion: "capture-http@1",
    };
    expect(measuredRoutes(["/"], unmeasured)).toEqual([{ route: "/" }]);
  });
});

describe("measurementGap", () => {
  it("says nothing when the capture service reported that it measured nothing", () => {
    // An empty array is a positive statement: the checks ran and the page was
    // clean. Reporting a gap here would call a clean page unmeasured.
    expect(measurementGap({ ...measuredCapture(), deterministicFindings: [] })).toBeNull();
  });

  it("names the consequence when no measurement arrived at all", () => {
    const unmeasured: MeasuredCapture = {
      images: [],
      geometry: [],
      pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
      captureVersion: "capture-http@1",
    };
    const gap = measurementGap(unmeasured);
    expect(gap).toContain("no deterministic measurements");
    expect(gap).toContain("deep prompt");
    expect(gap).toContain("triage");
  });
});

describe("capture service contract", () => {
  it("accepts a capture response that carries what the service measured", async () => {
    // The schema this parses with is `.strict()`. Before these fields existed, a
    // capture service that measured a page and said so had its entire response
    // rejected, which is why nothing measured ever reached this path.
    const body = measuredCapture();
    const client = new HttpCaptureClient("https://capture.test", "token", async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    const captured = await client.forJob("job_1", new AbortController().signal)(
      "https://preview.example.test",
      { installationId: "tenant_1", viewports: [VIEWPORT], darkMode: false, isFork: true, routes: ["/"] },
    );
    expect(captured.deterministicFindings).toHaveLength(4);
    expect(captured.pageText).toEqual({ "/": "Pricing that scales with you" });
  });

  it("rejects a measurement of a kind nothing downstream can classify", async () => {
    const body = {
      ...measuredCapture(),
      deterministicFindings: [{
        kind: "vibes",
        route: "/",
        viewport: VIEWPORT,
        selector: "#hero",
        detail: "looks off",
      }],
    };
    const client = new HttpCaptureClient("https://capture.test", "token", async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(client.forJob("job_1", new AbortController().signal)(
      "https://preview.example.test",
      { installationId: "tenant_1", viewports: [VIEWPORT], darkMode: false, isFork: true, routes: ["/"] },
    )).rejects.toThrow();
  });
});

describe("the deployed pipeline carries what the capture measured", () => {
  let runtime: EngineRuntime | undefined;
  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  interface Run {
    result: EngineReviewResult;
    /** Every user message the deep pass was given, in call order. */
    deepPrompts: string[];
    /** Every line the composition logged. */
    logs: string[];
  }

  async function runJob(capture: MeasuredCapture): Promise<Run> {
    const seen = { triage: [] as string[], deep: [] as string[] };
    const logs: string[] = [];
    const db = new PGlite();
    const exec = pgliteExecutor(db);
    await runMigrations(exec);
    runtime = createEngineRuntime({
      store: new JobStore(exec),
      objectStore: new InMemoryObjectStore(),
      engineHmacSecret: SECRET,
      capture: captureClientFor(capture),
      modelFactory: decliningModelFactory(seen),
      databaseReady: async () => true,
      workerPollMs: 5,
      logger: { info: (line: string) => logs.push(line), error: (line: string) => logs.push(line) },
    });
    const port = await runtime.start(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const submitBody = JSON.stringify({
      idempotencyKey: "measured-facts",
      depth: "deep",
      request: reviewRequest(),
    });
    const submit = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: signEngineRequest({ body: submitBody, installationId: "tenant_1", secret: SECRET }),
      body: submitBody,
    });
    expect(submit.status).toBe(202);
    const { jobId } = await submit.json() as { jobId: string };

    for (let attempt = 0; attempt < 200; attempt++) {
      const headers = signEngineRequest({ body: "", installationId: "tenant_1", secret: SECRET });
      const polled = await (await fetch(`${base}/jobs/${jobId}`, { headers })).json() as {
        state: string;
        result?: EngineReviewResult;
        error?: string;
      };
      if (polled.state === "completed" && polled.result) {
        return { result: polled.result, deepPrompts: seen.deep, logs };
      }
      if (polled.state === "failed") throw new Error(polled.error ?? "review failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("review did not complete");
  }

  it("lets a measured overflow overrule a triage pass that declined to look", async () => {
    // This is the whole point of measuring. The triage model answers
    // `{"needsDeepReview": false, "suspectRoutes": []}`; without the measurement
    // the run stops there, judges nothing, and reports the route not reviewed
    // for want of a baseline. With it, the route is suspect by measurement and
    // the deep pass runs.
    const { result } = await runJob(measuredCapture());
    expect(result.coverage?.routesReviewed).toEqual(["/"]);
    expect(result.findings.map((finding) => finding.title)).toEqual(["Pricing table overflows"]);
    expect(result.notReviewed).toEqual([]);
    expect(result.gradeUnavailableReason).toBeUndefined();
  });

  it("grounds the deep prompt on every measurement for the route", async () => {
    const { deepPrompts } = await runJob(measuredCapture());
    expect(deepPrompts).toHaveLength(1);
    const prompt = deepPrompts[0] ?? "";
    expect(prompt).toContain("Deterministic facts:");
    expect(prompt).toContain("- [contrast] #hero-subtitle (desktop): text contrast 2.31:1 is below WCAG AA 4.5:1");
    expect(prompt).toContain("- [overflow] #pricing-table (mobile)");
    // #53: the page's own text reaches the prompt as untrusted content, which is
    // the other per-route input the local pipeline populated and this one did not.
    expect(prompt).toContain("Pricing that scales with you");
  });

  it("reports the gap instead of reviewing unmeasured pages in silence", async () => {
    const unmeasured: MeasuredCapture = {
      images: measuredCapture().images,
      geometry: [],
      pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
      captureVersion: "capture-http@1",
    };
    const { result, logs } = await runJob(unmeasured);
    expect(logs.some((line) => line.includes("no deterministic measurements"))).toBe(true);
    // And the run behaves exactly as it did before this change: nothing overrules
    // the declining triage, so nothing is judged and the result says so. The gap
    // is stated, never papered over.
    expect(result.coverage?.routesReviewed).toEqual([]);
    expect(result.gradeUnavailableReason).toBe("nothing_reviewed");
  });

  it("says nothing about a gap when the service measured and found nothing", async () => {
    const { logs } = await runJob({ ...measuredCapture(), deterministicFindings: [], pageText: {} });
    expect(logs.some((line) => line.includes("no deterministic measurements"))).toBe(false);
  });
});

describe("toReviewInput leaves the routes for the capture to fill", () => {
  it("still emits bare routes, because nothing has measured anything yet", () => {
    // Pinned so the seam stays visible: `toReviewInput` runs before capture, so
    // the composition root is the only place these can be filled, and a caller
    // that binds `toReviewInput` to a raw `runReview` gets unfacted routes.
    expect(toReviewInput(job()).routes).toEqual([{ route: "/" }]);
  });
});

describe("published retention agrees with the signature that enforces it", () => {
  // A zero here is not "no promise", it is "already expired". Gate computes
  // expiresAt = receivedAt + retention and refuses its own screenshot proxy once
  // that passes, so every review the deployed service published arrived with
  // evidence records born expired. The number a consumer reads has to be the
  // number the signed URL is issued with.
  it("reports the evidence URL TTL as the retention", () => {
    expect(toReviewInput(job(), 900).wireOptions?.screenshotRetentionSeconds).toBe(900);
    expect(toReviewInput(job(), 3_600).wireOptions?.screenshotRetentionSeconds).toBe(3_600);
  });

  it("never publishes a zero, which downstream reads as already expired", () => {
    expect(toReviewInput(job()).wireOptions?.screenshotRetentionSeconds).toBeGreaterThan(0);
  });
});
