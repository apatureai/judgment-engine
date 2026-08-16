import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  breakageForRoute,
  createBrowserCapture,
  factsForRoute,
  type BrowserCaptureResult,
  type CaptureBrowser,
  type DeterministicFinding,
  type ScreenshotSink,
} from "@engine/capture";
import type { ModelClientFactory } from "@engine/critique";
import { reviewSystemPrompt, runReview, type ReviewRoute } from "@engine/review";
import type { ContextBlockInput } from "@engine/context";
import type {
  CaptureContext,
  Critique,
  EngineReviewResult,
  PreviewBuildFact,
  Viewport,
} from "@engine/types";

/**
 * One local, in-process review: real Chromium capture, real deterministic
 * measurement, the real orchestrator and the real grounding gate, with no
 * database, no object store and no capture fleet.
 *
 * This module exists so there is exactly ONE local pipeline, not two. The
 * terminal CLI (`run.ts`) and the local HTTP job server (`@engine/serve`) are
 * two front doors onto this function; neither reimplements a step, so a result
 * polled from `GET /jobs/:id` and a result written to `out/review.json` are the
 * same bytes for the same input. Every live I/O is a parameter: the browser,
 * the screenshot sink and the model client factory, which is what keeps the
 * whole thing testable against a fake browser and the mock model.
 */

export interface LocalReviewRequest {
  /** Base URL to capture. Routes are appended to it. */
  url: string;
  /** Root-relative routes, e.g. `["/", "/pricing"]`. */
  routes: string[];
  viewports: Viewport[];
  /** Capture the dark-mode variant as well. */
  darkMode?: boolean;
  /**
   * Fork-safe capture: no storage state and no protection-bypass secret is
   * released. Local runs capture in this process and hold no such secrets, so
   * the default is `false`; a server carrying a tenant's secrets sets it.
   */
  isFork?: boolean;
  /** Tenant label recorded on the capture context. */
  installationId: string;
  depth: "triage" | "deep";
  /** Resolved design context (tokens, brand, component libraries, routes). */
  context: ContextBlockInput;
  /** Build/runtime facts from a preview supervisor, threaded into the deep prompt. */
  previewBuildFacts?: PreviewBuildFact[];
  /** Not-reviewed reasons decided before the review ran; carried through verbatim. */
  notReviewed?: string[];
  /**
   * The routes the CONFIG asked for, when the caller narrowed `routes` before
   * capture (today: the `routes.max_per_pr` cap). Absent means `routes` IS the
   * ask, which is true of every caller that narrows nothing.
   */
  requestedRoutes?: string[];
  /** Capture each page twice and compare the bytes. */
  verifyStability?: boolean;
  /** Retention advertised on the wire result. Local runs keep files until deleted. */
  screenshotRetentionSeconds?: number;
  /** Object-key prefix for screenshots (default `screenshots`). */
  keyPrefix?: string;
}

export interface LocalReviewDeps {
  browser: CaptureBrowser;
  /** Where PNG bytes land. `FileScreenshotSink` writes them to a directory. */
  sink: ScreenshotSink;
  modelFactory: ModelClientFactory;
  /** Maps a screenshot object key to the URL the wire result should carry. */
  artifactUrlFor?: (key: string) => string;
  /** Cooperative cancellation, threaded into every model call. */
  signal?: AbortSignal;
}

export interface LocalReviewOutcome {
  /** The wire result, exactly as the job API and `review.json` carry it. */
  result: EngineReviewResult;
  /**
   * The internal critique: the rich form the wire result is projected from,
   * carrying the fields the projection drops (`introducedByThisPr`, the raw
   * per-finding confidence). Null only if the orchestrator never assembled one.
   */
  critique: Critique | null;
  capture: BrowserCaptureResult;
  systemPrompt: string;
  /** Findings deleted for citing a route or element the capture never produced. */
  hallucinationDrops: number;
  /** Findings the model or the replay script emitted before the gate ran. */
  modelFindingsSeen: number;
}

/** Run one local review end to end. */
export async function runLocalReview(
  request: LocalReviewRequest,
  deps: LocalReviewDeps,
): Promise<LocalReviewOutcome> {
  const systemPrompt = reviewSystemPrompt(request.context);
  const capture = createBrowserCapture(
    { browser: deps.browser, sink: deps.sink, keyPrefix: request.keyPrefix ?? "screenshots" },
    { verifyStability: request.verifyStability === true },
  );

  const captureContext: CaptureContext = {
    installationId: request.installationId,
    viewports: request.viewports,
    darkMode: request.darkMode ?? false,
    isFork: request.isFork ?? false,
    routes: request.routes,
  };

  const captured = (await capture(request.url, captureContext)) as BrowserCaptureResult;

  // The deterministic facts are measured DURING capture, so the per-route inputs
  // the deep prompt is grounded on can only be assembled here, after it ran.
  //
  // `deterministicBreakage` is the subset of those measurements that means the
  // page came apart, and it is threaded through separately because it does a
  // different job: the deep prompt reads `facts`, but TRIAGE reads breakage, and
  // a route with measured breakage gets a deep review whatever the cheap model
  // answered. This field existed and was never populated on either shipped
  // surface, so until now the only thing that could force a deep review was the
  // triage model agreeing to one; a measured overflow the model failed to notice
  // was carried to the deep prompt on the routes that happened to be reviewed
  // and dropped entirely on the routes that were not.
  //
  // What is still NOT populated here, deliberately: `baselinePhash` and
  // `tileScores`. Both describe THIS capture against a PREVIOUS one, and a local
  // run has no previous one: nothing in this process, and nothing on disk that
  // it owns, records a per-(repo, route, viewport) hash or tile score from an
  // earlier run. Inventing a value would be worse than leaving it absent, since
  // the triage gate treats a confirmed match as grounds to skip the review
  // entirely. The consequences of the gap are exact and are documented on
  // `ReviewRoute`: the pHash + tile-diff short-circuit is unreachable on both
  // shipped surfaces, so every local run pays for a triage model call it could
  // sometimes have skipped, and when triage declines a deep review the run has
  // no baseline to have declined against, which is why the orchestrator marks
  // those routes not-reviewed instead of clean. Closing it needs a baseline
  // store keyed by repo and route with a retention and invalidation policy,
  // which is a feature, not a wiring fix.
  const routes: ReviewRoute[] = request.routes.map((route) => {
    const facts = factsForRoute(captured.deterministicFindings, route);
    const breakage = breakageForRoute(captured.deterministicFindings, route);
    const text = captured.pageText[route];
    return {
      route,
      ...(facts.length > 0 ? { facts } : {}),
      ...(breakage.length > 0 ? { deterministicBreakage: breakage } : {}),
      ...(text ? { pageText: text } : {}),
    };
  });

  let critique: Critique | null = null;
  const result = await runReview(
    {
      url: request.url,
      depth: request.depth,
      context: request.context,
      captureContext,
      routes,
      ...(request.previewBuildFacts ? { previewBuildFacts: request.previewBuildFacts } : {}),
      ...(request.notReviewed ? { notReviewed: request.notReviewed } : {}),
      ...(request.requestedRoutes ? { requestedRoutes: request.requestedRoutes } : {}),
      wireOptions: {
        screenshotRetentionSeconds: request.screenshotRetentionSeconds ?? 0,
        screenshotIdFor: (finding) =>
          captured.images.find(
            (image) => image.route === finding.route && image.viewport === finding.viewport,
          )?.objectKey ?? null,
        ...(deps.artifactUrlFor ? { artifactUrlFor: deps.artifactUrlFor } : {}),
      },
    },
    {
      // The capture already ran, so the seam hands the orchestrator the result
      // it produced rather than capturing a second time.
      captureInSandbox: async () => captured,
      modelFactory: deps.modelFactory,
      ...(deps.signal ? { signal: deps.signal } : {}),
      onCritique: (value) => {
        critique = value;
      },
    },
  );

  const assembled = critique as Critique | null;
  const hallucinationDrops = assembled?.validation.hallucinationDrops ?? 0;
  return {
    result,
    critique: assembled,
    capture: captured,
    systemPrompt,
    hallucinationDrops,
    modelFindingsSeen: (assembled?.findings.length ?? 0) + hallucinationDrops,
  };
}

export interface WrittenArtifacts {
  /** Absolute paths, in report order. */
  paths: string[];
  /** The measured-fact file, which the report points at by name. */
  factsPath: string;
  /** The wire result, which the HTTP server serves back as the job result. */
  reviewPath: string;
  /** The DOM geometry map every `elementRef` was validated against. */
  geometryPath: string;
  /** The rubric that was actually sent. */
  promptPath: string;
}

/**
 * The measured-fact file's body.
 *
 * An empty file is the correct output for a clean page and an indistinguishable
 * output from "the checks never ran", which is the wrong thing for the one
 * artifact the honesty story rests on: these facts are the part of a review that
 * is true with no model involved, and a reader has to be able to see that they
 * were computed. So a clean page says so in words instead of saying nothing.
 */
export function renderDeterministicFacts(findings: DeterministicFinding[]): string {
  if (findings.length === 0) {
    return "0 issues found (contrast, overflow and touch-target checks ran and measured no violation)\n";
  }
  return `${findings
    .map(
      (finding) =>
        `[${finding.kind}] ${finding.route} ${finding.viewport} ${finding.selector}: ${finding.detail}`,
    )
    .join("\n")}\n`;
}

/**
 * Write a review's artifacts into a directory. The same four files, in the same
 * format, whichever front door ran the review, so an HTTP job leaves behind
 * exactly what `pnpm review` leaves behind.
 */
export async function writeReviewArtifacts(
  outDir: string,
  outcome: Pick<LocalReviewOutcome, "result" | "systemPrompt" | "capture">,
): Promise<WrittenArtifacts> {
  await mkdir(outDir, { recursive: true });
  const reviewPath = join(outDir, "review.json");
  const promptPath = join(outDir, "system-prompt.txt");
  const geometryPath = join(outDir, "geometry.json");
  const factsPath = join(outDir, "deterministic-facts.txt");

  await writeFile(reviewPath, `${JSON.stringify(outcome.result, null, 2)}\n`);
  await writeFile(promptPath, `${outcome.systemPrompt}\n`);
  await writeFile(geometryPath, `${JSON.stringify(outcome.capture.geometry, null, 2)}\n`);
  await writeFile(factsPath, renderDeterministicFacts(outcome.capture.deterministicFindings));

  return {
    paths: [reviewPath, promptPath, geometryPath, factsPath],
    factsPath,
    reviewPath,
    geometryPath,
    promptPath,
  };
}
