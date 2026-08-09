import type { Viewport } from "@engine/types";

/**
 * The browser surface the live capture worker drives (TRD §4.1). Playwright's
 * own `Page`/`BrowserContext` types are large, overloaded and chromium-specific;
 * this port is the narrow subset capture actually uses, so:
 *
 * - `@engine/capture` has no compile-time coupling to a browser library, and
 * - the whole capture path is unit-testable against a fake page (no browser).
 *
 * `playwright-browser.ts` binds a real Chromium to this port.
 */

/** CSS-pixel viewport sizes captured for each named breakpoint (TRD §4: 3 viewports at DSF 2). */
export const VIEWPORT_SIZES: Record<Viewport, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 834, height: 1112 },
  desktop: { width: 1440, height: 900 },
};

/** Device scale factor every capture runs at. */
export const DEVICE_SCALE_FACTOR = 2;

/** Raw element record produced by the in-page extractor (pre-normalization). */
export interface ExtractedElement {
  tag: string;
  id: string | null;
  testId: string | null;
  role: string | null;
  cssPath: string;
  rect: { x: number; y: number; width: number; height: number };
  animated: boolean;
  /** Present for text-bearing elements; drives the deterministic contrast check. */
  text?: {
    fontSizePx: number;
    fontWeight: number;
    color: string;
    /**
     * `background-color` of the element and each ancestor, nearest first, up to
     * and including the first fully opaque one. Raw and unresolved on purpose:
     * flattening it is a pure decision made in `toTextNodeStyles`.
     */
    backgroundStack: string[];
    contentWidthPx: number;
  } | null;
  /** True for elements a pointer can target (button/a/input/[role=button]…). */
  interactive: boolean;
}

/** Everything one `page.evaluate` round-trip brings back. */
export interface ExtractedPage {
  elements: ExtractedElement[];
  fonts: Array<{ family: string; status: string }>;
  documentHeight: number;
  /**
   * Visible body text, truncated. UNTRUSTED (#53): it is fenced in the prompt
   * and governed by the instruction-hierarchy rule, never treated as instructions.
   */
  bodyText: string;
  /**
   * The color the root element composites over: white for the default UA canvas,
   * `null` when the page opted into a dark color-scheme and the shade is a UA
   * implementation detail. `null` propagates to "unknown backdrop", which makes
   * the contrast check stay silent instead of publishing a guess.
   */
  canvasBackground: string | null;
}

export interface CapturePage {
  /** Playwright's `page.clock` — install before navigation, pause after readiness. */
  clock: {
    install(options: { time: number }): Promise<void>;
    pauseAt(time: number): Promise<void>;
  };
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<void>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<void>;
  addStyleTag(content: string): Promise<void>;
  emulateReducedMotion(): Promise<void>;
  /** Pause every running animation (CDP playback rate 0 + Web Animations pause). */
  freezeAnimations(): Promise<void>;
  /** Evaluate a JS expression in the page and return its (JSON-serializable) value. */
  evaluate<R>(expression: string): Promise<R>;
  /** Resolve when `document.fonts.ready` resolves. */
  waitForFontsReady(): Promise<void>;
  /** Resolve after no layout shift for `quietMs`, or at `timeoutMs`. */
  waitForLayoutStable(options: { quietMs: number; timeoutMs: number }): Promise<void>;
  wait(ms: number): Promise<void>;
  screenshot(options: { fullPage: boolean }): Promise<Uint8Array>;
  /** Console messages seen so far, in order. */
  consoleEvents(): Array<{ level: string; text: string }>;
  /** Requests that failed or returned >= 400. */
  failedRequests(): Array<{ url: string; status: number | null }>;
  close(): Promise<void>;
}

export interface CaptureBrowserContext {
  newPage(): Promise<CapturePage>;
  close(): Promise<void>;
}

export interface CaptureBrowser {
  newContext(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    colorScheme: "light" | "dark";
  }): Promise<CaptureBrowserContext>;
  close(): Promise<void>;
}

/** Where captured PNG bytes are written. `ObjectStore` from `@engine/storage` satisfies it. */
export interface ScreenshotSink {
  put(key: string, body: Uint8Array, options?: { contentType?: string }): Promise<void>;
}
