/**
 * Component-library detection -> rubric addenda (TRD §6). Detects common
 * component libraries from package.json so the critique prompt can append a
 * library-specific rubric note (e.g. shadcn implies CSS-variable theming, MUI
 * implies its 8px spacing system). No-op when none are detected.
 */

export interface ComponentLibrary {
  id: string;
  /** Rubric note appended to the critique prompt. */
  rubricAddendum: string;
}

interface Detector {
  id: string;
  /** A dependency matches if its name equals or, for prefixes, starts with the pattern. */
  match: (depNames: Set<string>) => boolean;
  rubricAddendum: string;
}

const hasPrefix = (deps: Set<string>, prefix: string): boolean => {
  for (const d of deps) if (d === prefix || d.startsWith(prefix)) return true;
  return false;
};

const DETECTORS: Detector[] = [
  {
    id: "shadcn/ui",
    // shadcn is copy-pasted, not a package; its signature is cva + Radix primitives.
    match: (deps) => deps.has("class-variance-authority"),
    rubricAddendum:
      "shadcn/ui: components are Tailwind + CSS-variable themed over Radix primitives. " +
      "Evaluate spacing/color against the project's CSS variables and Tailwind tokens; expect Radix a11y semantics.",
  },
  {
    id: "radix",
    match: (deps) => hasPrefix(deps, "@radix-ui/"),
    rubricAddendum:
      "Radix UI: unstyled accessible primitives. Expect correct ARIA roles/states and focus management; visual styling is app-owned.",
  },
  {
    id: "mui",
    match: (deps) => hasPrefix(deps, "@mui/"),
    rubricAddendum:
      "Material UI: uses MUI's 8px spacing system, theme palette, and Material elevation. Evaluate spacing/typography against the MUI theme.",
  },
  {
    id: "chakra",
    match: (deps) => hasPrefix(deps, "@chakra-ui/"),
    rubricAddendum:
      "Chakra UI: style props + theme tokens. Evaluate spacing/color against Chakra's scale rather than raw pixel values.",
  },
  {
    id: "mantine",
    match: (deps) => hasPrefix(deps, "@mantine/"),
    rubricAddendum:
      "Mantine: theme tokens + spacing/radius scale. Evaluate against Mantine's defaults and theme overrides.",
  },
];

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Detect component libraries from a parsed package.json. Empty when none. */
export function detectComponentLibraries(pkg: PackageJsonLike): ComponentLibrary[] {
  const deps = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);

  return DETECTORS.filter((d) => d.match(deps)).map((d) => ({
    id: d.id,
    rubricAddendum: d.rubricAddendum,
  }));
}

/**
 * Every library id this engine has a rubric addendum for.
 *
 * Published because it is the vocabulary of a contract: a caller that inspects
 * a repository it holds and this engine that writes the rubric have to agree on
 * the names, and the agreement should be readable from here rather than
 * rediscovered from a review that came back ungrounded.
 */
export const COMPONENT_LIBRARY_IDS: readonly string[] = DETECTORS.map((d) => d.id);

/**
 * Resolve library ids a CALLER detected into this engine's own rubric addenda.
 *
 * The deployed service holds no checkout, so it cannot run
 * `detectComponentLibraries` itself: the only thing that can see the repository
 * is whatever asked for the review. This is the other half of that split. The
 * caller sends ids; the rubric TEXT stays owned by the engine and is never
 * accepted over the wire, so a request cannot write into the deep prompt.
 *
 * Unknown ids are dropped rather than rejected, and the result is in DETECTOR
 * order rather than caller order. Both are deliberate: a newer caller naming a
 * library this engine has no addendum for should produce a review grounded on
 * the libraries it does know, not a failed request, and the context block is a
 * prefix-cache key, so the same repository has to serialize the same way
 * whatever order the caller listed things in.
 */
export function resolveComponentLibraries(ids: readonly string[]): ComponentLibrary[] {
  const named = new Set(ids);
  return DETECTORS.filter((d) => named.has(d.id)).map((d) => ({
    id: d.id,
    rubricAddendum: d.rubricAddendum,
  }));
}
