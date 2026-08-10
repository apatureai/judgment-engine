import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBrowserCapture,
  factsForRoute,
  pageHealthFootnote,
  type BrowserCaptureResult,
  type CaptureBrowser,
} from "@engine/capture";
import {
  cannedModelFactory,
  defaultModelFactory,
  parseCannedScript,
  resolveModelRuntime,
  type ModelClientFactory,
} from "@engine/critique";
import { reviewSystemPrompt, runReview, type ReviewRoute } from "@engine/review";
import type { Critique, EngineReviewResult, Viewport } from "@engine/types";
import type { CliOptions } from "./args.js";
import { FileScreenshotSink } from "./file-sink.js";
import { loadRepoContext } from "./repo-context.js";
import { displayPath, renderSummary, type ReportModelKind, type RunSummary } from "./report.js";
import { serveDirectory, type StaticSite } from "./static-server.js";

/**
 * The CLI's one job: capture a rendered UI with a real browser, ground a
 * critique against the repository's own design context, run the engine's
 * validation tail over the result, and write the artifacts out.
 *
 * With no `--url` it serves the bundled demo site itself, so the whole thing runs
 * with no credentials, no external service and no network access.
 */

/** Directory holding the bundled demo site and canned script. */
export function fixturesDir(): string {
  return fileURLToPath(new URL("../fixtures/", import.meta.url));
}

/** Render a path relative to the working directory when that stays readable. */
function show(path: string): string {
  return displayPath(path, relative(process.cwd(), path));
}

export interface RunIo {
  log(line: string): void;
  error(line: string): void;
  env: Record<string, string | undefined>;
  /** Injected so tests never launch a browser. */
  launchBrowser(): Promise<CaptureBrowser>;
}

interface ResolvedModel {
  factory: ModelClientFactory;
  description: string;
  /** Reported so the terminal report can refuse to print a grade nothing earned. */
  kind: ReportModelKind;
}

async function resolveModel(
  options: CliOptions,
  io: RunIo,
  sink: FileScreenshotSink,
): Promise<ResolvedModel> {
  const keyPresent = (io.env.MODEL_API_KEY ?? "").trim().length > 0;
  const choice = options.model === "auto" ? (keyPresent ? "live" : "canned") : options.model;

  if (choice === "live") {
    // A live model fetches the images itself; locally there is no signed
    // object-store URL to hand it, so the captured bytes are inlined.
    const runtime = resolveModelRuntime(io.env, {
      resolveImageUrl: (image) => sink.dataUriFor(image.objectKey),
    });
    return { factory: runtime.factory, description: runtime.description, kind: "live" };
  }
  if (choice === "mock") {
    return {
      factory: defaultModelFactory,
      description: "MOCK model client — deterministic, empty critique. No network call.",
      kind: "mock",
    };
  }
  const scriptPath = options.script ?? join(fixturesDir(), "canned-critique.json");
  const parsed = parseCannedScript(JSON.parse(await readFile(scriptPath, "utf8")));
  if (!parsed.ok) throw new Error(`invalid canned script ${scriptPath}: ${parsed.error}`);
  return {
    factory: cannedModelFactory(parsed.script),
    description: `CANNED replay client — authored responses, not a live model (${show(scriptPath)})`,
    kind: "canned",
  };
}

/** Count the findings a script/model produced before the grounding gate ran. */
function findingsSeen(critique: Critique | null, drops: number): number {
  return (critique?.findings.length ?? 0) + drops;
}

export async function runCli(options: CliOptions, io: RunIo): Promise<number> {
  const started = Date.now();
  let site: StaticSite | null = null;
  let browser: CaptureBrowser | null = null;

  try {
    let baseUrl = options.url;
    let targetNote = "";
    const demoRoot = join(fixturesDir(), "demo-site");
    if (baseUrl === undefined) {
      site = await serveDirectory(demoRoot);
      baseUrl = site.baseUrl;
      targetNote = "(bundled demo site)";
    }

    const contextDir = options.contextDir ?? demoRoot;
    const loaded = await loadRepoContext(contextDir, options.routes);
    const systemPrompt = reviewSystemPrompt(loaded.context);

    const outDir = resolve(options.outDir);
    await mkdir(outDir, { recursive: true });
    const sink = new FileScreenshotSink(outDir);
    const model = await resolveModel(options, io, sink);

    io.log(`judgment-engine — reviewing ${baseUrl} ${targetNote}`.trimEnd());
    io.log(`  ${model.description}`);
    io.log("  launching Chromium…");
    browser = await io.launchBrowser();

    const capture = createBrowserCapture(
      { browser, sink, keyPrefix: "screenshots" },
      { verifyStability: options.verifyStability },
    );

    io.log(`  capturing ${options.routes.length} route(s) × ${options.viewports.length} viewport(s)…`);
    const captured = (await capture(baseUrl, {
      installationId: "local",
      viewports: options.viewports as Viewport[],
      darkMode: false,
      isFork: false,
      routes: options.routes,
    })) as BrowserCaptureResult;

    const routes: ReviewRoute[] = options.routes.map((route) => {
      const facts = factsForRoute(captured.deterministicFindings, route);
      const text = captured.pageText[route];
      return {
        route,
        ...(facts.length > 0 ? { facts } : {}),
        ...(text ? { pageText: text } : {}),
      };
    });

    let critique: Critique | null = null;
    io.log("  running triage + deep pass…");
    const result: EngineReviewResult = await runReview(
      {
        url: baseUrl,
        depth: "deep",
        context: loaded.context,
        captureContext: {
          installationId: "local",
          viewports: options.viewports as Viewport[],
          darkMode: false,
          isFork: false,
          routes: options.routes,
        },
        routes,
        wireOptions: {
          screenshotRetentionSeconds: 0,
          screenshotIdFor: (finding) =>
            captured.images.find((image) => image.route === finding.route && image.viewport === finding.viewport)
              ?.objectKey ?? null,
          artifactUrlFor: (key) => sink.urlFor(key),
        },
      },
      {
        // The capture already ran, so the seam hands the orchestrator the result
        // it produced rather than capturing a second time.
        captureInSandbox: async () => captured,
        modelFactory: model.factory,
        onCritique: (value) => {
          critique = value;
        },
      },
    );

    const drops = (critique as Critique | null)?.validation.hallucinationDrops ?? 0;
    const written = await writeArtifacts(outDir, {
      result,
      systemPrompt,
      capture: captured,
    });
    const files = written.paths.map(show);

    io.log(
      renderSummary({
        target: baseUrl,
        targetNote,
        routes: options.routes,
        viewports: options.viewports,
        modelKind: model.kind,
        modelDescription: model.description,
        captureVersion: captured.captureVersion,
        screenshotCount: captured.images.length,
        screenshotDir: show(join(outDir, "screenshots")),
        geometryCount: captured.geometry.length,
        deterministicFindings: captured.deterministicFindings,
        factsFile: show(written.factsPath),
        pageHealthFootnote: pageHealthFootnote(captured.pageHealth),
        stability: captured.stability,
        hallucinationDrops: drops,
        modelFindingsSeen: findingsSeen(critique as Critique | null, drops),
        result,
        files,
        elapsedMs: Date.now() - started,
      } satisfies RunSummary),
    );
    return 0;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (site) await site.close().catch(() => undefined);
  }
}

interface Artifacts {
  result: EngineReviewResult;
  systemPrompt: string;
  capture: BrowserCaptureResult;
}

interface WrittenArtifacts {
  /** Absolute paths, in report order. */
  paths: string[];
  /** The measured-fact file, which the report points at by name. */
  factsPath: string;
}

/** Write the run's artifacts and return where they landed. */
async function writeArtifacts(outDir: string, artifacts: Artifacts): Promise<WrittenArtifacts> {
  const reviewPath = join(outDir, "review.json");
  const promptPath = join(outDir, "system-prompt.txt");
  const geometryPath = join(outDir, "geometry.json");
  const factsPath = join(outDir, "deterministic-facts.txt");

  await writeFile(reviewPath, `${JSON.stringify(artifacts.result, null, 2)}\n`);
  await writeFile(promptPath, `${artifacts.systemPrompt}\n`);
  await writeFile(geometryPath, `${JSON.stringify(artifacts.capture.geometry, null, 2)}\n`);
  await writeFile(
    factsPath,
    `${artifacts.capture.deterministicFindings
      .map((finding) => `[${finding.kind}] ${finding.route} ${finding.viewport} ${finding.selector}: ${finding.detail}`)
      .join("\n")}\n`,
  );

  return { paths: [reviewPath, promptPath, geometryPath, factsPath], factsPath };
}
