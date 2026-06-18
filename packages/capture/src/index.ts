import type { Capture, CaptureInSandbox } from "@engine/types";

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
