/**
 * PII scan for training data (TRD §10/§12, #74). Screenshots are PII (handled by
 * consent + retention); this scans the TEXT fields of a record (context block,
 * finding evidence/suggestion) for leaked PII before it enters the cross-tenant
 * training export. Pure + deterministic. Conservative: flags common PII shapes.
 */
export interface PiiMatch {
  kind: "email" | "phone" | "credit_card" | "ssn";
  value: string;
}

const PATTERNS: { kind: PiiMatch["kind"]; re: RegExp }[] = [
  { kind: "email", re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "credit_card", re: /\b(?:\d[ -]?){13,16}\b/g },
  { kind: "phone", re: /\+?\d[\d\s().-]{8,}\d/g },
];

/** Find PII matches in a text blob. */
export function scanForPii(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) matches.push({ kind, value: m[0] });
  }
  return matches;
}

/** True when none of the provided text fields contain detectable PII. */
export function isPiiClean(...texts: (string | null | undefined)[]): boolean {
  return texts.every((t) => !t || scanForPii(t).length === 0);
}

/** A record is training-eligible only with tenant consent AND no PII in its text. */
export function trainingEligible(params: { consent: boolean; piiClean: boolean }): boolean {
  return params.consent && params.piiClean;
}
