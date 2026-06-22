import type { Capture, CaptureInSandbox } from "@engine/types";

export {
  parseColor,
  relativeLuminance,
  contrastRatio,
  contrastViolations,
  overflowViolations,
  touchTargetViolations,
  deterministicChecks,
  MIN_TOUCH_TARGET_PX,
} from "./checks.js";
export type {
  Rect,
  TextNodeStyle,
  InteractiveElement,
  CheckKind,
  DeterministicFinding,
  DeterministicCheckInput,
} from "./checks.js";

export {
  PATCH_SIZE,
  DIMENSION_MULTIPLE,
  PIXEL_BUDGETS,
  fitToPixelBudget,
  fitForDepth,
  rescalePoint,
  rescaleRect,
} from "./downscale.js";
export type { ScaledDimensions, Point } from "./downscale.js";

export {
  CHROMIUM_MAX_DEVICE_PX,
  DEFAULT_TILE_OVERLAP,
  planCaptureSegments,
  planTiles,
} from "./tiling.js";
export type { CaptureSegment, Tile } from "./tiling.js";

export {
  normalizeRole,
  isLandmark,
  stableSelector,
  serializeGeometry,
  animatedExclusions,
} from "./geometry.js";
export type { RawGeometryElement, GeometryEntry } from "./geometry.js";

export {
  UNSTABLE_CONFIDENCE_CEILING,
  hammingDistance,
  hashesWithin,
  runStabilityGate,
} from "./stability.js";
export type { StabilityOptions, StabilitySample, StabilityResult } from "./stability.js";

export {
  BASELINE_SSIM_THRESHOLD,
  BASELINE_DIFF_RATIO_THRESHOLD,
  BASELINE_PHASH_THRESHOLD,
  detectBaselineChange,
  allRoutesConfirmedUnchanged,
} from "./change-detection.js";
export type {
  TileChangeScore,
  BaselineChangeInput,
  BaselineChangeOptions,
  BaselineChangeReason,
  BaselineChangeDecision,
} from "./change-detection.js";

export { CAPTURE_EPOCH_MS, PRELOAD_SKEW_MS, withDeterministicClock } from "./capture-clock.js";
export type { PageClock, CapturePhases } from "./capture-clock.js";

export {
  MOTION_FREEZE_STYLESHEET,
  REDUCED_MOTION_MEDIA,
  freezeMotionForCapture,
} from "./motion-freeze.js";
export type { MotionFreezeInjector, MotionFreezePhases } from "./motion-freeze.js";

export { isPrivateOrReservedIp, evaluateEgress, checkEgressForHost, DomainBudget } from "./egress.js";
export type { EgressPolicyOptions, EgressDecision, DomainCaps, Resolver } from "./egress.js";

export { buildPageHealth, pageHealthFootnote, blockedFonts } from "./page-health.js";
export type { ConsoleEvent, FailedRequest, PageHealthInput, FontFaceStatus } from "./page-health.js";

export {
  DETERMINISTIC_FONTS,
  FONTCONFIG_FALLBACK_ORDER,
  FONT_RENDER_HINTING_FLAG,
  fontStabilityLaunchFlags,
} from "./font-policy.js";

export { decideStorageState, scopeCookiesToOrigin, originHost } from "./storage-state.js";
export type { StorageStateDecisionInput, StorageStateDecision, Cookie } from "./storage-state.js";

/**
 * Capture sandbox seam (TRD §4). This is the EM0 scaffold stub returning a
 * deterministic shape so downstream packages can wire against the interface;
 * EM1 (#11 Playwright worker, #22 Firecracker microVM, #24/#73 egress) replaces
 * the body with the real isolated capture.
 */
export const CAPTURE_VERSION = "stub@0";

export const captureInSandbox: CaptureInSandbox = async (_url, ctx): Promise<Capture> => {
  const images = ctx.routes.flatMap((route) =>
    ctx.viewports.map((viewport) => ({
      route,
      viewport,
      objectKey: `stub/${ctx.installationId}/${route}/${viewport}.png`,
      width: 1280,
      height: 720,
    })),
  );
  return {
    images,
    geometry: [],
    pageHealth: { consoleErrors: 0, failedRequests: 0, unstable: false },
    captureVersion: CAPTURE_VERSION,
  };
};
