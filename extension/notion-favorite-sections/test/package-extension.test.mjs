import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildExtensionPackage,
  collectPackageEntries,
  deriveExtensionIdentity,
  verifyExtensionPackage
} from "../scripts/package-extension.mjs";

const EXPECTED_RUNTIME_FILES = [
  "icons/moa-128.png",
  "icons/moa-16.png",
  "icons/moa-32.png",
  "icons/moa-48.png",
  "icons/moa-mark.svg",
  "icons/ui/LICENSE.txt",
  "icons/ui/arrow-up-right.svg",
  "icons/ui/caret-down.svg",
  "icons/ui/caret-right.svg",
  "icons/ui/check.svg",
  "icons/ui/dots-three.svg",
  "icons/ui/magnifying-glass.svg",
  "icons/ui/plus.svg",
  "icons/ui/x.svg",
  "manifest.json",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
  "sidepanel/sidepanel.css",
  "sidepanel/sidepanel.html",
  "sidepanel/sidepanel.js",
  "src/background.js",
  "src/favmoa-platform.js",
  "src/favmoa-service.js",
  "src/feature-flags.js",
  "src/group-colors.js",
  "src/interaction-guard.js",
  "src/link-entry.js",
  "src/link-library.js",
  "src/link-navigation.js",
  "src/link-selection.js",
  "src/moa-brand.js",
  "src/notion-url.js",
  "src/storage-contract.js",
  "src/theme-settings.js",
  "src/theme-store.js",
  "src/theme.js",
  "src/tree-drag.js"
];

test("package allowlist contains only manifest-reachable runtime files", async () => {
  const { manifest, entries, identity } = await collectPackageEntries();

  assert.equal(manifest.name, "FAVMOA");
  assert.match(identity.extensionId, /^[a-p]{32}$/u);
  assert.match(identity.publicKeySha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    EXPECTED_RUNTIME_FILES
  );
  assert.equal(
    entries.some((entry) => /^(?:README|scripts\/|test\/|extension-identity\.json$)/u.test(entry.path)),
    false
  );
});

test("extension identity is derived from canonical RSA SPKI bytes using Chrome's a-p alphabet", () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const digest = createHash("sha256").update(der).digest();
  const expectedId = [...digest.subarray(0, 16)]
    .flatMap((byte) => ["abcdefghijklmnop"[byte >> 4], "abcdefghijklmnop"[byte & 15]])
    .join("");
  assert.deepEqual(deriveExtensionIdentity(der.toString("base64")), {
    extensionId: expectedId,
    publicKeySha256: digest.toString("hex")
  });
});

test("identity validation rejects absent, malformed, private, non-SPKI, weak, and non-RSA keys", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const encoded = der.toString("base64");
  const { publicKey: weakKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const { publicKey: ecKey } = generateKeyPairSync("ec", { namedCurve: "secp521r1" });
  const invalidKeys = [
    undefined, null, 123, "", "not-a-public-key", "A".repeat(8193),
    publicKey.export({ type: "spki", format: "pem" }),
    privateKey.export({ type: "pkcs8", format: "pem" }),
    privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    privateKey.export({ type: "pkcs1", format: "der" }).toString("base64"),
    publicKey.export({ type: "pkcs1", format: "der" }).toString("base64"),
    weakKey.export({ type: "spki", format: "der" }).toString("base64"),
    ecKey.export({ type: "spki", format: "der" }).toString("base64"),
    Buffer.from("invalid DER SPKI bytes".repeat(20)).toString("base64"),
    Buffer.concat([der, Buffer.from([0])]).toString("base64"),
    `${encoded}\n`, `${encoded}=`, encoded.slice(0, -1)
  ];
  for (const key of invalidKeys) {
    assert.throws(() => deriveExtensionIdentity(key), /Extension package error: manifest\.key/u);
  }
});

test("release gate requires an unchanged identity pin and refuses unapproved key rotation", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "favmoa-identity-test-"));
  try {
    await cp(new URL("..", import.meta.url), temporaryDirectory, { recursive: true });
    const manifestPath = path.join(temporaryDirectory, "manifest.json");
    const pinPath = path.join(temporaryDirectory, "extension-identity.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const pin = JSON.parse(await readFile(pinPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, key: undefined }));
    await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /manifest\.key/u);
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(manifestPath, JSON.stringify({ ...manifest,
      key: publicKey.export({ type: "spki", format: "der" }).toString("base64")
    }));
    await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /does not match the pinned extension identity/u);
    await writeFile(manifestPath, JSON.stringify(manifest));
    for (const changedPin of [
      { ...pin, extensionId: pin.extensionId === "a".repeat(32) ? "b".repeat(32) : "a".repeat(32) },
      { ...pin, publicKeySha256: "0".repeat(64) }
    ]) {
      await writeFile(pinPath, JSON.stringify(changedPin));
      await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /does not match the pinned extension identity/u);
    }
    for (const malformedPin of [null, [], {}, { ...pin, schemaVersion: 2 }, { ...pin, client_secret: "disallowed" }, { ...pin, extensionId: "bad" }, { ...pin, publicKeySha256: "bad" }]) {
      await writeFile(pinPath, JSON.stringify(malformedPin));
      await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /extension-identity\.json must pin/u);
    }
    await writeFile(pinPath, "not JSON");
    await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /extension-identity\.json must contain valid JSON/u);
    await rm(pinPath);
    await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /extension-identity\.json must be an existing regular file/u);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("moving the complete source tree preserves the extension ID and deterministic release bytes", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "favmoa-relocated-id-test-"));
  try {
    const movedRoot = path.join(temporaryDirectory, "another-computer", "different-install-folder");
    await cp(new URL("..", import.meta.url), movedRoot, { recursive: true });
    const original = await buildExtensionPackage({ outputPath: path.join(temporaryDirectory, "original.zip") });
    const relocated = await buildExtensionPackage({ extensionRoot: movedRoot, outputPath: path.join(temporaryDirectory, "relocated.zip") });
    assert.equal(relocated.extensionId, original.extensionId);
    assert.equal(relocated.publicKeySha256, original.publicKeySha256);
    assert.equal(relocated.sha256, original.sha256);
    const verified = await verifyExtensionPackage({ extensionRoot: movedRoot, artifactPath: original.outputPath });
    assert.equal(verified.extensionId, original.extensionId);
    assert.equal(verified.publicKeySha256, original.publicKeySha256);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
      { permissions: [...manifest.permissions, "cookies"] },
      { permissions: [...manifest.permissions, "identity"] },
      { optional_permissions: ["cookies"] },
      { host_permissions: ["<all_urls>"] },
      { host_permissions: ["https://www.googleapis.com/*"] },
      { host_permissions: ["https://www.googleapis.com/*", "https://drive.google.com/*"] },
      { oauth2: { client_id: "123-test.apps.googleusercontent.com", scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.appdata", "https://www.googleapis.com/auth/drive.readonly"] } },
      { oauth2: { client_id: "123-test.apps.googleusercontent.com", scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.appdata"], client_secret: "not-allowed" } },
      { oauth2: { client_id: "unconfigured", scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.appdata"] } },
      { optional_host_permissions: ["<all_urls>"] },
      { externally_connectable: { matches: ["https://example.com/*"] } },
      { key: "unapproved-key" },
      { minimum_chrome_version: "102" },
      { minimum_chrome_version: "115" },
      { action: { ...manifest.action, default_popup: "popup/popup.html" } },
      { side_panel: { default_path: "other.html" } },
      { content_scripts: [] },
      { content_scripts: [{ matches: ["https://app.notion.com/*"], js: ["src/content.js"] }] },
      { permissions: [...manifest.permissions, "scripting"] }
    ];
    for (const mutation of cases) {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, ...mutation }));
      await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /Extension package error:/u);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("local-only release gate rejects OAuth, enabling cloud, and references to deferred cloud runtime", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "favmoa-oauth-manifest-test-"));
  try {
    await cp(new URL("..", import.meta.url), temporaryDirectory, { recursive: true });
    const manifestPath = path.join(temporaryDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, oauth2: {
      client_id: "123-test.apps.googleusercontent.com",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/drive.appdata"]
    } }));
    await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /oauth2 must remain absent/u);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const flagsPath = path.join(temporaryDirectory, "src/feature-flags.js");
    const flags = await readFile(flagsPath, "utf8");
    await writeFile(flagsPath, flags.replace("CLOUD_ENABLED = false", "CLOUD_ENABLED = true"));
    await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /CLOUD_ENABLED = false/u);
    await writeFile(flagsPath, flags);
    const backgroundPath = path.join(temporaryDirectory, "src/background.js");
    const background = await readFile(backgroundPath, "utf8");
    await writeFile(backgroundPath, `${background}\nimport "./google-drive-cloud.js";\n`);
    await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /deferred source and must not be reachable/u);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("release gate prevents retired Notion UI and historical fixtures from becoming reachable", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "favmoa-retired-ui-test-"));
  try {
    await cp(new URL("..", import.meta.url), temporaryDirectory, { recursive: true });
    const backgroundPath = path.join(temporaryDirectory, "src/background.js");
    const background = await readFile(backgroundPath, "utf8");
    for (const retiredPath of ["content.js", "notion-tree-panel.js", "favorite-tree-view.js", "profile-catalog.js"]) {
      await writeFile(backgroundPath, `${background}\nimport "./${retiredPath}";\n`);
      await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /retired source/u);
    }
    await writeFile(backgroundPath, `${background}\nimport "../test/browser-suite.html";\n`);
    await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /test fixtures must not be reachable/u);
    await writeFile(backgroundPath, `${background}\nimport "../test-support/legacy-notion-background.js";\n`);
    await assert.rejects(collectPackageEntries({ extensionRoot: temporaryDirectory }), /test fixtures must not be reachable/u);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("all packaged scripts reject unsafe HTML, remote code execution, and cookie access", async () => {
  const { entries } = await collectPackageEntries();
  const scripts = entries.filter(entry => /\.m?js$/u.test(entry.path));
  for (const entry of scripts) {
    const source = entry.data.toString("utf8");
    assert.doesNotMatch(source, /\.innerHTML\s*=|\beval\s*\(|\bnew\s+Function\b|document\.cookie/u, entry.path);
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
