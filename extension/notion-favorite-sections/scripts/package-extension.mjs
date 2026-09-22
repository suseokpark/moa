#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EXTENSION_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPOSITORY_ROOT = path.resolve(EXTENSION_ROOT, "..", "..");
const FIXED_DOS_DATE = 0x0021;
const FIXED_DOS_TIME = 0;
const UTF8_FLAG = 0x0800;

function fail(message) {
  throw new Error(`Extension package error: ${message}`);
}

function comparePackagePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validatePackagePath(value, fromPath = "manifest.json") {
  if (typeof value !== "string" || value.length === 0) {
    fail(`Invalid empty resource path referenced by ${fromPath}.`);
  }
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) {
    fail(`Unsafe resource path ${JSON.stringify(value)} referenced by ${fromPath}.`);
  }

  const normalized = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromPath), value)
  );
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    fail(`Resource path ${JSON.stringify(value)} escapes the extension root.`);
  }
  return normalized;
}

function validateIconMap(icons, field, requiredSizes) {
  if (!icons || typeof icons !== "object" || Array.isArray(icons)) {
    fail(`${field} must contain an icon size-to-path map.`);
  }
  for (const size of requiredSizes) {
    if (!Object.prototype.hasOwnProperty.call(icons, size)) {
      fail(`${field} must provide the ${size}px icon.`);
    }
  }
  for (const [size, resourcePath] of Object.entries(icons)) {
    if (!/^[1-9]\d*$/u.test(size)) {
      fail(`${field} contains an invalid icon size ${JSON.stringify(size)}.`);
    }
    validatePackagePath(resourcePath);
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("manifest.json must contain an object.");
  }
  if (manifest.manifest_version !== 3) {
    fail("manifest_version must be 3.");
  }
  if (manifest.name !== "Moa") {
    fail("manifest name must be Moa.");
  }
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(manifest.version || "")) {
    fail("manifest version must contain three or four numeric components.");
  }
  if (!/^\d+$/u.test(manifest.minimum_chrome_version || "") || Number(manifest.minimum_chrome_version) < 111) {
    fail("minimum_chrome_version must be at least 111 for color-mix support.");
  }
  if (manifest.action?.default_title !== manifest.name) {
    fail("action.default_title must match the manifest name.");
  }
  validateIconMap(manifest.icons, "icons", ["16", "32", "48", "128"]);
  validateIconMap(manifest.action?.default_icon, "action.default_icon", ["16", "32"]);
  if (
    !Array.isArray(manifest.permissions) ||
    manifest.permissions.length !== 1 ||
    manifest.permissions[0] !== "storage"
  ) {
    fail("the only explicit permission must be storage.");
  }
  for (const field of [
    "host_permissions", "optional_permissions", "optional_host_permissions",
    "oauth2", "externally_connectable", "web_accessible_resources"
  ]) {
    if (Object.prototype.hasOwnProperty.call(manifest, field)) {
      fail(`${field} must remain absent.`);
    }
  }
  if (
    !manifest.background ||
    manifest.background.type !== "module" ||
    typeof manifest.background.service_worker !== "string"
  ) {
    fail("a module service worker is required.");
  }
  if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 1) {
    fail("exactly one content script declaration is required.");
  }
  const [contentScript] = manifest.content_scripts;
  if (
    !Array.isArray(contentScript.matches) ||
    contentScript.matches.length !== 1 ||
    contentScript.matches[0] !== "https://app.notion.com/*"
  ) {
    fail("content scripts must be limited to https://app.notion.com/*.");
  }
  if (contentScript.all_frames || contentScript.match_about_blank || contentScript.match_origin_as_fallback) {
    fail("content scripts must only run in the matched top-level Notion document.");
  }
  if (contentScript.world && contentScript.world !== "ISOLATED") {
    fail("content scripts must use the isolated world.");
  }

  return manifest;
}

function manifestReferences(manifest) {
  const references = [manifest.background.service_worker];
  if (manifest.action?.default_popup) references.push(manifest.action.default_popup);

  for (const contentScript of manifest.content_scripts || []) {
    references.push(...(contentScript.js || []), ...(contentScript.css || []));
  }
  for (const resourceGroup of manifest.web_accessible_resources || []) {
    references.push(...(resourceGroup.resources || []));
  }

  for (const iconSource of [manifest.icons, manifest.action?.default_icon]) {
    if (typeof iconSource === "string") references.push(iconSource);
    else if (iconSource && typeof iconSource === "object") {
      references.push(...Object.values(iconSource));
    }
  }
  return references;
}

function htmlReferences(source) {
  const references = [];
  for (const pattern of [
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu,
    /<img\b[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/giu,
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/giu
  ]) {
    for (const match of source.matchAll(pattern)) references.push(match[1]);
  }
  return references;
}

function javascriptReferences(source) {
  const references = [];
  const staticImport =
    /\b(?:import|export)\s+(?:[^;"']*?\s+from\s+)?["']([^"']+)["']/gu;
  const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  const runtimeUrl = /\bchrome\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)/gu;
  for (const pattern of [staticImport, dynamicImport, runtimeUrl]) {
    for (const match of source.matchAll(pattern)) references.push(match[1]);
  }
  return references;
}

function cssReferences(source) {
  const references = [];
  for (const match of source.matchAll(/\burl\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    const reference = match[1].trim();
    if (!reference.startsWith("data:")) references.push(reference);
  }
  return references;
}

async function readPackageFile(extensionRoot, packagePath) {
  const absolutePath = path.resolve(extensionRoot, ...packagePath.split("/"));
  const relativePath = path.relative(extensionRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    fail(`${packagePath} resolves outside the extension root.`);
  }
  const status = await lstat(absolutePath).catch(() => null);
  if (!status || !status.isFile() || status.isSymbolicLink()) {
    fail(`${packagePath} must be an existing regular file, not a symlink.`);
  }
  return readFile(absolutePath);
}

export async function collectPackageEntries({ extensionRoot = EXTENSION_ROOT } = {}) {
  const normalizedRoot = path.resolve(extensionRoot);
  const manifestBuffer = await readPackageFile(normalizedRoot, "manifest.json");
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(manifestBuffer.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) fail(`manifest.json is invalid JSON: ${error.message}`);
    throw error;
  }

  const queued = ["manifest.json"];
  const discovered = new Set(queued);
  const addReference = (reference, fromPath) => {
    const packagePath = validatePackagePath(reference, fromPath);
    if (!discovered.has(packagePath)) {
      discovered.add(packagePath);
      queued.push(packagePath);
    }
  };
  for (const reference of manifestReferences(manifest)) {
    addReference(reference, "manifest.json");
  }

  const fileData = new Map([["manifest.json", manifestBuffer]]);
  for (let index = 1; index < queued.length; index += 1) {
    const packagePath = queued[index];
    const data = await readPackageFile(normalizedRoot, packagePath);
    fileData.set(packagePath, data);
    const source = data.toString("utf8");
    const extension = path.posix.extname(packagePath).toLowerCase();
    const references =
      extension === ".html"
        ? htmlReferences(source)
        : extension === ".js" || extension === ".mjs"
          ? javascriptReferences(source)
          : extension === ".css"
            ? cssReferences(source)
            : [];
    for (const reference of references) addReference(reference, packagePath);
  }

  const paths = [...fileData.keys()].sort(comparePackagePaths);
  return {
    manifest,
    entries: paths.map((packagePath) => ({
      path: packagePath,
      data: fileData.get(packagePath)
    }))
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  if (entries.length > 0xffff) fail("ZIP contains too many files.");

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.data);
    if (name.length > 0xffff || data.length > 0xffffffff) {
      fail(`${entry.path} exceeds classic ZIP limits.`);
    }
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export async function buildExtensionPackage({
  extensionRoot = EXTENSION_ROOT,
  outputPath
} = {}) {
  const collected = await collectPackageEntries({ extensionRoot });
  const resolvedOutputPath = path.resolve(
    outputPath ||
      path.join(
        REPOSITORY_ROOT,
        "artifacts",
        `moa-v${collected.manifest.version}.zip`
      )
  );
  const archive = createZip(collected.entries);
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, archive);
  return {
    outputPath: resolvedOutputPath,
    sha256: createHash("sha256").update(archive).digest("hex"),
    size: archive.length,
    entries: collected.entries.map((entry) => entry.path),
    version: collected.manifest.version
  };
}

export async function verifyExtensionPackage({
  extensionRoot = EXTENSION_ROOT,
  artifactPath
} = {}) {
  if (!artifactPath) fail("an artifact path is required for verification.");
  const { manifest, entries } = await collectPackageEntries({ extensionRoot });
  const expected = createZip(entries);
  const resolvedPath = path.resolve(artifactPath);
  const actual = await readFile(resolvedPath);
  if (!actual.equals(expected)) {
    fail(`${resolvedPath} does not match the current v${manifest.version} source. Rebuild before distributing.`);
  }
  return {
    artifactPath: resolvedPath,
    version: manifest.version,
    sha256: createHash("sha256").update(actual).digest("hex"),
    entries: entries.map((entry) => entry.path)
  };
}

function usage() {
  return [
    "Usage: node scripts/package-extension.mjs [--check | --verify PATH | --output PATH]",
    "  --check        Validate the manifest and runtime allowlist without writing a ZIP.",
    "  --output PATH  Write the deterministic ZIP to a custom path.",
    "  --verify PATH  Verify an existing ZIP exactly matches the current runtime source."
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  let checkOnly = false;
  let outputPath;
  let artifactPath;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") checkOnly = true;
    else if (argument === "--output") {
      outputPath = args[index + 1];
      if (!outputPath) fail("--output requires a path.");
      index += 1;
    } else if (argument === "--verify") {
      artifactPath = args[index + 1];
      if (!artifactPath) fail("--verify requires a path.");
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      return;
    } else {
      fail(`Unknown argument ${JSON.stringify(argument)}.\n${usage()}`);
    }
  }
  if (checkOnly && outputPath) fail("--check and --output cannot be used together.");
  if (artifactPath && (checkOnly || outputPath)) fail("--verify cannot be combined with --check or --output.");

  if (artifactPath) {
    const result = await verifyExtensionPackage({ artifactPath });
    console.log(`Artifact matches current source: Moa v${result.version}, ${result.entries.length} files.`);
    console.log(`SHA-256 ${result.sha256}`);
    return;
  }

  if (checkOnly) {
    const { manifest, entries } = await collectPackageEntries();
    console.log(`Package integrity OK: Moa v${manifest.version}, ${entries.length} files.`);
    for (const entry of entries) console.log(entry.path);
    return;
  }

  const result = await buildExtensionPackage({ outputPath });
  console.log(`Created ${result.outputPath}`);
  console.log(`SHA-256 ${result.sha256}`);
  console.log(`Size ${result.size} bytes`);
  for (const entry of result.entries) console.log(entry);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
