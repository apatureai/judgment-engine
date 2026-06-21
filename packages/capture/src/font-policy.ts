/**
 * Deterministic font provisioning policy for the capture microVM (TRD §4.1, #83).
 *
 * A minimal guest image ships Latin fonts only, so pages with CJK/Arabic/emoji
 * fall back to tofu (□) or wildly different metrics, and headless Chromium
 * renders glyph spacing differently from headful unless hinting is pinned. Both
 * make the VLM critique rendering artifacts that don't exist for real users
 * (hallucinated "broken text/overflow" findings — the exact failure §4.1 guards
 * against). This module is the PURE contract the guest-image build + browser
 * launch apply; the bake (`apt-get`/`fc-cache`) and the actual Chromium launch
 * are the live worker/ops seam (#11/#22), marked [~].
 */

/**
 * Fonts baked into the capture guest image for broad Unicode coverage. Pin the
 * package versions alongside the pinned Chromium version at image-build time.
 */
export const DETERMINISTIC_FONTS = [
  "Noto Sans", // Latin / general
  "Noto Sans CJK", // Chinese / Japanese / Korean
  "Noto Color Emoji", // emoji
] as const;

/**
 * Fixed fontconfig fallback order. A deterministic order means the same missing
 * glyph always resolves to the same substitute, so captures are reproducible
 * (gated by #15) instead of depending on fontconfig's host-dependent default.
 */
export const FONTCONFIG_FALLBACK_ORDER = ["Noto Sans", "Noto Sans CJK", "Noto Color Emoji"] as const;

/**
 * Chromium launch flag that stabilizes glyph metrics in headless mode
 * (puppeteer#2410). Combined with the DSF/`--force-device-scale-factor`
 * handling from #11.
 */
export const FONT_RENDER_HINTING_FLAG = "--font-render-hinting=none";

/** The Chromium launch flags this policy contributes (extended by #11's DSF flags). */
export function fontStabilityLaunchFlags(): string[] {
  return [FONT_RENDER_HINTING_FLAG];
}
