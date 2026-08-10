import type { PassModelOverrides } from "./registry.js";

/**
 * Billing-tier model selection (TRD §6.1, #35). The free / high-volume tier runs
 * the deep pass on the cheaper `qwen3-vl-flash` (non-thinking Instruct), reserving
 * `qwen3-vl-plus` Thinking for paid/blocking reviews. This is a config-only swap:
 * it returns `PassModelOverrides` for `critique()` / `runDeepPass`, so no call
 * site changes, and it composes with the per-pass abstraction (#26).
 */
export type BillingTier = "free" | "paid";

/** Free tier: deep pass swaps to flash (Instruct, non-thinking) to cut cost. */
export const FREE_TIER_PASS_MODELS: PassModelOverrides = {
  deep: { model: "qwen3-vl-flash", thinking: false },
};

/** Per-pass model overrides for a billing tier (paid = defaults, free = flash deep pass). */
export function passModelsForTier(tier: BillingTier): PassModelOverrides {
  return tier === "free" ? FREE_TIER_PASS_MODELS : {};
}
