import type { Viewport } from "./findings.js";

/**
 * Capture sandbox contract (TRD §4, §5). Everything runs behind
 * `captureInSandbox(url, ctx)`: one Firecracker microVM per job; the in-VPC
 * path runs the same interface in the customer cloud. Implementations own
 * Playwright, the readiness/stability protocol, egress policy, and storageState.
 */
export interface CaptureContext {
  installationId: string;
  /** Viewports to capture (TRD §4: 3 viewports at DSF 2 by default). */
  viewports: Viewport[];
  darkMode: boolean;
  /** Name of the KMS-stored storageState secret; decrypted in-VM only. */
  authStateSecretName?: string | null;
  /** Name of the KMS-stored protection-bypass secret. */
  protectionBypassSecretName?: string | null;
  /** storageState/auth is disabled when true (fork PRs). */
  isFork: boolean;
  /** Routes to capture. */
  routes: string[];
}

export interface CaptureImage {
  route: string;
  viewport: Viewport;
  /** Object-storage key for the screenshot (engine-owned bucket). */
  objectKey: string;
  width: number;
  height: number;
}

/** Recorded DOM geometry; element refs are grounded in real rects, not VLM pixels. */
export interface GeometryRect {
  route: string;
  viewport: Viewport;
  selector: string;
  role: string | null;
  rect: { x: number; y: number; width: number; height: number };
}

export interface PageHealth {
  consoleErrors: number;
  failedRequests: number;
  /** True when perceptual + structural hashes flag the page as unstable. */
  unstable: boolean;
  /**
   * Web fonts that did not finish loading after `document.fonts.ready` (#83).
   * The browser silently substituted a fallback, which `fonts.ready` can't
   * distinguish from a real font bug. Recorded so a substituted font is a
   * footnote, not a hallucinated "broken text" finding. Defaults to 0.
   */
  blockedFonts?: number;
}

export interface Capture {
  images: CaptureImage[];
  geometry: GeometryRect[];
  pageHealth: PageHealth;
  captureVersion: string;
}

/** The capture seam (TRD §4). */
export type CaptureInSandbox = (url: string, ctx: CaptureContext) => Promise<Capture>;
