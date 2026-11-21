// Ambient types for the test program only (test/tsconfig.json, pigeon-4ogz.34).
// `vite/client` types the `?raw` imports (d1-schema.sql, wrangler.toml, the Slack manifest) and
// `import.meta.glob`, both of which vitest resolves at runtime.
/// <reference types="vite/client" />

declare module "cloudflare:test" {
  // The bindings the pool provides are the worker's own Env (src/types.ts) plus the test-only
  // miniflare bindings in vitest.config.ts, which are already fields of Env.
  interface ProvidedEnv extends Env {}

  // The pool's MockAgent is undici's, and its Interceptable has cleanMocks() at runtime, but the
  // pool's bundled types omit it.
  interface Interceptable {
    cleanMocks(): void;
  }
}
