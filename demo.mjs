#!/usr/bin/env node
/**
 * `node demo.mjs`: one command, from a clean clone to a real design review.
 *
 * It installs the workspace, builds it, makes sure a Chromium is present, then
 * serves the bundled demo site on a local port and reviews it with the same CLI
 * the README documents. It needs Node 24 and nothing else: no key, no account,
 * no service to point at, no network beyond the two downloads (packages, and
 * Chromium once). Everything it prints about the page comes from a browser that
 * rendered that page a second earlier.
 *
 * This file is deliberately plain, dependency-free JavaScript. It has to run
 * before `pnpm install` has ever run, so it cannot import anything from the
 * workspace, and it has to survive being started by a Node too old to run the
 * engine, so the version check happens before anything else. The pure helpers
 * are exported for `packages/cli/test/demo-script.test.ts`; the script runs
 * itself only when it is the process entry point.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_NODE_MAJOR = 24;

/** Major version number out of `v24.14.0`, or null if it does not look like one. */
export function parseNodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version).trim());
  return match === null ? null : Number(match[1]);
}

/**
 * The reason this Node cannot run the demo, or null if it can. Returned as text
 * rather than thrown: an unusable Node is a thing to explain, not a stack trace.
 */
export function nodeVersionProblem(version, required = REQUIRED_NODE_MAJOR) {
  const major = parseNodeMajor(version);
  if (major === null) {
    return `Could not read a version number from Node "${version}". This demo needs Node ${required} or newer.`;
  }
  if (major < required) {
    return (
      `Node ${version} is too old: the engine needs Node ${required} or newer (see .node-version).\n` +
      `Install it with nvm (\`nvm install ${required}\`), fnm, or from https://nodejs.org, then run this again.`
    );
  }
  return null;
}

/**
 * Where the review artifacts will land. Only `--out <dir>` is recognised, which
 * is exactly the spelling the CLI accepts, so this cannot claim to honour a
 * flag the run itself would reject.
 */
export function outDirFrom(argv, fallback = "out") {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" && argv[i + 1] !== undefined) return argv[i + 1];
  }
  return fallback;
}

export function stepLine(index, total, title) {
  return `[${index}/${total}] ${title}`;
}

/** Human-readable file size. Whole KB and one decimal MB keep the column narrow. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Align an artifact listing into path / size / description columns. Entries the
 * run did not produce are dropped by the caller rather than printed with a
 * guessed size, so this never names a file that is not on disk.
 */
export function artifactLines(entries) {
  const pathWidth = Math.max(0, ...entries.map((entry) => entry.path.length));
  const sizeWidth = Math.max(0, ...entries.map((entry) => entry.size.length));
  return entries.map(
    (entry) =>
      `  ${entry.path.padEnd(pathWidth)}  ${entry.size.padStart(sizeWidth)}  ${entry.note}`.trimEnd(),
  );
}

/** Every file under `dir`, relative to `dir`, sorted. A missing dir gives []. */
export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const full = join(entry.parentPath ?? entry.path ?? dir, entry.name);
    if (statSync(full).isFile()) found.push(relative(dir, full).split(sep).join("/"));
  }
  return found.sort();
}

/**
 * The subset of an output directory this review writes: its top-level documents
 * and the screenshots. `--out` may point at a directory that already holds
 * something else (the local job server writes under `serve/`), and listing a
 * file this run did not produce would be a small lie in the one place the reader
 * is being told what they now hold.
 */
export function selectRunArtifacts(files) {
  return {
    screenshots: files.filter((file) => file.startsWith("screenshots/") && file.endsWith(".png")),
    documents: files.filter(
      (file) => !file.includes("/") && (file.endsWith(".txt") || file.endsWith(".json")),
    ),
  };
}

/** The platform's "open this file" command, or null when there isn't an obvious one. */
export function openCommand(platform) {
  if (platform === "darwin") return "open";
  if (platform === "linux") return "xdg-open";
  if (platform === "win32") return "start";
  return null;
}

const STEP_TITLES = [
  "Checking prerequisites",
  "Installing dependencies",
  "Building the workspace",
  "Checking for a Chromium to drive",
  "Capturing and reviewing the demo site",
];

/** Run a command, streaming its output, and optionally keeping a copy of stdout. */
function run(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["inherit", options.capture ? "pipe" : "inherit", "inherit"],
    });
    const chunks = [];
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        chunks.push(chunk);
        process.stdout.write(chunk);
      });
    }
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

/** True if `command --version` exits 0, i.e. the tool is on PATH and usable. */
function canRun(command, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, ["--version"], { stdio: "ignore", env });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });
}

async function main(argv) {
  const started = Date.now();
  const problem = nodeVersionProblem(process.version);
  if (problem !== null) {
    console.error(problem);
    return 1;
  }

  const root = dirname(fileURLToPath(import.meta.url));
  const total = STEP_TITLES.length;
  // Corepack ships with Node, so the pinned pnpm needs no separate install. The
  // prompt it would otherwise print blocks a run nobody is watching.
  const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

  console.log("judgment-engine demo: capture a real page with a real browser, then review it.");
  console.log("No API key, no account, no service to point at. Ctrl-C is safe at any point.\n");

  console.log(stepLine(1, total, STEP_TITLES[0]));
  const corepack = await canRun("corepack", env);
  const pnpm = corepack ? null : (await canRun("pnpm", env)) ? "pnpm" : null;
  if (!corepack && pnpm === null) {
    console.error(
      "Neither corepack nor pnpm is available. corepack ships with Node 24; if it was removed,\n" +
        "install pnpm 9.15.0 (`npm i -g pnpm@9.15.0`) and run this again.",
    );
    return 1;
  }
  const [command, prefix] = corepack ? ["corepack", ["pnpm"]] : [pnpm, []];
  console.log(`      Node ${process.version} on ${process.platform}/${process.arch}`);
  console.log(`      pnpm via ${corepack ? "corepack (pinned by packageManager)" : "pnpm on PATH"}\n`);

  const steps = [
    { args: ["install", "--frozen-lockfile"], note: "", hint: "" },
    { args: ["build"], note: "", hint: "" },
    {
      args: ["browser:install"],
      note: "first run downloads about 275 MB of Chromium",
      // A bare Linux image has the browser but not the shared libraries it links
      // against, and the failure reads as a launch failure rather than a missing
      // package. Installing those libraries needs root, which this does not have.
      hint:
        process.platform === "linux"
          ? "On a bare Linux image the system libraries Chromium links against are missing.\n" +
            "Install them once, with root: sudo env \"PATH=$PATH\" corepack pnpm browser:install --with-deps"
          : "",
    },
  ];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    console.log(stepLine(i + 2, total, STEP_TITLES[i + 1]) + (step.note ? ` (${step.note})` : ""));
    const result = await run(command, [...prefix, ...step.args], { cwd: root, env, capture: false });
    if (result.code !== 0) {
      console.error(`\nStep ${i + 2} failed (exit ${result.code}): ${STEP_TITLES[i + 1].toLowerCase()}.`);
      if (step.hint) console.error(step.hint);
      return result.code;
    }
    console.log("");
  }

  console.log(stepLine(total, total, STEP_TITLES[total - 1]) + "\n");
  const outDir = resolve(root, outDirFrom(argv));
  const review = await run(
    process.execPath,
    [join(root, "packages", "cli", "dist", "main.js"), ...argv],
    { cwd: root, env, capture: true },
  );
  if (review.code !== 0) {
    console.error(`\nThe review failed (exit ${review.code}).`);
    return review.code;
  }

  // The terminal output is the most legible artifact of the run and the only one
  // that scrolls away, so it is written next to the ones it describes.
  const transcriptPath = join(outDir, "report.txt");
  if (existsSync(outDir)) writeFileSync(transcriptPath, review.stdout);

  const notes = {
    "deterministic-facts.txt": "every measured fact, one per line",
    "review.json": "the engine's wire result, with its provenance block",
    "system-prompt.txt": "the rubric that was actually sent",
    "geometry.json": "every element the capture can point at",
    "report.txt": "the run above, verbatim",
  };
  // Only files this run wrote. An older run's leftovers under the same --out
  // directory are not this run's evidence, so they are not listed as it.
  const written = (file) => statSync(join(outDir, file)).mtimeMs >= started;
  const { screenshots, documents } = selectRunArtifacts(listFiles(outDir));
  const shots = screenshots.filter(written);
  const show = (file) => relative(root, join(outDir, file)).split(sep).join("/");
  const entries = documents.filter(written).map((file) => ({
    path: show(file),
    size: formatBytes(statSync(join(outDir, file)).size),
    note: notes[file] ?? "",
  }));
  const showcase = shots.find((file) => file.includes("desktop")) ?? shots[0];
  if (showcase !== undefined) {
    entries.unshift({
      path: show(showcase),
      size: formatBytes(statSync(join(outDir, showcase)).size),
      note: `the page the measurements came from (${shots.length} screenshot(s) in all)`,
    });
  }

  console.log("Artifacts you can open, all produced by the run above:\n");
  console.log(artifactLines(entries).join("\n"));
  const opener = openCommand(process.platform);
  if (opener !== null && showcase !== undefined) console.log(`\n  ${opener} ${show(showcase)}`);
  console.log(
    "\nNo model saw this page, so there is no grade above and the report says so instead of\n" +
      "inventing one. The capture, the geometry map, the measured facts and the grounding gate\n" +
      "are all real. To turn the critique half on, point it at any OpenAI-compatible endpoint\n" +
      "that accepts images:\n\n" +
      "  export MODEL_BASE_URL=https://your-endpoint/v1 MODEL_API_KEY=your-key\n" +
      "  node packages/cli/dist/main.js --model live\n\n" +
      "To review your own site instead of the demo:\n\n" +
      "  node packages/cli/dist/main.js --url https://your-preview-deploy --routes /,/pricing\n",
  );
  console.log(`Demo finished in ${Math.round((Date.now() - started) / 1000)}s.`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
