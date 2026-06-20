import type { SqlExecutor } from "@engine/db";

/**
 * Model/prompt registry (TRD §9, #71). Versions every model/prompt; promotion to
 * `stable` requires a passing eval gate (#47/#48) so nothing reaches production
 * without a version bump (#68) + an eval pass — which also keeps the preference
 * dataset uncontaminated across prompt generations. Rollback is a status flip
 * back to the last stable version. Shadow/canary rollout is deferred (#80).
 */
export type RegistryStatus = "candidate" | "stable" | "rolled_back";

export interface RegistryStamp {
  model: string;
  promptVersion: string;
  engineVersion: string;
  captureVersion: string;
}

export interface RegistryEntry extends RegistryStamp {
  id: string;
  status: RegistryStatus;
  evalPassed: boolean;
  createdAt: Date;
  promotedAt: Date | null;
}

interface RegistryRow {
  id: string;
  model: string;
  prompt_version: string;
  engine_version: string;
  capture_version: string;
  status: RegistryStatus;
  eval_passed: boolean;
  created_at: Date;
  promoted_at: Date | null;
}

const COLS =
  "id, model, prompt_version, engine_version, capture_version, status, eval_passed, created_at, promoted_at";

function mapRow(r: RegistryRow): RegistryEntry {
  return {
    id: r.id,
    model: r.model,
    promptVersion: r.prompt_version,
    engineVersion: r.engine_version,
    captureVersion: r.capture_version,
    status: r.status,
    evalPassed: r.eval_passed,
    createdAt: r.created_at,
    promotedAt: r.promoted_at,
  };
}

export class ModelPromptRegistry {
  constructor(private readonly exec: SqlExecutor) {}

  /** Register a new candidate version. */
  async registerCandidate(stamp: RegistryStamp): Promise<RegistryEntry> {
    const { rows } = await this.exec.query<RegistryRow>(
      `INSERT INTO model_prompt_registry (model, prompt_version, engine_version, capture_version)
       VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
      [stamp.model, stamp.promptVersion, stamp.engineVersion, stamp.captureVersion],
    );
    return mapRow(rows[0] as RegistryRow);
  }

  /** Record the offline-batch eval result for a candidate. */
  async recordEval(id: string, passed: boolean): Promise<void> {
    await this.exec.query(`UPDATE model_prompt_registry SET eval_passed = $2 WHERE id = $1`, [id, passed]);
  }

  async get(id: string): Promise<RegistryEntry | null> {
    const { rows } = await this.exec.query<RegistryRow>(
      `SELECT ${COLS} FROM model_prompt_registry WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /** The currently-stable (production) version, or null. */
  async current(): Promise<RegistryEntry | null> {
    const { rows } = await this.exec.query<RegistryRow>(
      `SELECT ${COLS} FROM model_prompt_registry WHERE status = 'stable' LIMIT 1`,
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  /**
   * Promote a candidate to stable — ONLY if its eval gate passed. Demotes the
   * current stable to rolled_back first (at most one stable).
   */
  async promote(id: string): Promise<RegistryEntry> {
    const entry = await this.get(id);
    if (!entry) throw new Error(`registry entry ${id} not found`);
    if (!entry.evalPassed) {
      throw new Error(`cannot promote ${id}: eval gate has not passed (version bump + eval pass required)`);
    }
    await this.exec.query(`UPDATE model_prompt_registry SET status = 'rolled_back' WHERE status = 'stable'`);
    const { rows } = await this.exec.query<RegistryRow>(
      `UPDATE model_prompt_registry SET status = 'stable', promoted_at = now()
       WHERE id = $1 RETURNING ${COLS}`,
      [id],
    );
    return mapRow(rows[0] as RegistryRow);
  }

  /**
   * Roll back: demote the current stable to rolled_back and restore the most
   * recently-promoted prior version as stable. Returns the restored entry, or
   * null if there is no prior version to restore.
   */
  async rollback(): Promise<RegistryEntry | null> {
    const { rows: prevRows } = await this.exec.query<RegistryRow>(
      `SELECT ${COLS} FROM model_prompt_registry
       WHERE status = 'rolled_back' AND promoted_at IS NOT NULL
       ORDER BY promoted_at DESC LIMIT 1`,
    );
    await this.exec.query(`UPDATE model_prompt_registry SET status = 'rolled_back' WHERE status = 'stable'`);
    const prev = prevRows[0];
    if (!prev) return null;
    const { rows } = await this.exec.query<RegistryRow>(
      `UPDATE model_prompt_registry SET status = 'stable', promoted_at = now()
       WHERE id = $1 RETURNING ${COLS}`,
      [prev.id],
    );
    return mapRow(rows[0] as RegistryRow);
  }
}
