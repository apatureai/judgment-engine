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
