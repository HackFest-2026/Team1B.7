// Copies satellite.js's UMD build into public/ so the propagation Web Worker can load it with
// importScripts(), independent of bundler worker support. Runs before dev and build.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "satellite.js");
const out = join(root, "public", "vendor");
mkdirSync(out, { recursive: true });
copyFileSync(join(src, "dist", "satellite.min.js"), join(out, "satellite.min.js"));
copyFileSync(join(src, "LICENSE.md"), join(out, "satellite.js-LICENSE.md"));
