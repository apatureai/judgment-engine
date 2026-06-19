import { describe, expect, it } from "vitest";
import {
  isTrainingGrade,
  raterWeight,
  weightedConsensus,
  type FeedbackRecord,
} from "../src/index.js";

const fb = (over: Partial<FeedbackRecord>): FeedbackRecord => ({
  id: "f",
  findingId: "x",
  raterId: "u",
  signal: "thumbs_up",
  source: "explicit",
  raterPermission: "owner",
  createdAt: new Date(),
  ...over,
});

describe("rater-permission down-weighting (#42)", () => {
  it("treats owner/write as training-grade collaborators, read/public as drive-by", () => {
    expect(isTrainingGrade("owner")).toBe(true);
    expect(isTrainingGrade("write")).toBe(true);
    expect(isTrainingGrade("read")).toBe(false);
    expect(isTrainingGrade("public")).toBe(false);
    expect(raterWeight("owner")).toBeGreaterThan(raterWeight("public"));
  });

  it("down-weights non-collaborator signals in the consensus", () => {
    // One collaborator thumbs_up vs one drive-by thumbs_down: collaborator dominates.
    const consensus = weightedConsensus([
      fb({ raterPermission: "owner", signal: "thumbs_up" }),
      fb({ raterPermission: "public", signal: "thumbs_down" }),
    ]);
    expect(consensus.score).toBeCloseTo(1 - 0.1, 5); // +1 (owner) - 0.1 (public)
    expect(consensus.score).toBeGreaterThan(0);
    expect(consensus.trainingGradeCount).toBe(1);
  });

  it("weights ignore/merged-with-blockers as negative and recheck as neutral", () => {
    expect(weightedConsensus([fb({ signal: "ignore" })]).score).toBeLessThan(0);
    expect(weightedConsensus([fb({ signal: "merged_blockers_unresolved", raterPermission: "write" })]).score).toBeLessThan(0);
    expect(weightedConsensus([fb({ signal: "recheck" })]).score).toBe(0);
  });
});
