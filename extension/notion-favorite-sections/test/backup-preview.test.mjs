import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog, validateCatalog } from "../src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY, FAVMOA_RESTORE_POINT_KEY, FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY } from "../src/favmoa-service.js";
import { createPlatform } from "../src/favmoa-platform.js";

const sender = { id: "backup-preview-test", url: "chrome-extension://backup-preview-test/sidepanel/sidepanel.html" };
const clone = value => structuredClone(value);
const previewMessage = { type: "FAVMOA_PREVIEW_BACKUP" };

function catalog(name) {
  const value = createCatalog();
  value.libraries[0].name = name;
  return value;
}

function fixture(initial = {}) {
  const data = clone(initial);
  const writes = [];
  const reads = [];
  const storage = {
    async setAccessLevel() {},
    async get(keys) {
      reads.push(clone(keys));
      if (keys === null) return clone(data);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, clone(data[key])]));
    },
    async set(values) { writes.push(clone(values)); Object.assign(data, clone(values)); }
  };
  const service = createCatalogService({ storage, runtimeId: sender.id });
  return { data, reads, writes, storage, service, send: message => service.handle(message, sender) };
}

test("backup preview reads the current revision and validated recovery target without writing", async () => {
  const initial = {
    [FAVMOA_STORAGE_KEY]: { revision: 7, catalog: catalog("Current synthetic library") },
    [FAVMOA_UNDO_KEY]: { revertsRevision: 7, catalog: catalog("Undo synthetic library") },
    [FAVMOA_RESTORE_POINT_KEY]: { catalog: catalog("Recovery synthetic library") },
    "nfs:workspace:synthetic": { opaque: "legacy data must not be imported" }
  };
  const f = fixture(initial);
  const result = await f.send(previewMessage);
  assert.equal(result.ok, true);
  assert.deepEqual(result, {
    ok: true, ...initial[FAVMOA_STORAGE_KEY], canUndo: true, hasRestorePoint: true,
    restoreCatalog: initial[FAVMOA_RESTORE_POINT_KEY].catalog
  });
  assert.deepEqual(f.data, initial);
  assert.deepEqual(f.writes, []);
  assert.equal(f.reads.some(keys => keys === null), false);
  assert.equal(f.service.accepts(previewMessage), true);
  assert.equal(Object.hasOwn(await f.send({ type: "FAVMOA_GET" }), "restoreCatalog"), false);
});

test("extension preview uses the trusted service message without requesting tab or bookmark data", async () => {
  const f = fixture({
    [FAVMOA_STORAGE_KEY]: { revision: 4, catalog: catalog("Current") },
    [FAVMOA_RESTORE_POINT_KEY]: { catalog: catalog("Restore") }
  });
  const messages = [];
  const platform = createPlatform({
    chrome: { runtime: { id: sender.id, async sendMessage(message) { messages.push(clone(message)); return f.send(message); } } },
    location: { protocol: "chrome-extension:", hostname: sender.id }
  });
  const result = await platform.previewBackup();
  assert.deepEqual(messages, [previewMessage]);
  assert.equal(result.ok, true);
  assert.equal(result.revision, 4);
  assert.equal(result.restoreCatalog.libraries[0].name, "Restore");
  assert.deepEqual(f.writes, []);
});

test("demo backup preview neither saves nor emits a catalog mutation notification", async () => {
  const initial = JSON.stringify({
    [FAVMOA_STORAGE_KEY]: { revision: 4, catalog: catalog("Current demo") },
    [FAVMOA_RESTORE_POINT_KEY]: { catalog: catalog("Restore demo") }
  });
  const values = new Map([["favmoa:demo:v1", initial]]);
  const writes = [];
  const notifications = [];
  const platform = createPlatform({
    chrome: undefined, location: { protocol: "http:", hostname: "127.0.0.1" },
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => { writes.push([key, value]); values.set(key, value); } },
    eventTarget: { addEventListener() {}, removeEventListener() {} }
  });
  const unsubscribe = platform.subscribe(value => notifications.push(value));
  const result = await platform.previewBackup();
  assert.equal(result.ok, true);
  assert.equal(result.restoreCatalog.libraries[0].name, "Restore demo");
  assert.deepEqual(notifications, []);
  assert.deepEqual(writes, []);
  assert.equal(values.get("favmoa:demo:v1"), initial);
  await platform.dispatch({ type: "renameLibrary", libraryId: "library-personal", name: "Changed demo" }, 4);
  assert.equal(notifications.length, 1);
  unsubscribe();
});

for (const untrustedSender of [
  { ...sender, url: "https://example.com/page" },
  { ...sender, url: `chrome-extension://${sender.id}/popup/popup.html` },
  { ...sender, id: "other-extension" },
  null
]) test(`backup preview rejects untrusted sender ${untrustedSender?.url || "missing"}`, async () => {
  const f = fixture({ [FAVMOA_RESTORE_POINT_KEY]: { catalog: catalog("Protected recovery data") } });
  const result = await f.service.handle(previewMessage, untrustedSender);
  assert.equal(result.code, "UNTRUSTED_SENDER");
  assert.equal(Object.hasOwn(result, "restoreCatalog"), false);
  assert.equal(Object.hasOwn(result, "catalog"), false);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
});

for (const [label, checkpoint] of [
  ["missing", undefined], ["consumed", null], ["empty", {}],
  ["malformed catalog", { catalog: {} }], ["array catalog", { catalog: [] }],
  ["unsupported schema", { catalog: { ...catalog("Broken"), schemaVersion: 999 } }]
]) test(`backup preview reports ${label} checkpoint unavailable without repairing or overwriting it`, async () => {
  const initial = { [FAVMOA_STORAGE_KEY]: { revision: 6, catalog: catalog("Untouched") } };
  if (checkpoint !== undefined) initial[FAVMOA_RESTORE_POINT_KEY] = checkpoint;
  const f = fixture(initial);
  const result = await f.send(previewMessage);
  assert.equal(result.ok, true);
  assert.equal(result.revision, 6);
  assert.equal(result.hasRestorePoint, false);
  assert.equal(result.restoreCatalog, null);
  assert.deepEqual(result.catalog, initial[FAVMOA_STORAGE_KEY].catalog);
  assert.deepEqual(f.data, initial);
  assert.deepEqual(f.writes, []);
});

test("backup preview normalizes v1 catalogs without creating a migration snapshot", async () => {
  const versionOne = name => ({ schemaVersion: 1, libraries: [{ id: "library-personal", name, groups: [{
    id: "synthetic-group", name: "Synthetic group", collapsed: false, sections: [{
      id: "synthetic-section", name: "Synthetic section", collapsed: true, links: [{
        id: "synthetic-link", title: "Synthetic page", url: "https://example.com/synthetic", icon: "", provider: "generic"
      }]
    }]
  }] }], migratedLegacyKeys: [] });
  const initial = {
    [FAVMOA_STORAGE_KEY]: { revision: 9, catalog: versionOne("Current v1") },
    [FAVMOA_UNDO_KEY]: { revertsRevision: 9, catalog: versionOne("Undo v1") },
    [FAVMOA_RESTORE_POINT_KEY]: { catalog: versionOne("Restore v1") }
  };
  const f = fixture(initial);
  const result = await f.send(previewMessage);
  assert.equal(result.ok, true);
  assert.equal(result.canUndo, true);
  assert.equal(result.hasRestorePoint, true);
  assert.deepEqual(result.catalog, validateCatalog(initial[FAVMOA_STORAGE_KEY].catalog));
  assert.deepEqual(result.restoreCatalog, validateCatalog(initial[FAVMOA_RESTORE_POINT_KEY].catalog));
  assert.equal(result.catalog.schemaVersion, 2);
  assert.equal(result.restoreCatalog.schemaVersion, 2);
  assert.deepEqual(f.data, initial);
  assert.deepEqual(f.writes, []);
  assert.equal(Object.hasOwn(f.data, FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY), false);
});

test("preview is queued behind an in-flight import and observes its matching revision and checkpoint", async () => {
  const original = catalog("Original");
  const imported = catalog("Imported");
  const f = fixture({ [FAVMOA_STORAGE_KEY]: { revision: 2, catalog: original } });
  let release;
  let started;
  const gated = new Promise(resolve => { release = resolve; });
  const saving = new Promise(resolve => { started = resolve; });
  const set = f.storage.set;
  f.storage.set = async values => { started(); await gated; return set(values); };
  const importPending = f.send({ type: "FAVMOA_IMPORT_BACKUP", catalog: imported, expectedRevision: 2 });
  await saving;
  let previewFinished = false;
  const previewPending = f.send(previewMessage).then(value => { previewFinished = true; return value; });
  await Promise.resolve();
  assert.equal(previewFinished, false);
  release();
  assert.equal((await importPending).ok, true);
  const preview = await previewPending;
  assert.equal(preview.revision, 3);
  assert.deepEqual(preview.catalog, imported);
  assert.deepEqual(preview.restoreCatalog, original);
  assert.equal(preview.hasRestorePoint, true);
  assert.equal(f.writes.length, 1);
});

test("replacing a checkpoint after preview rejects both stale import and stale recovery", async () => {
  const f = fixture({ [FAVMOA_STORAGE_KEY]: { revision: 1, catalog: catalog("Original") } });
  await f.send({ type: "FAVMOA_IMPORT_BACKUP", catalog: catalog("First import"), expectedRevision: 1 });
  const preview = await f.send(previewMessage);
  assert.equal(preview.restoreCatalog.libraries[0].name, "Original");
  const second = await f.send({ type: "FAVMOA_IMPORT_BACKUP", catalog: catalog("Second import"), expectedRevision: preview.revision });
  assert.equal(second.ok, true);
  const beforeStale = clone(f.data);
  for (const message of [
    { type: "FAVMOA_IMPORT_BACKUP", catalog: catalog("Stale import") },
    { type: "FAVMOA_RESTORE_PREVIOUS_BACKUP" }
  ]) {
    const result = await f.send({ ...message, expectedRevision: preview.revision });
    assert.equal(result.code, "CONFLICT");
    assert.equal(result.revision, second.revision);
    assert.deepEqual(f.data, beforeStale);
  }
  const reviewed = await f.send(previewMessage);
  assert.equal(reviewed.restoreCatalog.libraries[0].name, "First import");
  const recovered = await f.send({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: reviewed.revision });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.catalog, reviewed.restoreCatalog);
  assert.equal(recovered.hasRestorePoint, false);
});

test("consuming a checkpoint after preview invalidates stale execution and the next preview is empty", async () => {
  const f = fixture({ [FAVMOA_STORAGE_KEY]: { revision: 1, catalog: catalog("Original") } });
  await f.send({ type: "FAVMOA_IMPORT_BACKUP", catalog: catalog("Imported"), expectedRevision: 1 });
  const preview = await f.send(previewMessage);
  const recovered = await f.send({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: preview.revision });
  assert.equal(recovered.ok, true);
  const afterRecovery = clone(f.data);
  assert.equal((await f.send({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: preview.revision })).code, "CONFLICT");
  assert.equal((await f.send({ type: "FAVMOA_IMPORT_BACKUP", catalog: catalog("Stale import"), expectedRevision: preview.revision })).code, "CONFLICT");
  assert.deepEqual(f.data, afterRecovery);
  const current = await f.send(previewMessage);
  assert.equal(current.revision, recovered.revision);
  assert.equal(current.restoreCatalog, null);
  assert.equal(current.hasRestorePoint, false);
});

test("preview is available for a new catalog and at the final writable revision without a write", async () => {
  for (const revision of [0, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(revision ? { [FAVMOA_STORAGE_KEY]: { revision, catalog: catalog("Read only") } } : {});
    const result = await f.send(previewMessage);
    assert.equal(result.ok, true);
    assert.equal(result.revision, revision);
    assert.equal(result.hasRestorePoint, false);
    assert.equal(result.restoreCatalog, null);
    assert.deepEqual(f.writes, []);
  }
});

test("an unreadable current catalog does not disclose a restore target as a usable snapshot", async () => {
  const initial = {
    [FAVMOA_STORAGE_KEY]: { revision: -1, catalog: catalog("Invalid current envelope") },
    [FAVMOA_RESTORE_POINT_KEY]: { catalog: catalog("Otherwise valid checkpoint") }
  };
  const f = fixture(initial);
  const result = await f.send(previewMessage);
  assert.equal(result.code, "CORRUPT_STORAGE");
  assert.equal(Object.hasOwn(result, "restoreCatalog"), false);
  assert.deepEqual(f.data, initial);
  assert.deepEqual(f.writes, []);
});

test("preview storage failure is sanitized and a later queued preview can recover", async () => {
  const f = fixture({ [FAVMOA_RESTORE_POINT_KEY]: { catalog: catalog("Recovery") } });
  const get = f.storage.get;
  f.storage.get = async () => { throw new Error("synthetic-sensitive-storage-detail"); };
  const failed = await f.send(previewMessage);
  assert.equal(failed.code, "STORAGE_UNAVAILABLE");
  assert.equal(JSON.stringify(failed).includes("synthetic-sensitive-storage-detail"), false);
  assert.equal(Object.hasOwn(failed, "restoreCatalog"), false);
  f.storage.get = get;
  assert.equal((await f.send(previewMessage)).hasRestorePoint, true);
  assert.deepEqual(f.writes, []);
});

test("preview requires trusted storage access even though it does not write", async () => {
  const f = fixture({ [FAVMOA_RESTORE_POINT_KEY]: { catalog: catalog("Protected checkpoint") } });
  f.storage.setAccessLevel = async () => { throw new Error("synthetic access failure"); };
  const result = await f.send(previewMessage);
  assert.equal(result.code, "STORAGE_UNAVAILABLE");
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
});

test("changing a returned preview cannot alter a later saved snapshot", async () => {
  const initial = {
    [FAVMOA_STORAGE_KEY]: { revision: 5, catalog: catalog("Current") },
    [FAVMOA_RESTORE_POINT_KEY]: { catalog: catalog("Recovery") }
  };
  const f = fixture(initial);
  const preview = await f.send(previewMessage);
  preview.catalog.libraries[0].name = "Changed only in caller";
  preview.restoreCatalog.libraries[0].name = "Changed only in caller";
  const next = await f.send(previewMessage);
  assert.deepEqual(next.catalog, initial[FAVMOA_STORAGE_KEY].catalog);
  assert.deepEqual(next.restoreCatalog, initial[FAVMOA_RESTORE_POINT_KEY].catalog);
  assert.deepEqual(f.writes, []);
});

test("extension preview keeps absent and rejected responses sanitized", async () => {
  const api = { runtime: { id: sender.id, sendMessage: async () => undefined } };
  const platform = createPlatform({ chrome: api, location: { protocol: "chrome-extension:", hostname: sender.id } });
  assert.equal((await platform.previewBackup()).code, "NO_RESPONSE");
  api.runtime.sendMessage = async () => { throw new Error("synthetic-sensitive-channel-detail"); };
  const failed = await platform.previewBackup();
  assert.equal(failed.code, "CONNECTION_FAILED");
  assert.equal(JSON.stringify(failed).includes("synthetic-sensitive-channel-detail"), false);
});
