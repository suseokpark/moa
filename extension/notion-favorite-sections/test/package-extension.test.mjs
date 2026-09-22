import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildExtensionPackage,
  collectPackageEntries,
  verifyExtensionPackage
} from "../scripts/package-extension.mjs";

const EXPECTED_RUNTIME_FILES = [
  "icons/moa-128.png",
  "icons/moa-16.png",
  "icons/moa-32.png",
  "icons/moa-48.png",
  "icons/moa-mark.svg",
  "manifest.json",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "src/background.js",
  "src/content.css",
  "src/content.js",
  "src/favorite-tree-model.js",
  "src/favorite-tree-view.js",
  "src/moa-brand.js",
  "src/notion-sidebar-adapter.js",
  "src/notion-tree-panel.js",
  "src/profile-catalog.js",
  "src/storage-contract.js"
];

test("package allowlist contains only manifest-reachable runtime files", async () => {
  const { manifest, entries } = await collectPackageEntries();

  assert.equal(manifest.name, "Moa");
  assert.deepEqual(
    entries.map((entry) => entry.path),
    EXPECTED_RUNTIME_FILES
  );
  assert.equal(
    entries.some((entry) => /^(?:README|scripts\/|test\/)/u.test(entry.path)),
    false
  );
});

test("release gate validates manifest and toolbar icon maps", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "moa-icon-manifest-test-"));
  try {
    await cp(new URL("..", import.meta.url), temporaryDirectory, { recursive: true });
    const manifestPath = path.join(temporaryDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const cases = [
      [{ icons: undefined }, /icons must contain an icon size-to-path map/u],
      [{ icons: [] }, /icons must contain an icon size-to-path map/u],
      [{ icons: { ...manifest.icons, 16: undefined } }, /icons must provide the 16px icon/u],
      [{ icons: { ...manifest.icons, 16: "../outside.png" } }, /escapes the extension root/u],
      [{ icons: { ...manifest.icons, 16: "https://example.com/icon.png" } }, /Unsafe resource path/u],
      [{ icons: { ...manifest.icons, small: "icons/moa-16.png" } }, /invalid icon size/u],
      [{ action: { ...manifest.action, default_icon: undefined } }, /action\.default_icon must contain an icon size-to-path map/u],
      [{ action: { ...manifest.action, default_icon: {} } }, /action\.default_icon must provide the 16px icon/u],
      [{ action: { ...manifest.action, default_icon: { ...manifest.action.default_icon, 32: null } } }, /Invalid empty resource path/u]
    ];
    for (const [mutation, expectedError] of cases) {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, ...mutation }));
      await assert.rejects(
        collectPackageEntries({ extensionRoot: temporaryDirectory }),
        expectedError
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("package rejects missing manifest, toolbar, and popup icon resources", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "moa-icon-resource-test-"));
  try {
    await cp(new URL("..", import.meta.url), temporaryDirectory, { recursive: true });
    const manifestPath = path.join(temporaryDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const cases = [
      { icons: { ...manifest.icons, 16: "icons/missing-manifest.png" } },
      { action: { ...manifest.action, default_icon: { ...manifest.action.default_icon, 16: "icons/missing-toolbar.png" } } }
    ];
    for (const mutation of cases) {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, ...mutation }));
      await assert.rejects(
        collectPackageEntries({ extensionRoot: temporaryDirectory }),
        /icons\/missing-(?:manifest|toolbar)\.png must be an existing regular file/u
      );
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    await rm(path.join(temporaryDirectory, "icons", "moa-mark.svg"));
    await assert.rejects(
      collectPackageEntries({ extensionRoot: temporaryDirectory }),
      /icons\/moa-mark\.svg must be an existing regular file/u
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("release verification rejects a stale or modified ZIP", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "notion-tree-artifact-test-"));
  try {
    const artifact = await buildExtensionPackage({ outputPath: path.join(temporaryDirectory, "release.zip") });
    const verified = await verifyExtensionPackage({ artifactPath: artifact.outputPath });
    assert.equal(verified.sha256, artifact.sha256);
    const bytes = await readFile(artifact.outputPath);
    bytes[40] ^= 1;
    await writeFile(artifact.outputPath, bytes);
    await assert.rejects(
      verifyExtensionPackage({ artifactPath: artifact.outputPath }),
      /does not match the current .* source/u
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("release gate rejects permission expansion and unsupported Chrome versions", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "notion-tree-manifest-test-"));
  try {
    const sourceRoot = new URL("..", import.meta.url);
    await cp(sourceRoot, temporaryDirectory, { recursive: true });
    const manifestPath = path.join(temporaryDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const cases = [
      { permissions: ["storage", "tabs"] },
      { optional_permissions: ["cookies"] },
      { optional_host_permissions: ["<all_urls>"] },
      { externally_connectable: { matches: ["https://example.com/*"] } },
      { minimum_chrome_version: "102" },
      { content_scripts: [{ ...manifest.content_scripts[0], all_frames: true }] },
      { content_scripts: [{ ...manifest.content_scripts[0], world: "MAIN" }] }
    ];
    for (const mutation of cases) {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, ...mutation }));
      await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /Extension package error:/u);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("package ZIP is byte-for-byte deterministic", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "notion-tree-package-test-")
  );
  try {
    const first = await buildExtensionPackage({
      outputPath: path.join(temporaryDirectory, "first.zip")
    });
    const second = await buildExtensionPackage({
      outputPath: path.join(temporaryDirectory, "second.zip")
    });
    const [firstBytes, secondBytes] = await Promise.all([
      readFile(first.outputPath),
      readFile(second.outputPath)
    ]);

    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(firstBytes, secondBytes);
    assert.deepEqual(first.entries, EXPECTED_RUNTIME_FILES);
    assert.equal(firstBytes.readUInt32LE(0), 0x04034b50);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
