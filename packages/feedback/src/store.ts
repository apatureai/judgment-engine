import type { SqlExecutor } from "@engine/db";

/**
 * Feedback store (TRD §8). Persists the signals on findings that become the data
 * moat. #38 explicit (thumbs / `/ignore`) lands here with "latest per (finding,
 * rater) wins"; #39 implicit and #40 recheck extend it. The POST-only ingestion
 * endpoint (reaction API / slash command + HMAC) is product delivery (Gate); the
 * engine owns persistence.
 */
export type RaterPermission = "owner" | "write" | "read" | "public";
export type ExplicitSignal = "thumbs_up" | "thumbs_down" | "ignore";
export type FeedbackSignal = ExplicitSignal | "applied" | "recheck";
export type FeedbackSource = "explicit" | "implicit";

export interface FeedbackRecord {
  id: string;
  findingId: string;
  raterId: string | null;
  signal: FeedbackSignal;
  source: FeedbackSource;
  raterPermission: RaterPermission;
  createdAt: Date;
}

interface FeedbackRow {
  id: string;
  finding_id: string;
  rater_id: string | null;
  signal: FeedbackSignal;
  source: FeedbackSource;
  rater_permission: RaterPermission;
  created_at: Date;
}

const COLS = "id, finding_id, rater_id, signal, source, rater_permission, created_at";

function mapRow(r: FeedbackRow): FeedbackRecord {
  return {
    id: r.id,
    findingId: r.finding_id,
    raterId: r.rater_id,
    signal: r.signal,
    source: r.source,
    raterPermission: r.rater_permission,
    createdAt: r.created_at,
  };
}

export interface ExplicitFeedbackInput {
  findingId: string;
  raterId: string;
  signal: ExplicitSignal;
  raterPermission: RaterPermission;
}

export class FeedbackStore {
  constructor(private readonly exec: SqlExecutor) {}

  /**
   * Record an explicit signal (#38). Latest per (finding, rater) wins: any prior
   * explicit signal from this rater on this finding is superseded.
   */
  async recordExplicit(input: ExplicitFeedbackInput): Promise<FeedbackRecord> {
    await this.exec.query(
      `DELETE FROM feedback WHERE finding_id = $1 AND rater_id = $2 AND source = 'explicit'`,
      [input.findingId, input.raterId],
    );
    const { rows } = await this.exec.query<FeedbackRow>(
      `INSERT INTO feedback (finding_id, rater_id, signal, source, rater_permission)
       VALUES ($1, $2, $3, 'explicit', $4)
       RETURNING ${COLS}`,
      [input.findingId, input.raterId, input.signal, input.raterPermission],
    );
    return mapRow(rows[0] as FeedbackRow);
  }

  /** All feedback for a finding, newest first. */
  async forFinding(findingId: string): Promise<FeedbackRecord[]> {
    const { rows } = await this.exec.query<FeedbackRow>(
      `SELECT ${COLS} FROM feedback WHERE finding_id = $1 ORDER BY created_at DESC`,
      [findingId],
    );
    return rows.map(mapRow);
  }
}
