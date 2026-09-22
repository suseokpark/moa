import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../src/moa-brand.js";

// Normal development: install sharp, then run npm run build:extension-icons.
// A preinstalled renderer can be supplied without installing extra dependencies:
// MOA_SHARP_MODULE=/absolute/path/to/sharp node scripts/build-brand-assets.mjs
const require = createRequire(import.meta.url);
const sharp = require(process.env.MOA_SHARP_MODULE || "sharp");
const output = fileURLToPath(new URL("../icons/", import.meta.url));
const { brand } = globalThis.NotionFavoriteSections;
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "moa-mark.svg"), brand.toSvg());
for (const size of [16, 32, 48, 128]) {
  await sharp(Buffer.from(brand.toSvg({ tile: true })), { density: 384 })
    .resize(size, size)
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toFile(resolve(output, `moa-${size}.png`));
}
console.log(`Moa: SVG and 16/32/48/128px PNG icons exported to ${output}`);
