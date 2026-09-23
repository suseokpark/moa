import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "../src/moa-brand.js";

const { brand } = globalThis.NotionFavoriteSections;

test("FAVMOA brand has immutable approved colors and three simple mark shapes", () => {
  assert.equal(brand.name, "FAVMOA");
  assert.equal(brand.koreanName, "팹모아");
  assert.deepEqual(brand.colors, { ink: "#164C45", mint: "#A3D9C5", paper: "#F6F3EC" });
  assert.equal(brand.shapes.length, 3);
  assert.ok([brand, brand.colors, brand.shapes, ...brand.shapes].every(Object.isFrozen));
});

test("popup SVG is exactly the shared mark export, without remote references", async () => {
  const mark = await readFile(new URL("../icons/moa-mark.svg", import.meta.url), "utf8");
  assert.equal(mark, brand.toSvg());
  assert.doesNotMatch(mark, /<(?:script|image|foreignObject)|(?:href|onload)=/iu);
  assert.equal((mark.match(/<path /gu) || []).length, 3);
  const popup = await readFile(new URL("../popup/popup.html", import.meta.url), "utf8");
  assert.match(popup, /<title>FAVMOA<\/title>/u);
  assert.match(popup, /<img src="\.\.\/icons\/moa-mark\.svg"[^>]+alt=""/u);
  assert.doesNotMatch(popup, /\b(?:Link|NTree|Notion Tree)\b/u);
});

test("all packaged Chrome icons are real PNGs at the declared pixel sizes", async () => {
  for (const size of [16, 32, 48, 128]) {
    const icon = await readFile(new URL(`../icons/moa-${size}.png`, import.meta.url));
    assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(icon.subarray(12, 16).toString(), "IHDR");
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
    assert.ok(icon.length > 200, `${size}px icon cannot be an empty placeholder`);
  }
});

test("toolbar exports retain an ivory tile for visibility in either Chrome theme", () => {
  assert.match(brand.toSvg({ tile: true }), /viewBox="0 0 36 36"/u);
  assert.match(brand.toSvg({ tile: true }), /<rect width="36" height="36" rx="8" fill="#F6F3EC"\/>/u);
});
