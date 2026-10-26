// Bundles the CLI into one file, so installing it needs no node_modules at runtime.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/factory.mjs",
  // Bundled CommonJS dependencies (yaml) call require(); give the ESM bundle one.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
