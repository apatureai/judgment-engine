import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlExecutor } from "./executor.js";

/**
 * Directory holding ordered migration pairs `NNNN_name.up.sql` /
 * `NNNN_name.down.sql` (sibling of both `src` and `dist`). The migration id is
 * the stem (`NNNN_name`); ids sort lexically, so apply order is deterministic.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

const UP_SUFFIX = ".up.sql";

const TRACKING_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id         text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);`;

/** Ordered migration ids discovered in `dir` (by their `.up.sql` files). */
export function listMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(UP_SUFFIX))
    .map((f) => f.slice(0, -UP_SUFFIX.length))
    .sort();
}

async function appliedIds(exec: SqlExecutor): Promise<Set<string>> {
  const { rows } = await exec.query<{ id: string }>("SELECT id FROM schema_migrations");
  return new Set(rows.map((r) => r.id));
}

/**
 * Apply every pending migration's `.up.sql` in lexical order, exactly once each.
 *
 * Tracking lives in `schema_migrations`; already-applied ids are skipped, so the
 * runner is idempotent and safe to run automatically on every deploy. Returns
 * the ids applied this run (empty when nothing was pending).
 */
export async function runMigrations(
  exec: SqlExecutor,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  await exec.exec(TRACKING_TABLE);
  const done = await appliedIds(exec);

  const applied: string[] = [];
  for (const id of listMigrations(dir)) {
    if (done.has(id)) continue;
    assertSafeId(id);
    const sql = readFileSync(join(dir, `${id}${UP_SUFFIX}`), "utf8");
    // Apply the migration AND record it in one simple-query, so a statement that
    // fails mid-file rolls the whole unit back (incl. the tracking row) under
    // Postgres'/PGlite's implicit per-query transaction, so the runner stays
    // crash-idempotent, not just skip-idempotent. (id is filename-derived and
    // charset-guarded, so inlining it is safe.)
    await exec.exec(`${sql};\nINSERT INTO schema_migrations (id) VALUES ('${id}');`);
    applied.push(id);
  }
  return applied;
}

/**
 * Roll back the last `count` applied migrations (default 1) by running their
 * `.down.sql` in reverse application order and clearing the tracking rows.
 *
 * Deterministic: ids are applied in lexical order, so reverse-lexical is exactly
 * reverse-application order. Reverting then re-running `runMigrations` restores
 * the same schema. Returns the ids reverted this run (empty when nothing was
 * applied).
 */
export async function rollbackMigrations(
  exec: SqlExecutor,
  count = 1,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  await exec.exec(TRACKING_TABLE);
  const done = await appliedIds(exec);

  const toRevert = listMigrations(dir)
    .filter((id) => done.has(id))
    .reverse()
    .slice(0, Math.max(0, count));

  const reverted: string[] = [];
  for (const id of toRevert) {
    assertSafeId(id);
    const sql = readFileSync(join(dir, `${id}.down.sql`), "utf8");
    // Revert AND clear the tracking row atomically (see runMigrations).
    await exec.exec(`${sql};\nDELETE FROM schema_migrations WHERE id = '${id}';`);
    reverted.push(id);
  }
  return reverted;
}

/** Guard the filename-derived id before inlining it into SQL. */
function assertSafeId(id: string): void {
  if (!/^[0-9A-Za-z_]+$/.test(id)) {
    throw new Error(`unsafe migration id: ${id}`);
  }
}
