// Module-resolution hook: make `@memberry/core` loadable from a plain node script.
//
// WHY THIS IS NEEDED. Every workspace package publishes
//   "exports": { ".": { "import": "./src/index.ts", "default": "./src/index.ts" } }
// so `@memberry/core` resolves to TypeScript source. Node >= 22.18 strips types, but it does not
// rewrite specifiers, and `packages/core/src/index.ts` imports `./types.js` — a file that exists
// only as `types.ts`. So the package name is unresolvable under plain node on EVERY version, not
// just node 20. The built `dist/` is fine; only the package-name entry point is not.
//
// WHY A SHIM RATHER THAN dist/index.js. Aliasing to `packages/core/dist/index.js` reintroduces
// the problem one level down: it re-exports `services-factory.js`, which imports `@memberry/redis`
// by package name. The shim exports only the two symbols the neo4j dist actually needs.
//
// SCOPE. `packages/neo4j/dist/query.js` imports exactly `readEnv` and `DEFAULT_TENANT` from
// `@memberry/core`; `packages/neo4j/dist/fact.js` imports nothing from it. Both target modules
// below are self-contained (node builtins only), so this pulls in no further graph.
//
// This changes resolution for the probe process only. It is not a build step and nothing in the
// product reads it.

const ROOT = new URL('../../', import.meta.url);

const SHIM = [
  `export { readEnv } from ${JSON.stringify(new URL('packages/core/dist/config/settings.js', ROOT).href)};`,
  `export { DEFAULT_TENANT } from ${JSON.stringify(new URL('packages/core/dist/types.js', ROOT).href)};`,
].join('\n');

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@memberry/core') {
    return {
      url: `data:text/javascript,${encodeURIComponent(SHIM)}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
