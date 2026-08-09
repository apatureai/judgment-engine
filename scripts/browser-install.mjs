#!/usr/bin/env node
/**
 * `pnpm browser:install` — install the Chromium build playwright-core drives,
 * then prove it launches.
 *
 * This wraps `playwright-core install chromium` for two reasons. First, the raw
 * command says nothing at all when the browser is already cached, which is
 * indistinguishable from a no-op on the only step of the install that touches
 * the network. Second, "the download finished" is not the claim a reader needs
 * — the claim is "a browser will start", so this launches it and prints the
 * version it got.
 *
 * Extra arguments are forwarded, so CI can run `pnpm browser:install --with-deps`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";

const require = createRequire(new URL("../packages/capture/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const cli = join(dirname(require.resolve("playwright-core/package.json")), "cli.js");
const version = require("playwright-core/package.json").version;

const executable = chromium.executablePath();
const cached = existsSync(executable);
if (!cached) console.log("Downloading Chromium (~275 MB, one time)…");

const install = spawnSync(process.execPath, [cli, "install", ...process.argv.slice(2), "chromium"], {
  stdio: "inherit",
});
if (install.status !== 0) {
  console.error(`playwright-core install chromium failed (exit ${install.status ?? "signal"})`);
  process.exit(install.status ?? 1);
}

// Launch it. An installed binary that cannot start is the failure this catches,
// and it is the same launch `pnpm review` makes a moment later.
const browser = await chromium.launch();
const reported = browser.version();
await browser.close();

// Everything playwright downloads lives in one cache root, above the versioned
// per-browser directories; name it so the download is not somewhere unexplained.
const marker = executable.indexOf(`${sep}chromium-`);
const cacheRoot = marker > 0 ? executable.slice(0, marker) : dirname(executable);

console.log(
  `${cached ? "Chromium was already installed" : "Chromium installed"} — ${reported} launches ` +
    `(playwright-core ${version})\n  cached in ${cacheRoot}`,
);
