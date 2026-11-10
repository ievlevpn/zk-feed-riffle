// Builds the plugin: bundles src/main.ts and what it imports (npm packages too) into one ES
// module, dist/<id>/main.js, and copies plugin.json next to it. dist/<id>/ is the plugin folder
// to copy to /mnt/us/zotero/plugins/ on the Kindle.
//
//   node build.mjs          # this folder
//   node build.mjs <dir>    # another plugin folder laid out the same way
import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL(".", import.meta.url));
const here = (path) => resolve(dir, path);
const manifest = JSON.parse(await readFile(here("plugin.json"), "utf8"));
const out = here(`dist/${manifest.id}`);

await mkdir(out, { recursive: true });
await build({
  entryPoints: [here("src/main.ts")],
  outfile: resolve(out, manifest.main ?? "main.js"),
  bundle: true,
  format: "esm",
  target: "es2023",
  // The app is neither Node nor a browser; resolve packages like a bundler for ES modules,
  // falling back to CommonJS `main` for packages that publish only that.
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
  logLevel: "warning",
});
await copyFile(here("plugin.json"), resolve(out, "plugin.json"));
console.log(`built ${out}/`);
