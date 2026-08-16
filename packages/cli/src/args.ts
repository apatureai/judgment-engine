/**
 * Argument parsing for the `judgment-engine` CLI. Pure: it never touches the
 * filesystem, the network or `process`, so every flag combination is unit-tested.
 */

export type ModelChoice = "auto" | "mock" | "canned" | "live";

export interface CliOptions {
  /** Base URL to review. Absent ⇒ serve and review the bundled demo site. */
  url?: string;
  /** Routes to capture, relative to the base URL. */
  routes: string[];
  /** Viewports to capture. */
  viewports: Array<"mobile" | "tablet" | "desktop">;
  /** Output directory for screenshots, review JSON and the resolved prompt. */
  outDir: string;
  /** Directory holding tokens.json / .designreview.yml / package.json. */
  contextDir?: string;
  /** Canned model script; defaults to the bundled one in demo mode. */
  script?: string;
  model: ModelChoice;
  /** Capture each page twice and compare bytes (determinism check). */
  verifyStability: boolean;
  /** Print help and exit. */
  help: boolean;
}

const VIEWPORTS = new Set(["mobile", "tablet", "desktop"]);

export const DEFAULT_OPTIONS: CliOptions = {
  routes: ["/", "/pricing"],
  viewports: ["mobile", "tablet", "desktop"],
  outDir: "out",
  model: "auto",
  verifyStability: false,
  help: false,
};

export class ArgError extends Error {}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new ArgError(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { ...DEFAULT_OPTIONS, routes: [...DEFAULT_OPTIONS.routes], viewports: [...DEFAULT_OPTIONS.viewports] };
  let routesSet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = argv[i + 1];
    switch (arg) {
      // `pnpm run <script> -- --flag` forwards the separator literally.
      case "--":
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--url":
        options.url = requireValue("--url", next);
        i += 1;
        if (!routesSet) options.routes = ["/"];
        break;
      case "--routes": {
        const routes = splitList(requireValue("--routes", next));
        if (routes.length === 0) throw new ArgError("--routes needs at least one route");
        options.routes = routes;
        routesSet = true;
        i += 1;
        break;
      }
      case "--viewports": {
        const viewports = splitList(requireValue("--viewports", next));
        for (const viewport of viewports) {
          if (!VIEWPORTS.has(viewport)) {
            throw new ArgError(`unknown viewport "${viewport}" (expected mobile, tablet or desktop)`);
          }
        }
        if (viewports.length === 0) throw new ArgError("--viewports needs at least one viewport");
        options.viewports = viewports as CliOptions["viewports"];
        i += 1;
        break;
      }
      case "--out":
        options.outDir = requireValue("--out", next);
        i += 1;
        break;
      case "--context-dir":
        options.contextDir = requireValue("--context-dir", next);
        i += 1;
        break;
      case "--script":
        options.script = requireValue("--script", next);
        i += 1;
        break;
      case "--model": {
        const model = requireValue("--model", next);
        if (model !== "auto" && model !== "mock" && model !== "canned" && model !== "live") {
          throw new ArgError(`unknown --model "${model}" (expected auto, mock, canned or live)`);
        }
        options.model = model;
        i += 1;
        break;
      }
      case "--verify-stability":
        options.verifyStability = true;
        break;
      default:
        throw new ArgError(`unknown argument "${arg}"`);
    }
  }

  return options;
}

export const USAGE = `judgment-engine — run a grounded design review over a rendered web UI.

Usage:
  judgment-engine [options]

With no --url, the bundled demo site is served on a local port and reviewed.
That path needs no credentials and no network access.

Options:
  --url <base>            Base URL to review (default: the bundled demo site)
  --routes <a,b>          Routes to capture (default: / and /pricing)
  --viewports <a,b>       mobile, tablet, desktop (default: all three)
  --out <dir>             Output directory (default: out)
  --context-dir <dir>     Directory holding tokens.json, .designreview.yml,
                          package.json and ui-dna.json (default: the demo site
                          directory). ui-dna.json is a UI-DNA snapshot exported
                          from the Source of Truth, and it is what the critique
                          is grounded against; with none, the review states in
                          its own notReviewed that no design-system rule
                          grounded it.
  --script <file.json>    Canned model script for the offline path
  --model <choice>        auto | mock | canned | live (default: auto)
                            auto   live if MODEL_API_KEY is set, else canned
                            mock   deterministic empty critique, no network
                            canned replay a scripted critique from --script
                            live   MODEL_BASE_URL + MODEL_API_KEY, real calls
  --verify-stability      Capture each page twice and compare the bytes, and
                          report how many pages were byte-identical
  -h, --help              Show this message

Requires a Chromium binary. From the repository root:
  pnpm browser:install
`;
