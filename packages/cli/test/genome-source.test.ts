import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRepoGenome, UI_DNA_FILENAME } from "../src/index.js";

/**
 * The only genome a local run can have is one exported from the Source of Truth
 * and left in the context directory, so what this loader accepts IS the local
 * grounding contract. Two properties matter more than the parsing:
 *
 *   - the rule text it produces is the same string `HttpGenomeResolver` produces
 *     from the same snapshot, so a local review and a deployed review of one
 *     genome are grounded on the same words rather than on two dialects; and
 *   - a file that is present and unusable is never silently equal to no file,
 *     because those send a reader to two different fixes.
 */

async function withSnapshot(document: unknown | string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "je-genome-"));
  await writeFile(
    join(dir, UI_DNA_FILENAME),
    typeof document === "string" ? document : JSON.stringify(document),
  );
  return dir;
}

function snapshot(items: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
    snapshot: {
      id: "snap_1",
      dna_version: "ui-dna@2026.06.12",
      approval_state: "approved",
      authority: {
        contract_version: "uidna-authority/1",
        status: "effective",
        sequence: 4,
        head_event_hash: `sha256:${"a".repeat(64)}`,
        checked_at: "2026-06-12T00:00:00.000Z",
      },
      ...overrides,
    },
    items,
  };
}

const ITEM = {
  field_id: "spacing.scale",
  kind: "spacing",
  value: { scale: [4, 8, 12, 16] },
  applicability: { component_kinds: ["card", "button"] },
};

describe("loadRepoGenome", () => {
  it("projects items into rules exactly as the deployed resolver does", async () => {
    const dir = await withSnapshot(snapshot([ITEM]));
    const genome = await loadRepoGenome(dir);

    expect(genome.available).toBe(true);
    if (!genome.available) return;
    expect(genome.version).toBe("ui-dna@2026.06.12");
    expect(genome.rules).toEqual([
      {
        id: "spacing.scale",
        // The `HttpGenomeResolver.resolve` projection, character for character.
        text: JSON.stringify({ kind: "spacing", value: { scale: [4, 8, 12, 16] } }),
        component: "card",
      },
    ]);
    expect(genome.source).toBe(join(dir, UI_DNA_FILENAME));
  });

  it("accepts a superseded snapshot, which is still a published design system", async () => {
    const dir = await withSnapshot(snapshot([ITEM], { approval_state: "superseded" }));
    expect((await loadRepoGenome(dir)).available).toBe(true);
  });

  it("reports a missing file as its own reason, naming the path to create", async () => {
    const dir = await mkdtemp(join(tmpdir(), "je-genome-"));
    const genome = await loadRepoGenome(dir);

    expect(genome).toMatchObject({ available: false, reason: "no_genome_file" });
    if (genome.available) return;
    expect(genome.detail).toContain(join(dir, UI_DNA_FILENAME));
  });

  it("never grounds on half a design system", async () => {
    // Any item the contract rejects rejects the whole snapshot. Grounding a
    // review on the rules that happened to parse would be a design system the
    // repository never approved, applied silently.
    const dir = await withSnapshot(snapshot([ITEM, { field_id: "radius.card", kind: "radius" }]));
    const genome = await loadRepoGenome(dir);

    expect(genome).toMatchObject({ available: false, reason: "genome_unreadable" });
    if (genome.available) return;
    expect(genome.detail).toContain("item 1 has no `value` object");
  });

  it.each([
    ["not JSON at all", "{"],
    ["a document with no snapshot", JSON.stringify({ items: [] })],
    ["a snapshot with no version", JSON.stringify(snapshot([ITEM], { dna_version: "" }))],
    ["an unpublished snapshot", JSON.stringify(snapshot([ITEM], { approval_state: "draft" }))],
    ["a duplicate field_id", JSON.stringify(snapshot([ITEM, ITEM]))],
  ])("rejects %s rather than grounding on it", async (_label, body) => {
    const dir = await withSnapshot(body);
    expect((await loadRepoGenome(dir)).available).toBe(false);
  });

  it("tells an empty snapshot apart from a broken one", async () => {
    // The file is fine and the design system it describes is silent. Calling
    // that unreadable would send a reader to fix a file with nothing wrong.
    const dir = await withSnapshot(snapshot([]));
    const genome = await loadRepoGenome(dir);

    expect(genome).toMatchObject({ available: false, reason: "genome_has_no_rules" });
    if (genome.available) return;
    expect(genome.detail).toContain("carries no rules");
  });

  it("does not cap the genome at the deployed path's request size", async () => {
    // `max_items=100` bounds a network response, not what may ground a review;
    // retrieval's top-k is what bounds the prompt, here and in production alike.
    const items = Array.from({ length: 140 }, (_, i) => ({
      ...ITEM,
      field_id: `spacing.scale.${i}`,
    }));
    const dir = await withSnapshot(snapshot(items));
    const genome = await loadRepoGenome(dir);

    expect(genome.available).toBe(true);
    if (!genome.available) return;
    expect(genome.rules).toHaveLength(140);
  });
});
