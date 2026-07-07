/**
 * Property-based laws for the content-addressed dataset export. The dataset
 * version IS the integrity anchor of the preference-tuple moat (and the byte
 * contract the Python mirror re-derives, #127), so these hold over generated
 * tuples, not just fixtures:
 *
 *  - canonicalJson is a stable canonical form: key-order-independent, and a
 *    fixed point under parse→re-canonicalize.
 *  - buildDvcDataset is deterministic, input-order-independent, and its
 *    version moves iff content moves (including any single-field edit).
 *  - removeSubject preserves the content addresses of every surviving object
 *    (the GDPR-erasure guarantee that previously-pushed objects stay valid).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildDvcDataset, canonicalJson, removeSubject } from "../src/dvc-export.js";
import type { PreferenceExample } from "../src/preference-export.js";

const RUNS = { numRuns: 200 };

const slug = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-".split("")),
  minLength: 1,
  maxLength: 16,
});

const exampleArb: fc.Arbitrary<PreferenceExample> = fc.record({
  findingId: slug,
  installationId: slug,
  promptVersion: slug,
  imageRef: fc.option(slug, { nil: null }),
  contextHash: fc.option(slug, { nil: null }),
  finding: fc.record({
    dimension: fc.constantFrom(
      "visual_hierarchy",
      "spacing",
      "color_contrast",
      "typography",
      "consistency",
      "responsiveness",
      "accessibility",
      "brand",
    ),
    severity: fc.constantFrom("nit", "minor", "major", "blocker"),
    route: slug,
    viewport: fc.constantFrom("mobile", "tablet", "desktop"),
    elementRef: fc.option(slug, { nil: null }),
  }),
  verdict: fc.constantFrom("endorsed", "dismissed"),
  label: fc.constantFrom("desirable", "undesirable"),
  source: fc.constantFrom("thumbs", "ignore", "implicit"),
  trainingGrade: fc.boolean(),
}) as fc.Arbitrary<PreferenceExample>;

/** Tuples with unique (promptVersion, findingId) so relpaths cannot collide. */
const distinctExamples = fc
  .array(exampleArb, { minLength: 1, maxLength: 12 })
  .map((xs) => {
    const seen = new Set<string>();
    return xs.filter((x) => {
      const key = `${x.promptVersion}/${x.findingId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })
  .filter((xs) => xs.length > 0);

describe("canonicalJson properties", () => {
  it("is key-order independent", () => {
    fc.assert(
      fc.property(exampleArb, (ex) => {
        const reversed = Object.fromEntries(Object.entries(ex).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(ex));
      }),
      RUNS,
    );
  });

  it("is a fixed point under parse → re-canonicalize", () => {
    fc.assert(
      fc.property(exampleArb, (ex) => {
        const once = canonicalJson(ex);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
      }),
      RUNS,
    );
  });
});

describe("buildDvcDataset properties", () => {
  it("is deterministic and independent of input tuple order", () => {
    fc.assert(
      fc.property(distinctExamples, (examples) => {
        const a = buildDvcDataset(examples);
        const b = buildDvcDataset([...examples].reverse());
        expect(b.version).toBe(a.version);
        expect(b.dir).toEqual(a.dir);
      }),
      RUNS,
    );
  });

  it("version moves iff content moves (single-field edit changes the address)", () => {
    fc.assert(
      fc.property(distinctExamples, (examples) => {
        const base = buildDvcDataset(examples);
        expect(buildDvcDataset(examples.map((e) => ({ ...e }))).version).toBe(base.version);
        const [first, ...rest] = examples as [PreferenceExample, ...PreferenceExample[]];
        const flipped: PreferenceExample = {
          ...first,
          verdict: first.verdict === "endorsed" ? "dismissed" : "endorsed",
        };
        expect(buildDvcDataset([flipped, ...rest]).version).not.toBe(base.version);
      }),
      RUNS,
    );
  });

  it("every object's md5 addresses exactly its canonical content (32-hex)", () => {
    fc.assert(
      fc.property(distinctExamples, (examples) => {
        const ds = buildDvcDataset(examples);
        expect(ds.objects.length).toBe(examples.length);
        for (const obj of ds.objects) {
          expect(obj.md5).toMatch(/^[0-9a-f]{32}$/);
          expect(canonicalJson(JSON.parse(obj.content))).toBe(obj.content);
        }
        // Distinct contents never share an address within a dataset.
        const byMd5 = new Map(ds.objects.map((o) => [o.md5, o.content]));
        for (const obj of ds.objects) expect(byMd5.get(obj.md5)).toBe(obj.content);
      }),
      RUNS,
    );
  });

  it("removeSubject keeps every surviving object's content address (erasure law)", () => {
    fc.assert(
      fc.property(distinctExamples, fc.nat(), (examples, seed) => {
        const victim = examples[seed % examples.length] as PreferenceExample;
        const before = buildDvcDataset(examples);
        const after = removeSubject(examples, (ex) => ex.installationId === victim.installationId);
        const beforeByPath = new Map(before.objects.map((o) => [o.relpath, o.md5]));
        for (const obj of after.objects) {
          expect(obj.md5).toBe(beforeByPath.get(obj.relpath));
          expect(
            examples.some(
              (ex) => ex.installationId === victim.installationId && `${ex.promptVersion}/${ex.findingId}.json` === obj.relpath,
            ),
          ).toBe(false);
        }
      }),
      RUNS,
    );
  });
});
