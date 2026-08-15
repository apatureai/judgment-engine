import type { DeterministicFinding, StabilityCheck } from "@engine/capture";
import type { EngineReviewResult } from "@engine/types";

/**
 * Terminal rendering. Pure functions over already-computed results so the exact
 * output a reader sees is unit-tested, not assembled ad hoc at the call site.
 *
 * The one rule this file exists to enforce: a run that no model looked at never
 * prints a grade. The canned and mock clients produce a `grade` field like any
 * other run, and printing it as-is told readers their page had been reviewed
 * when nothing had reviewed it. So the report is keyed on which client ran. The
 * measured facts, which are real in every mode, get the numbered list; replayed
 * fixture text is labelled as fixture text and never counted as findings.
 */

/** Which client produced the critique. Only `live` means a model saw the page. */
export type ReportModelKind = "live" | "canned" | "mock";

export interface RunSummary {
  target: string;
  targetNote: string;
  routes: string[];
  viewports: string[];
  modelKind: ReportModelKind;
  modelDescription: string;
  captureVersion: string;
  screenshotCount: number;
  screenshotDir: string;
  geometryCount: number;
  deterministicFindings: DeterministicFinding[];
  /** Where the full measured-fact list was written, for the "and N more" pointer. */
  factsFile: string | null;
  pageHealthFootnote: string | null;
  /** Repeat-capture determinism check, or null when --verify-stability was off. */
  stability: StabilityCheck | null;
  hallucinationDrops: number;
  modelFindingsSeen: number;
  result: EngineReviewResult;
  files: string[];
  elapsedMs: number;
}

/** Measured facts printed inline before the list is cut short. */
export const MAX_FACT_LINES = 12;

function pad(label: string, width = 12): string {
  return label.padEnd(width, " ");
}

/** True when no model saw the page, so nothing in the critique is a judgment. */
export function isSynthetic(kind: ReportModelKind): boolean {
  return kind !== "live";
}

/**
 * Show a path relative to the working directory when that is shorter and does
 * not escape upward; otherwise show it absolute. A screenful of `../../..` is
 * worse than an absolute path.
 */
export function displayPath(absolute: string, relativeToCwd: string): string {
  return relativeToCwd.startsWith("..") ? absolute : relativeToCwd;
}

/** Count deterministic findings by check kind, in a stable order. */
export function countByKind(findings: DeterministicFinding[]): Array<[string, number]> {
  const order = ["contrast", "overflow", "touch_target"];
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  return order.filter((kind) => counts.has(kind)).map((kind) => [kind, counts.get(kind) as number]);
}

/** One measured defect, with every viewport it was measured at. */
export interface FactGroup {
  kind: string;
  route: string;
  selector: string;
  detail: string;
  viewports: string[];
}

/**
 * Collapse the per-viewport measurements into one entry per (check, route,
 * element, detail). The same 3.23:1 contrast measured at three viewports is one
 * defect a reader has to fix once, so printing it three times buys nothing; the
 * viewport list is kept because "mobile only" and "everywhere" are different
 * problems. Order is first encounter, which keeps routes together.
 */
export function groupFacts(findings: DeterministicFinding[]): FactGroup[] {
  const groups = new Map<string, FactGroup>();
  for (const finding of findings) {
    // JSON, so no separator character can collide with a selector or detail.
    const key = JSON.stringify([finding.kind, finding.route, finding.selector, finding.detail]);
    const existing = groups.get(key);
    if (existing) {
      if (!existing.viewports.includes(finding.viewport)) existing.viewports.push(finding.viewport);
      continue;
    }
    groups.set(key, {
      kind: finding.kind,
      route: finding.route,
      selector: finding.selector,
      detail: finding.detail,
      viewports: [finding.viewport],
    });
  }
  return [...groups.values()];
}

/**
 * The measured facts, as the report's numbered list. These are computed from the
 * captured DOM by `@engine/capture`, so they are true in every model mode and
 * are the whole of what an offline run legitimately tells you about a page.
 */
export function renderFacts(summary: RunSummary): string[] {
  const total = summary.deterministicFindings.length;
  if (total === 0) {
    return [
      "Measured facts  (computed from the captured DOM, no model involved)",
      "  none: no contrast, overflow or touch-target violation was measured",
    ];
  }

  const kinds = countByKind(summary.deterministicFindings);
  const kindNote = kinds.map(([kind, n]) => `${kind} ${n}`).join(", ");
  const groups = groupFacts(summary.deterministicFindings);
  const shown = groups.slice(0, MAX_FACT_LINES);

  const lines = [
    "Measured facts  (computed from the captured DOM, no model involved)",
    `  ${total} measurement(s) (${kindNote}) over ${groups.length} distinct element(s)`,
    "",
    ...shown.map(
      (group, index) =>
        `  ${String(index + 1).padStart(2, " ")}. [${group.kind}] ${group.route} ${group.selector} ` +
        `(${group.viewports.join(", ")})\n      ${group.detail}`,
    ),
  ];
  if (groups.length > shown.length) {
    lines.push(`      …and ${groups.length - shown.length} more`);
  }
  if (summary.factsFile !== null) {
    lines.push(`  every measurement: ${summary.factsFile}`);
  }
  return lines;
}

/**
 * The determinism check's own line. A check that ran and found nothing still
 * says so; otherwise `--verify-stability` is indistinguishable from a run that
 * never made the comparison.
 */
export function renderStability(stability: StabilityCheck | null): string[] {
  if (stability === null) return [];
  const { pagesCompared, unstablePages } = stability;
  const stable = pagesCompared - unstablePages;
  return unstablePages === 0
    ? [`  stability: verified — ${stable}/${pagesCompared} page(s) byte-identical on a repeat capture`]
    : [
        `  stability: FAILED — ${unstablePages}/${pagesCompared} page(s) differed on a repeat capture;`,
        "             something is still moving, so treat the findings as unstable",
      ];
}

function findingLines(result: EngineReviewResult, bullet: (index: number) => string): string[] {
  return result.findings.map(
    (finding, index) =>
      `  ${bullet(index)} [${finding.severity}/${finding.dimension}] ${finding.title}\n` +
      `      ${finding.route} ${finding.viewport} → ${finding.element ?? "(no element)"}`,
  );
}

/** One line per surviving model finding. Live runs only. */
export function renderFindings(result: EngineReviewResult): string[] {
  if (result.findings.length === 0) return ["  (none)"];
  return findingLines(result, (index) => `${String(index + 1).padStart(2, " ")}.`);
}

/**
 * The replayed critique of an offline run. Never numbered and never called a
 * finding: this text was authored in a fixture before the page existed, and the
 * only thing it proves is that the pipeline carried it end to end.
 */
export function renderFixtureCritique(summary: RunSummary): string[] {
  const client = summary.modelKind === "mock" ? "mock" : "canned";
  if (summary.result.findings.length === 0) {
    return [
      `  The ${client} client produced no critique text. Nothing above judged this page;`,
      "  the measured facts are this run's only real output.",
    ];
  }
  return [
    `  FIXTURE TEXT: replayed from the ${client} client, not a judgment about this page.`,
    "  It was authored before this page was captured; it survived the grounding gate",
    "  only because this page happens to contain the elements it names.",
    "",
    // Padded to the width of the numbered form so the second line still aligns.
    ...findingLines(summary.result, () => "  -"),
  ];
}

/** The `Review` block: the grade, or the reason there cannot be one. */
export function renderReview(summary: RunSummary): string[] {
  const { result } = summary;
  if (isSynthetic(summary.modelKind)) {
    const client = summary.modelKind === "mock" ? "mock" : "canned";
    return [
      "Review",
      `  ${pad("grade")}n/a (${client} client, no model saw this page)`,
      `  ${pad("findings")}n/a (no model ran; see the measured facts above)`,
      `  ${pad("confidence")}n/a (no model ran)`,
      `  ${pad("blocking")}${result.blockingEnabled ? "enabled" : "advisory only"}`,
      "",
      ...renderFixtureCritique(summary),
    ];
  }
  return [
    "Review",
    `  ${pad("grade")}${result.grade}`,
    `  ${pad("findings")}${result.findings.length}`,
    `  ${pad("confidence")}${
      result.confidence !== undefined
        ? String(result.confidence)
        : `withheld (${result.confidenceUnavailableReason ?? "no promoted calibration report"})`
    }`,
    `  ${pad("blocking")}${result.blockingEnabled ? "enabled" : "advisory only"}`,
    "",
    ...renderFindings(result),
  ];
}

/** The full report a run prints on success. */
export function renderSummary(summary: RunSummary): string {
  const synthetic = isSynthetic(summary.modelKind);
  const parsedFrom = synthetic ? "replayed finding(s) parsed" : "model finding(s) parsed";

  const lines: string[] = [
    "",
    "Target",
    `  ${pad("url")}${summary.target}${summary.targetNote ? `  ${summary.targetNote}` : ""}`,
    `  ${pad("routes")}${summary.routes.join(", ")}`,
    `  ${pad("viewports")}${summary.viewports.join(", ")}`,
    `  ${pad("model")}${summary.modelDescription}`,
    `  ${pad("capture")}${summary.captureVersion}`,
    "",
    "Capture",
    `  ${summary.screenshotCount} screenshot(s) written to ${summary.screenshotDir}`,
    `  ${summary.geometryCount} DOM element(s) recorded in the geometry map`,
    `  page health: ${summary.pageHealthFootnote ?? "clean"}`,
    ...renderStability(summary.stability),
    "",
    ...renderFacts(summary),
    "",
    "Grounding gate",
    `  ${summary.modelFindingsSeen} ${parsedFrom}, ${summary.hallucinationDrops} dropped for citing a route or element that was never captured`,
    "",
    ...renderReview(summary),
    "",
    "Wrote",
    ...summary.files.map((file) => `  ${file}`),
    // Both offline clients emit a grade into review.json; neither one earned it. Name the client
    // that produced it, because "the fixture's" is only true of the canned replay.
    ...(synthetic
      ? [
          `  note: review.json carries the ${
            summary.modelKind === "mock" ? "mock client's" : "fixture's"
          } own grade field. It is not a grade for this page.`,
          // The file outlives this terminal, so the file says it too.
          "        its provenance block says the same in band: model_backed is false.",
        ]
      : []),
    "",
    `Done in ${(summary.elapsedMs / 1000).toFixed(1)}s.`,
  ];
  return lines.join("\n");
}
