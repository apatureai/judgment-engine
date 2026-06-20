import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { pgliteExecutor, runMigrations } from "../src/index.js";

async function migrated(): Promise<PGlite> {
  const db = new PGlite();
  await runMigrations(pgliteExecutor(db));
  return db;
}

const insertFinding = `
  INSERT INTO findings (installation_id, route, viewport, dimension, severity, confidence,
    element_ref, model, prompt_version, engine_version, capture_version)
  VALUES ('1', '/pricing', 'desktop', 'spacing', 'minor', 0.7, '#cta',
    'qwen3-vl-plus', 'v1', '1.0.0', 'c1')
  RETURNING id`;

describe("findings + feedback schema (#37)", () => {
  it("stores a version-stamped finding with all required columns", async () => {
    const db = await migrated();
    const { rows } = await db.query<{ id: string }>(insertFinding);
    const got = await db.query<{ dimension: string; prompt_version: string; model: string }>(
      "SELECT dimension, prompt_version, model FROM findings WHERE id = $1",
      [rows[0]?.id],
    );
    expect(got.rows[0]).toMatchObject({ dimension: "spacing", prompt_version: "v1", model: "qwen3-vl-plus" });
  });

  it("links feedback to a finding and cascades on delete", async () => {
    const db = await migrated();
    const { rows } = await db.query<{ id: string }>(insertFinding);
    const findingId = rows[0]?.id;
    await db.query(
      `INSERT INTO feedback (finding_id, signal, source, rater_permission)
       VALUES ($1, 'thumbs_down', 'explicit', 'owner')`,
      [findingId],
    );

    const before = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM feedback");
    expect(before.rows[0]?.count).toBe("1");

    await db.query("DELETE FROM findings WHERE id = $1", [findingId]);
    const after = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM feedback");
    expect(after.rows[0]?.count).toBe("0"); // ON DELETE CASCADE
  });

  it("enforces the severity and signal/permission check constraints", async () => {
    const db = await migrated();
    await expect(
      db.query(
        `INSERT INTO findings (installation_id, route, viewport, dimension, severity, confidence, model, prompt_version, engine_version, capture_version)
         VALUES ('1','/','desktop','spacing','catastrophic',0.5,'m','v','e','c')`,
      ),
    ).rejects.toThrow();

    const { rows } = await db.query<{ id: string }>(insertFinding);
    await expect(
      db.query(
        `INSERT INTO feedback (finding_id, signal, source, rater_permission) VALUES ($1,'thumbs_down','explicit','stranger')`,
        [rows[0]?.id],
      ),
    ).rejects.toThrow(); // invalid rater_permission
  });

  it("has the export-supporting indices", async () => {
    const db = await migrated();
    const { rows } = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('findings','feedback')",
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining(["findings_prompt_version_idx", "findings_installation_idx", "feedback_finding_idx"]),
    );
  });
});
