import { parse } from "yaml";
import { isRecord } from "./guards.js";

/**
 * `.designreview.yml` brand-block extraction (TRD §6) — the highest-leverage
 * human-written context. The brand dimension is suppressed entirely when the
 * block is absent (`extractBrandBlock` returns null), so the critique never
 * invents brand-fit findings without a stated brand.
 */
export interface BrandBlock {
  description: string | null;
  tone: string | null;
  audience: string | null;
  do: string[];
  dont: string[];
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function asStringList(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((s) => s.trim());
  return [];
}


/** Parse and normalize the `brand:` block from `.designreview.yml`. Null when absent/invalid. */
export function extractBrandBlock(designReviewYml: string): BrandBlock | null {
  let doc: unknown;
  try {
    doc = parse(designReviewYml);
  } catch {
    return null; // invalid YAML -> degrade, suppress brand dimension
  }
  if (!isRecord(doc) || !isRecord(doc.brand)) return null;

  const brand = doc.brand;
  const block: BrandBlock = {
    description: asString(brand.description),
    tone: asString(brand.tone),
    audience: asString(brand.audience),
    do: asStringList(brand.do),
    // accept several spellings for the don't list
    dont: asStringList(brand.dont ?? brand["don't"] ?? brand.donts ?? brand.do_not),
  };

  // An empty `brand:` (all fields blank) is treated as absent.
  const hasContent =
    block.description !== null ||
    block.tone !== null ||
    block.audience !== null ||
    block.do.length > 0 ||
    block.dont.length > 0;
  return hasContent ? block : null;
}

/** Whether the brand dimension should be scored (only when a brand block exists). */
export function brandDimensionEnabled(brand: BrandBlock | null): boolean {
  return brand !== null;
}
