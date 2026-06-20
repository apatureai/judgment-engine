import { Pool } from "pg";
import { pgExecutor } from "../executor.js";
import { rollbackMigrations, runMigrations } from "../migrate.js";

/**
 * Deploy/CI entrypoint against `DATABASE_URL`:
 *   `migrate`            apply all pending migrations (default)
 *   `migrate down [n]`   roll back the last n migrations (default 1)
 *
 * Wired as the Fly release command (#3) so migrations apply automatically on
 * every deploy, and runnable against an ephemeral Neon branch in CI.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const direction = process.argv[2] ?? "up";
  const pool = new Pool({ connectionString });
  try {
    const exec = pgExecutor(pool);
    if (direction === "down") {
      const count = Number(process.argv[3] ?? "1");
      const reverted = await rollbackMigrations(exec, count);
      console.log(reverted.length > 0 ? `Reverted: ${reverted.join(", ")}` : "Nothing to roll back");
    } else {
      const applied = await runMigrations(exec);
      console.log(applied.length > 0 ? `Applied: ${applied.join(", ")}` : "No pending migrations");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
