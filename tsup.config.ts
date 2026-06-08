import { defineConfig } from "tsup";

/**
 * Dual-publish: ESM (.js) for modern bundlers + Node, CJS (.cjs) for
 * legacy require(). Types ship alongside. Target ES2022 so we keep
 * native fetch + AbortController without polyfills (Node 18+).
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  splitting: false,
  treeshake: true,
  minify: false,
});
