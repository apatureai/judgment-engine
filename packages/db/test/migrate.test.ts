import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { listMigrations, pgliteExecutor, rollbackMigrations, runMigrations } from "../src/index.js";

async function functionExists(db: PGlite, name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = $1) AS exists",
    [name],
  );
  return rows[0]?.exists ?? false;
}

async function appliedCount(db: PGlite): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM schema_migrations",
  );
  return Number(rows[0]?.count ?? "0");
}

describe("migration runner", () => {
  it("applies every pending migration and is idempotent", async () => {
    const db = new PGlite();
    const exec = pgliteExecutor(db);

    const first = await runMigrations(exec);
    expect(first).toEqual(listMigrations());
    expect(first).toContain("0001_init");
    expect(await functionExists(db, "touch_updated_at")).toBe(true);

    // Re-running applies nothing and leaves the tracking table unchanged.
    const second = await runMigrations(exec);
    expect(second).toEqual([]);
    expect(await appliedCount(db)).toBe(listMigrations().length);
  });

  it("rolls back the most-recent migration first (reverse order)", async () => {
    const db = new PGlite();
    const exec = pgliteExecutor(db);

    await runMigrations(exec);
    const all = listMigrations();
    const reverted = await rollbackMigrations(exec, 1);
    // Reverse-lexical = reverse-application order: the last migration goes first.
    expect(reverted).toEqual([all[all.length - 1]]);
    expect(await appliedCount(db)).toBe(all.length - 1);
  });

  it("rolls back fully and re-applies to the same schema (deterministic round-trip)", async () => {
    const db = new PGlite();
    const exec = pgliteExecutor(db);

    await runMigrations(exec);
    const reverted = await rollbackMigrations(exec, listMigrations().length);
    expect(reverted).toEqual([...listMigrations()].reverse());
    expect(await functionExists(db, "touch_updated_at")).toBe(false);
    expect(await appliedCount(db)).toBe(0);

    // Forward again restores the identical schema.
    const reapplied = await runMigrations(exec);
    expect(reapplied).toEqual(listMigrations());
    expect(await functionExists(db, "touch_updated_at")).toBe(true);
  });

  it("treats rollback on an unmigrated database as a no-op", async () => {
    const db = new PGlite();
    const exec = pgliteExecutor(db);
    expect(await rollbackMigrations(exec, 5)).toEqual([]);
  });
});
