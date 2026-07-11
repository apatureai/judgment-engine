// Tailwind v3 ships `resolveConfig.js` + `resolveConfig.d.ts` but does not expose
// a NodeNext-resolvable types condition for the aliased `tailwindcss-v3/resolveConfig.js`
// subpath. Declare the minimal signature we use (resolve -> resolved theme).
declare module "tailwindcss-v3/resolveConfig.js" {
  export default function resolveConfig(config: unknown): { theme: Record<string, unknown> };
}
