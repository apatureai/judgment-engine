#!/usr/bin/env node
/**
 * Render a captured terminal transcript to a PNG, for the image in README.md.
 *
 * It takes a file of text and typesets it; it never invents output. The point of
 * the README image is that a reader sees what the tool really prints, so the
 * input file must be real stdout:
 *
 *   pnpm review > docs/report.txt 2>&1
 *   node scripts/render-report-image.mjs docs/report.txt docs/report.png
 *
 * Chromium comes from `pnpm browser:install`, the same binary the capture uses.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  console.error("usage: node scripts/render-report-image.mjs <transcript.txt> <out.png>");
  process.exit(2);
}

const require = createRequire(new URL("../packages/capture/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const text = await readFile(resolve(inputArg), "utf8");
const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #0d1117; }
  main { display: inline-block; padding: 28px 34px 30px; }
  pre {
    margin: 0;
    font: 13px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: #d7dde5;
    white-space: pre;
    tab-size: 2;
  }
</style>
<main><pre>${escaped}</pre></main>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: "load" });
// A string expression, so this file needs no browser globals of its own.
await page.evaluate("document.fonts.ready");
const element = await page.$("main");
if (element === null) throw new Error("the transcript pane did not render");
await element.screenshot({ path: resolve(outputArg) });
await browser.close();

console.log(`wrote ${outputArg} from ${inputArg}`);
