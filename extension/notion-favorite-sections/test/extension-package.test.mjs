import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));

async function read(relativePath) {
  return readFile(`${extensionRoot}/${relativePath}`, "utf8");
}

test("manifest keeps the extension limited to Notion and local storage", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  const rootPackage = JSON.parse(await read("../../package.json"));
  const popup = await read("popup/popup.html");
  const [contentScript] = manifest.content_scripts;

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.1.9");
  assert.equal(rootPackage.version, manifest.version);
  assert.ok(popup.includes(`data-version>${manifest.version}<`));
  assert.equal(manifest.minimum_chrome_version, "111");
  assert.equal(manifest.name, "Moa");
  assert.equal(manifest.action.default_title, "Moa");
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(contentScript.matches, ["https://app.notion.com/*"]);
  assert.deepEqual(contentScript.css, ["src/content.css"]);
  assert.deepEqual(contentScript.js, [
    "src/favorite-tree-model.js",
    "src/profile-catalog.js",
    "src/notion-sidebar-adapter.js",
    "src/favorite-tree-view.js",
    "src/moa-brand.js",
    "src/notion-tree-panel.js",
    "src/content.js",
  ]);

  await Promise.all(
    [...contentScript.js, ...contentScript.css].map((path) => read(path)),
  );
});

test("content keeps native Favorites visible and cleans legacy replacement markers", async () => {
  const css = await read("src/content.css");
  const content = await read("src/content.js");

  assert.match(
    css,
    /\[data-notion-favorite-sections-native-hidden\][^{]*\{[^}]*display:\s*none\s*!important/isu,
  );
  assert.match(content, /restoreLegacyFavoritesInjection/u);
  assert.match(content, /row\.removeAttribute\(hiddenAttribute\)/u);
  assert.doesNotMatch(content, /setNativeRowsVisible\([^,]+,\s*false\)/u);
});

test("runtime code contains no remote I/O or unsafe HTML execution primitives", async () => {
  const paths = [
    "src/background.js",
    "src/content.js",
    "src/favorite-tree-model.js",
    "src/favorite-tree-view.js",
    "src/moa-brand.js",
    "src/notion-tree-panel.js",
    "src/notion-sidebar-adapter.js",
    "src/profile-catalog.js",
    "src/storage-contract.js",
    "popup/popup.js",
  ];
  const source = (await Promise.all(paths.map((path) => read(path)))).join("\n");

  for (const forbidden of [
    /\.innerHTML\s*=/u,
    /\beval\s*\(/u,
    /\bnew\s+Function\b/u,
    /\bfetch\s*\(/u,
    /\bXMLHttpRequest\b/u,
    /\bWebSocket\b/u,
    /document\.cookie/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
