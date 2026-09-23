import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));

async function read(relativePath) {
  return readFile(`${extensionRoot}/${relativePath}`, "utf8");
}

test("manifest retires page injection and grants only local link and optional bookmark capabilities", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  const rootPackage = JSON.parse(await read("../../package.json"));
  const popup = await read("popup/popup.html");

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.1.26");
  assert.equal(rootPackage.version, manifest.version);
  assert.ok(popup.includes(`data-version>${manifest.version}<`));
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(manifest.name, "FAVMOA");
  assert.equal(manifest.action.default_title, "FAVMOA");
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel.default_path, "sidepanel/sidepanel.html");
  assert.deepEqual(manifest.permissions, ["storage", "sidePanel", "tabs"]);
  assert.deepEqual(manifest.optional_permissions, ["bookmarks"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.oauth2, undefined);
  assert.match(popup, /JSON 내보내기·가져오기/u);
  assert.match(popup, /Google 연결과 클라우드 백업은 준비 중/u);
  assert.doesNotMatch(popup, /OAuth|Google 계정 연결.*누르고/u);
  assert.match(manifest.key, /^[A-Za-z0-9+/]+={0,2}$/u, "development installs carry a fixed public key");
  assert.ok((await read("sidepanel/sidepanel.html")).includes(`>${manifest.version}</span>`));
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
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

test("legacy and local runtime code contains no remote I/O or unsafe HTML execution primitives", async () => {
  const paths = [
    "src/notion-url.js",
    "src/background.js",
    "src/content.js",
    "src/favorite-tree-model.js",
    "src/favorite-tree-view.js",
    "src/moa-brand.js",
    "src/notion-tree-panel.js",
    "src/notion-sidebar-adapter.js",
    "src/profile-catalog.js",
    "src/storage-contract.js",
    "src/link-library.js",
    "src/link-navigation.js",
    "src/connection-view.js",
    "src/favmoa-service.js",
    "src/favmoa-platform.js",
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
