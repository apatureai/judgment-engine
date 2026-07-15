import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TRUST_DECISION_VERSION,
  assertNotSemanticAuthority,
  decideArtifactTrust,
  isUsePermitted,
  SemanticAuthorityError,
} from "../src/index.js";

describe("ArtifactTrustDecisionV1 — lineage is not authority (#156, ADR-0008/SCITT)", () => {
  it("verified lineage grants only the explicitly policy-granted uses (deduped)", () => {
    const d = decideArtifactTrust({
      bundleId: "b1",
      keyId: "k1",
      lineageVerified: true,
      grantedUses: ["drift_analysis_input", "audit_reference", "drift_analysis_input"],
      decidedAt: "2026-07-15T00:00:00Z",
    });
    expect(d.version).toBe(ARTIFACT_TRUST_DECISION_VERSION);
    expect(d.allowedUses).toEqual(["drift_analysis_input", "audit_reference"]);
    expect(isUsePermitted(d, "drift_analysis_input")).toBe(true);
    expect(isUsePermitted(d, "grounding_context")).toBe(false); // not granted
    expect(d.lineageRejectionReason).toBeUndefined();
  });

  it("unverified lineage permits NOTHING, regardless of granted uses, and records the reason", () => {
    const d = decideArtifactTrust({
      bundleId: "b1",
      keyId: "k1",
      lineageVerified: false,
      lineageRejectionReason: "signature_invalid",
      grantedUses: ["drift_analysis_input"], // ignored
      decidedAt: "2026-07-15T00:00:00Z",
    });
    expect(d.allowedUses).toEqual([]);
    expect(isUsePermitted(d, "drift_analysis_input")).toBe(false);
    expect(d.lineageRejectionReason).toBe("signature_invalid");
  });

  it("a forbidden use can never be granted (disjoint from AllowedUse) and fails closed at runtime", () => {
    const d = decideArtifactTrust({ bundleId: "b", keyId: "k", lineageVerified: true, grantedUses: ["drift_analysis_input"], decidedAt: "t" });
    // publish_finding / approve_ui_dna / training_grade_feedback are not AllowedUse, so they cannot appear in allowedUses.
    expect(d.allowedUses).not.toContain("publish_finding" as never);
    expect(() => assertNotSemanticAuthority("publish_finding")).toThrow(SemanticAuthorityError);
    expect(() => assertNotSemanticAuthority("approve_ui_dna")).toThrow(/provenance, not authority/);
    expect(() => assertNotSemanticAuthority("training_grade_feedback")).toThrow(SemanticAuthorityError);
  });
});
