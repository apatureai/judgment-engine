#!/usr/bin/env node
/**
 * The DOM extractor against a REAL Chromium.
 *
 * `packages/capture/test/*` drives a fake browser, which is the right default,
 * because no test may launch a browser. But that leaves one seam untested: what Chromium
 * actually returns from `getComputedStyle`, and therefore whether the
 * deterministic contrast fact published for a page is true. A page that never
 * declares a background reports `rgba(0, 0, 0, 0)` for every ancestor, and
 * reading that as opaque black once made black-on-white text measure 1.00:1,
 * a fabricated "measurement" fed straight into the model prompt.
 *
 * So this runs the real extractor expression against real pages and asserts the
 * facts. It needs a Chromium binary (`pnpm browser:install`) and runs in the
 * `quickstart` CI job, next to the other browser-backed check.
 *
 * Usage: node scripts/ci/extractor-smoke.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  DOM_EXTRACT_EXPRESSION,
  deterministicChecks,
  toInteractiveElements,
  toTextNodeStyles,
} from "../../packages/capture/dist/index.js";

const require = createRequire(new URL("../../packages/capture/package.json", import.meta.url));
const { chromium } = require("playwright-core");

/** Each case: a page, and the contrast facts it must (and must not) produce. */
const CASES = [
  {
    name: "black text on the browser's default canvas",
    html: `<h1 style="font-size:32px">Northwind</h1>`,
    // 21:1. The regression case: this used to be reported as 1.00:1.
    expectContrast: [],
  },
  {
    name: "grey text on an explicit white background",
    html: `<body style="background:#fff"><p style="color:#999">Faint copy</p></body>`,
    expectContrast: ["text contrast 2.85:1 is below WCAG AA 4.5:1"],
  },
  {
    name: "translucent text composited onto the default canvas",
    html: `<p style="color:rgba(0,0,0,0.45)">Faded copy</p>`,
    // rgba(0,0,0,.45) over white renders as rgb(140,140,140).
    expectContrast: ["text contrast 3.36:1 is below WCAG AA 4.5:1"],
  },
  {
    name: "translucent overlay over the default canvas",
    // A 50%-black panel renders mid-grey; black text on it clears AA at 5.32:1.
    html: `<div style="background:rgba(0,0,0,0.5)"><p style="color:#000">On a panel</p></div>`,
    expectContrast: [],
  },
  {
    name: "page that opted into a dark color-scheme",
    // The dark UA canvas shade is an implementation detail, so the backdrop is
    // unknown and the check must stay silent rather than guess.
    html: `<style>:root{color-scheme:dark}</style><p style="color:#fff">Dark mode copy</p>`,
    expectContrast: [],
  },
  {
    name: "background in a color space the extractor does not parse",
    html: `<div style="background:oklch(0.7 0.1 200)"><p style="color:#8a8a8a">Wide gamut</p></div>`,
    expectContrast: [],
  },
];

function fail(message) {
  console.error(`extractor-smoke: ${message}`);
  process.exitCode = 1;
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ colorScheme: "light" });
  for (const testCase of CASES) {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><meta charset="utf-8">${testCase.html}`);
    const extracted = await page.evaluate(DOM_EXTRACT_EXPRESSION);
    await page.close();

    const facts = deterministicChecks({
      textNodes: toTextNodeStyles(extracted, "/", "desktop"),
      interactive: toInteractiveElements(extracted, "/", "desktop"),
    });
    const contrast = facts.filter((fact) => fact.kind === "contrast").map((fact) => fact.detail);
    const expected = JSON.stringify(testCase.expectContrast);
    const actual = JSON.stringify(contrast);
    if (actual !== expected) {
      fail(`${testCase.name}\n  expected contrast facts ${expected}\n  got                    ${actual}`);
    } else {
      console.log(`ok — ${testCase.name}${contrast.length > 0 ? ` (${contrast.join("; ")})` : " (silent)"}`);
    }
  }
  await context.close();
} finally {
  await browser.close();
}

if (process.exitCode) {
  console.error(
    `extractor-smoke FAILED — see ${fileURLToPath(new URL("../../packages/capture/src/color.ts", import.meta.url))}`,
  );
} else {
  console.log(`extractor-smoke: ${CASES.length} page(s) checked against a real Chromium`);
}
