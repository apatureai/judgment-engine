// Tailwind v3 ships `resolveConfig.js` + `resolveConfig.d.ts` but does not expose
// a NodeNext-resolvable types condition for the `tailwindcss/resolveConfig`
// subpath. Declare the minimal signature we use (resolve -> resolved theme).
declare module "tailwindcss/resolveConfig" {
  import type { Config } from "tailwindcss";
  export default function resolveConfig(config: Config): { theme: Record<string, unknown> };
}
