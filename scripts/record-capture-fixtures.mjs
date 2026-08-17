#!/usr/bin/env node
/**
 * Record the DOM extractor's output for the pages in
 * `packages/capture/fixtures/pages`, and print what the deterministic checks
 * make of each one.
 *
 * The checks in `packages/capture/src/checks.ts` are pure, so they are unit
 * tested without a browser. That is a good property and it has one blind spot:
 * a unit test asserts what the check does with a hand-written `overflow-x`, not
 * what Chromium actually computes for a `<pre>` with a scrollbar. Every
 * false-positive class this engine has shipped came from that gap.
 *
 * So the fixture pages are real HTML, this script renders them in the same
 * Chromium the capture uses, and the recorded payloads are checked in and
 * replayed by `packages/capture/test/real-pages.test.ts`. The test needs no
 * browser; the recording did.
 *
 *   pnpm browser:install                       # once
 *   node scripts/record-capture-fixtures.mjs   # rewrites the recorded payloads
 *
 * Pass `--print` to also dump the findings each page produces, which is how the
 * before/after of a checks change is read.
 */
import { readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const require = createRequire(new URL("../packages/capture/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const capture = await import(
  pathToFileURL(fileURLToPath(new URL("../packages/capture/dist/index.js", import.meta.url))).href
);
const {
  DOM_EXTRACT_EXPRESSION,
  VIEWPORT_SIZES,
  DEVICE_SCALE_FACTOR,
  deterministicChecks,
  toInteractiveElements,
  toTextNodeStyles,
} = capture;

const pagesDir = fileURLToPath(new URL("../packages/capture/fixtures/pages", import.meta.url));
const outDir = fileURLToPath(new URL("../packages/capture/fixtures/extracted", import.meta.url));
const print = process.argv.includes("--print");

const files = (await readdir(pagesDir)).filter((f) => f.endsWith(".html")).sort();
const browser = await chromium.launch();
try {
  for (const file of files) {
    const route = `/${file.replace(/\.html$/, "")}`;
    for (const viewport of ["mobile", "desktop"]) {
      const context = await browser.newContext({
        viewport: VIEWPORT_SIZES[viewport],
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        colorScheme: "light",
      });
      const page = await context.newPage();
      await page.goto(pathToFileURL(join(pagesDir, file)).href, { waitUntil: "load" });
      await page.evaluate("document.fonts.ready");
      const extracted = await page.evaluate(DOM_EXTRACT_EXPRESSION);
      const name = `${file.replace(/\.html$/, "")}.${viewport}.json`;
      await writeFile(join(outDir, name), `${JSON.stringify(extracted, null, 2)}\n`, "utf8");

      if (print) {
        const findings = deterministicChecks({
          textNodes: toTextNodeStyles(extracted, route, viewport),
          interactive: toInteractiveElements(extracted, route, viewport),
        });
        console.log(`\n${route} @ ${viewport}: ${findings.length} finding(s)`);
        for (const f of findings) {
          const gate = f.blockEligible === true ? "blocking" : "advisory";
          console.log(`  [${f.kind}] ${f.selector}: ${f.detail} (${gate})`);
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
