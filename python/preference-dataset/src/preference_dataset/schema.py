"""Typed schema for the preference-dataset tuples emitted by judgment-engine.

This is a *faithful mirror* of the TypeScript producer — do not invent fields
here. The source of truth is:

  - `packages/feedback/src/preference-export.ts`  (`PreferenceExample`)
  - `packages/types/src/findings.ts`              (the enum literal spaces)

The enums below are copied verbatim from `findings.ts`; validation rejects any
value outside them so that a schema drift on the TS side surfaces loudly here
instead of silently poisoning a training set.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, model_validator

# --- enum spaces, copied from packages/types/src/findings.ts ------------------

Dimension = Literal[
    "visual_hierarchy",
    "spacing",
    "color_contrast",
    "typography",
    "consistency",
    "responsiveness",
    "accessibility",
    "brand",
]
Severity = Literal["nit", "minor", "major", "blocker"]
Viewport = Literal["mobile", "tablet", "desktop"]

# --- preference-export.ts value spaces ----------------------------------------

Verdict = Literal["endorsed", "dismissed"]
Label = Literal["desirable", "undesirable"]
KtoSource = Literal["thumbs", "ignore", "implicit"]


class Finding(BaseModel):
    """Mirrors `PreferenceExample.finding` (preference-export.ts)."""

    model_config = ConfigDict(extra="forbid")

    dimension: Dimension
    severity: Severity
    route: str
    viewport: Viewport
    elementRef: Optional[str] = None


class PreferenceExample(BaseModel):
    """One labeled revealed-preference tuple.

    Mirrors the `PreferenceExample` interface. `source` is optional because the
    DVC-export test factory omits it while the full `exportPreferenceDataset`
    return always includes it; both shapes must parse.
    """

    model_config = ConfigDict(extra="forbid")

    findingId: str
    installationId: str
    promptVersion: str
    imageRef: Optional[str] = None
    contextHash: Optional[str] = None
    finding: Finding
    verdict: Verdict
    label: Label
    # TS declares `source` required + non-null, but the DVC-export test factory
    # omits it; kept Optional so both shapes parse. Content-addressing reproduces
    # the TS field set exactly (see `reader.dvc_content`): a source-omitted tuple
    # hashes *without* a `source` key so its DVC id matches the TS side (#127).
    source: Optional[KtoSource] = None
    trainingGrade: bool

    @model_validator(mode="after")
    def _verdict_label_agree(self) -> "PreferenceExample":
        # The TS producer sets label from verdict (endorsed->desirable). If they
        # ever disagree the tuple is corrupt; refuse it rather than train on it.
        want: Label = "desirable" if self.verdict == "endorsed" else "undesirable"
        if self.label != want:
            raise ValueError(
                f"verdict/label mismatch for {self.findingId}: "
                f"{self.verdict!r} should imply label {want!r}, got {self.label!r}"
            )
        return self
