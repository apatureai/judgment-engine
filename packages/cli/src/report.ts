import type { DeterministicFinding, StabilityCheck } from "@engine/capture";
import type { EngineReviewResult } from "@engine/types";

/**
 * Terminal rendering. Pure functions over already-computed results so the exact
 * output a reader sees is unit-tested, not assembled ad hoc at the call site.
 */

export interface RunSummary {
  target: string;
  targetNote: string;
  routes: string[];
  viewports: string[];
  modelDescription: string;
  captureVersion: string;
  screenshotCount: number;
  screenshotDir: string;
  geometryCount: number;
  deterministicFindings: DeterministicFinding[];
  pageHealthFootnote: string | null;
  /** Repeat-capture determinism check, or null when --verify-stability was off. */
  stability: StabilityCheck | null;
  hallucinationDrops: number;
  modelFindingsSeen: number;
  result: EngineReviewResult;
  files: string[];
  elapsedMs: number;
}

function pad(label: string, width = 12): string {
  return label.padEnd(width, " ");
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

/** One line per surviving finding. */
export function renderFindings(result: EngineReviewResult): string[] {
  if (result.findings.length === 0) return ["  (none)"];
  return result.findings.map(
    (finding, index) =>
      `  ${String(index + 1).padStart(2, " ")}. [${finding.severity}/${finding.dimension}] ${finding.title}\n` +
      `      ${finding.route} ${finding.viewport} → ${finding.element ?? "(no element)"}`,
  );
}

/** The full report a run prints on success. */
export function renderSummary(summary: RunSummary): string {
  const kinds = countByKind(summary.deterministicFindings);
  const kindNote = kinds.length > 0 ? ` (${kinds.map(([kind, n]) => `${kind} ${n}`).join(", ")})` : "";

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
    `  ${summary.deterministicFindings.length} deterministic fact(s)${kindNote}`,
    `  page health: ${summary.pageHealthFootnote ?? "clean"}`,
    ...renderStability(summary.stability),
    "",
    "Grounding gate",
    `  ${summary.modelFindingsSeen} model finding(s) parsed, ${summary.hallucinationDrops} dropped for citing a route or element that was never captured`,
    "",
    "Review",
    `  ${pad("grade")}${summary.result.grade}`,
    `  ${pad("findings")}${summary.result.findings.length}`,
    `  ${pad("confidence")}${
      summary.result.confidence !== undefined
        ? String(summary.result.confidence)
        : `withheld (${summary.result.confidenceUnavailableReason ?? "no promoted calibration report"})`
    }`,
    `  ${pad("blocking")}${summary.result.blockingEnabled ? "enabled" : "advisory only"}`,
    "",
    ...renderFindings(summary.result),
    "",
    "Wrote",
    ...summary.files.map((file) => `  ${file}`),
    "",
    `Done in ${(summary.elapsedMs / 1000).toFixed(1)}s.`,
  ];
  return lines.join("\n");
}
