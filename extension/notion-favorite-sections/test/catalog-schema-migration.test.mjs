import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog, validateCatalog } from "../src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY, FAVMOA_RESTORE_POINT_KEY } from "../src/favmoa-service.js";

const MIGRATION_KEY = "favmoa:schema-v1-backup:v1";
const sender = { id: "migration-test", url: "chrome-extension://migration-test/sidepanel/sidepanel.html" };
const clone = value => structuredClone(value);

function versionOne(name = "v1 library") {
  return { schemaVersion: 1, libraries: [{ id: "library-personal", name, groups: [{
    id: "work", name: "Work", collapsed: true, sections: [
      { id: "system-section-uncategorized-work", name: "미분류 섹션", collapsed: false, links: [
        { id: "direct", title: "Direct document", url: "https://example.com/direct", icon: "", provider: "generic" }
      ] },
      { id: "research", name: "Research", collapsed: true, links: [
        { id: "nested", title: "Nested document", url: "https://example.com/nested", icon: "", provider: "generic" }
      ] }
    ]
  }] }], migratedLegacyKeys: [] };
}

function originals() {
  return {
    [FAVMOA_STORAGE_KEY]: { revision: 7, catalog: versionOne(), legacyEnvelopeNote: "retain exactly" },
    [FAVMOA_UNDO_KEY]: { revertsRevision: 7, catalog: versionOne("undo v1"), legacyUndoNote: "retain exactly" },
    [FAVMOA_RESTORE_POINT_KEY]: { catalog: versionOne("checkpoint v1"), legacyCheckpointNote: "retain exactly" },
    "unrelated-private-setting": "must not be archived"
  };
}

function fixture(initial = originals()) {
  const data = clone(initial);
  const writes = [];
  let rejectSet = false;
  const storage = {
    async setAccessLevel() {},
    async get(keys) {
      if (keys === null) return clone(data);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, clone(data[key])]));
    },
    async set(values) {
      writes.push(clone(values));
      if (rejectSet) throw new Error("synthetic quota failure");
      Object.assign(data, clone(values));
    }
  };
  const service = createCatalogService({ storage, runtimeId: sender.id });
  return { data, writes, storage, set rejectSet(value) { rejectSet = value; },
    send: message => service.handle(message, sender),
    rename: (name, expectedRevision = 7) => service.handle({ type: "FAVMOA_ACTION", action: { type: "renameLibrary", libraryId: "library-personal", name }, expectedRevision }, sender)
  };
}

test("v1 catalog, undo and restore checkpoint load as v2 without writing any source data", async () => {
  const initial = originals();
  const f = fixture(initial);
  const loaded = await f.send({ type: "FAVMOA_GET" });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.catalog.schemaVersion, 2);
  assert.equal(loaded.revision, 7);
  assert.equal(loaded.canUndo, true);
  assert.equal(loaded.hasRestorePoint, true);
  assert.deepEqual(loaded.catalog, validateCatalog(initial[FAVMOA_STORAGE_KEY].catalog));
  assert.deepEqual(f.data, initial);
  assert.deepEqual(f.writes, []);
});

test("first changed v2 save atomically checkpoints exact v1 catalog, undo and restore values once", async () => {
  const initial = originals();
  const f = fixture(initial);
  const changed = await f.rename("first v2 edit");
  assert.equal(changed.ok, true);
  assert.equal(changed.revision, 8);
  assert.equal(changed.catalog.schemaVersion, 2);
  assert.equal(f.writes.length, 1);
  const archive = f.data[MIGRATION_KEY];
  assert.deepEqual(archive, { fromSchemaVersion: 1, toSchemaVersion: 2, storage: {
    [FAVMOA_STORAGE_KEY]: initial[FAVMOA_STORAGE_KEY],
    [FAVMOA_UNDO_KEY]: initial[FAVMOA_UNDO_KEY],
    [FAVMOA_RESTORE_POINT_KEY]: initial[FAVMOA_RESTORE_POINT_KEY]
  } });
  assert.deepEqual(f.writes[0][MIGRATION_KEY], archive);
  assert.deepEqual(f.writes[0][FAVMOA_STORAGE_KEY], { revision: 8, catalog: changed.catalog });
  assert.deepEqual(f.data[FAVMOA_UNDO_KEY].catalog, validateCatalog(initial[FAVMOA_STORAGE_KEY].catalog));
  const again = await f.rename("second v2 edit", 8);
  assert.equal(again.ok, true);
  assert.deepEqual(f.data[MIGRATION_KEY], archive);
  assert.equal(Object.hasOwn(f.writes[1], MIGRATION_KEY), false);
});

test("normalized no-op, rejected and stale requests leave v1 sources unmodified and unarchived", async () => {
  const initial = originals();
  const f = fixture(initial);
  const unchanged = await f.send({ type: "FAVMOA_IMPORT_BACKUP", catalog: validateCatalog(versionOne()), expectedRevision: 7 });
  assert.equal(unchanged.revision, 7);
  assert.equal((await f.rename("stale", 6)).code, "CONFLICT");
  assert.equal((await f.send({ type: "FAVMOA_IMPORT_BACKUP", catalog: {}, expectedRevision: 7 })).code, "INVALID_DATA");
  assert.deepEqual(f.data, initial);
  assert.deepEqual(f.writes, []);
});

test("quota failure on migration preserves all raw values and retry includes the same checkpoint", async () => {
  const initial = originals();
  const f = fixture(initial);
  f.rejectSet = true;
  assert.equal((await f.rename("unsaved edit")).code, "SAVE_FAILED");
  assert.deepEqual(f.data, initial);
  const firstAttempt = clone(f.writes[0]);
  assert.ok(firstAttempt[MIGRATION_KEY]);
  assert.equal((await f.send({ type: "FAVMOA_GET" })).revision, 7);
  f.rejectSet = false;
  assert.equal((await f.rename("unsaved edit")).ok, true);
  assert.deepEqual(f.writes[1], firstAttempt);
});

test("concurrent first writes share one migration checkpoint and stale writer cannot change it", async () => {
  const f = fixture();
  const results = await Promise.all([f.rename("first"), f.rename("second")]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => result.code === "CONFLICT").length, 1);
  assert.equal(f.writes.length, 1);
  assert.ok(f.data[MIGRATION_KEY]);
});

test("old v1 undo remains usable and its first v2 mutation captures the consumed undo value", async () => {
  const initial = originals();
  const f = fixture(initial);
  const undone = await f.send({ type: "FAVMOA_UNDO", expectedRevision: 7 });
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.catalog, validateCatalog(initial[FAVMOA_UNDO_KEY].catalog));
  assert.equal(undone.canUndo, false);
  assert.equal(undone.hasRestorePoint, true);
  assert.equal(f.data[FAVMOA_UNDO_KEY], null);
  assert.deepEqual(f.data[MIGRATION_KEY].storage[FAVMOA_UNDO_KEY], initial[FAVMOA_UNDO_KEY]);
});

test("old v1 restore checkpoint is recoverable and archived before successful consumption", async () => {
  const initial = originals();
  const f = fixture(initial);
  const recovered = await f.send({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 7 });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.catalog, validateCatalog(initial[FAVMOA_RESTORE_POINT_KEY].catalog));
  assert.equal(recovered.hasRestorePoint, false);
  assert.equal(f.data[FAVMOA_RESTORE_POINT_KEY], null);
  assert.deepEqual(f.data[MIGRATION_KEY].storage[FAVMOA_RESTORE_POINT_KEY], initial[FAVMOA_RESTORE_POINT_KEY]);
  const undo = await f.send({ type: "FAVMOA_UNDO", expectedRevision: 8 });
  assert.deepEqual(undo.catalog, validateCatalog(initial[FAVMOA_STORAGE_KEY].catalog));
});

test("old v1 backup import becomes v2 and preserves its exact pre-import v1 storage", async () => {
  const initial = originals();
  const f = fixture(initial);
  const imported = await f.send({ type: "FAVMOA_IMPORT_BACKUP", catalog: versionOne("old file backup"), expectedRevision: 7 });
  assert.equal(imported.ok, true);
  assert.equal(imported.catalog.schemaVersion, 2);
  assert.equal(imported.catalog.libraries[0].name, "old file backup");
  assert.deepEqual(f.data[FAVMOA_RESTORE_POINT_KEY].catalog, validateCatalog(initial[FAVMOA_STORAGE_KEY].catalog));
  assert.deepEqual(f.data[MIGRATION_KEY].storage[FAVMOA_RESTORE_POINT_KEY], initial[FAVMOA_RESTORE_POINT_KEY]);
});

test("existing unreadable schema migration backup fails closed without replacing it", async () => {
  for (const archived of [null, {}, { fromSchemaVersion: 1, toSchemaVersion: 2, storage: {} },
    { fromSchemaVersion: 1, toSchemaVersion: 2, storage: { [FAVMOA_STORAGE_KEY]: { revision: -1, catalog: versionOne() } } }]) {
    const initial = { ...originals(), [MIGRATION_KEY]: archived };
    const f = fixture(initial);
    assert.equal((await f.send({ type: "FAVMOA_GET" })).ok, true);
    assert.equal((await f.rename("must not save")).code, "MIGRATION_BACKUP_INVALID");
    assert.deepEqual(f.data, initial);
    assert.deepEqual(f.writes, []);
  }
});

test("new v2 installations do not create a fictitious v1 migration archive", async () => {
  const f = fixture({ [FAVMOA_STORAGE_KEY]: { revision: 7, catalog: createCatalog() } });
  assert.equal((await f.rename("new v2 library")).ok, true);
  assert.equal(Object.hasOwn(f.data, MIGRATION_KEY), false);
});

test("a v2 current catalog with old v1 undo still checkpoints old metadata before replacement", async () => {
  const initial = originals();
  initial[FAVMOA_STORAGE_KEY].catalog = validateCatalog(initial[FAVMOA_STORAGE_KEY].catalog);
  const f = fixture(initial);
  assert.equal((await f.rename("mixed-version edit")).ok, true);
  assert.deepEqual(f.data[MIGRATION_KEY].storage[FAVMOA_UNDO_KEY], initial[FAVMOA_UNDO_KEY]);
});

test("migration archive read failure cannot overwrite source data and retry remains possible", async () => {
  const initial = originals();
  const f = fixture(initial);
  const read = f.storage.get;
  f.storage.get = async keys => {
    if (keys.includes(MIGRATION_KEY)) throw new Error("synthetic snapshot read failure");
    return read(keys);
  };
  assert.equal((await f.rename("must wait for readable backup")).code, "STORAGE_UNAVAILABLE");
  assert.deepEqual(f.data, initial);
  assert.deepEqual(f.writes, []);
  f.storage.get = read;
  assert.equal((await f.rename("retry")).ok, true);
  assert.deepEqual(f.data[MIGRATION_KEY].storage[FAVMOA_STORAGE_KEY], initial[FAVMOA_STORAGE_KEY]);
});

test("unreadable old undo is never offered, but its raw contents are included in the migration archive", async () => {
  const initial = originals();
  initial[FAVMOA_UNDO_KEY] = { revertsRevision: 7, catalog: { schemaVersion: 1, malformed: true } };
  const f = fixture(initial);
  assert.equal((await f.send({ type: "FAVMOA_GET" })).canUndo, false);
  assert.equal((await f.send({ type: "FAVMOA_UNDO", expectedRevision: 7 })).code, "NOTHING_TO_UNDO");
  assert.deepEqual(f.data, initial);
  assert.equal((await f.rename("safe edit")).ok, true);
  assert.deepEqual(f.data[MIGRATION_KEY].storage[FAVMOA_UNDO_KEY], initial[FAVMOA_UNDO_KEY]);
});

test("a first v1 fold archives exact raw sources while retaining the old content undo", async () => {
  const initial = originals();
  const f = fixture(initial);
  const folded = await f.send({ type: "FAVMOA_ACTION", expectedRevision: 7,
    action: { type: "toggleGroup", libraryId: "library-personal", groupId: "work" } });
  assert.equal(folded.ok, true);
  assert.equal(folded.revision, 8);
  assert.equal(folded.canUndo, true);
  assert.equal(folded.hasRestorePoint, true);
  assert.equal(f.writes.length, 1);
  const expectedUndo = validateCatalog(initial[FAVMOA_UNDO_KEY].catalog);
  expectedUndo.libraries[0].groups[0].collapsed = false;
  assert.deepEqual(f.data[FAVMOA_UNDO_KEY], { catalog: expectedUndo, revertsRevision: 8 });
  assert.deepEqual(f.data[FAVMOA_RESTORE_POINT_KEY], initial[FAVMOA_RESTORE_POINT_KEY]);
  const expectedArchive = { fromSchemaVersion: 1, toSchemaVersion: 2, storage: {
    [FAVMOA_STORAGE_KEY]: initial[FAVMOA_STORAGE_KEY],
    [FAVMOA_UNDO_KEY]: initial[FAVMOA_UNDO_KEY],
    [FAVMOA_RESTORE_POINT_KEY]: initial[FAVMOA_RESTORE_POINT_KEY]
  } };
  assert.deepEqual(f.writes[0][MIGRATION_KEY], expectedArchive);
  assert.deepEqual(Object.keys(f.writes[0]).sort(), [FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY, MIGRATION_KEY].sort());
  assert.equal(f.data["unrelated-private-setting"], initial["unrelated-private-setting"]);
  const undone = await f.send({ type: "FAVMOA_UNDO", expectedRevision: 8 });
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.catalog, expectedUndo);
  assert.equal(undone.canUndo, false);
  assert.deepEqual(f.data[MIGRATION_KEY], expectedArchive);
  assert.equal(Object.hasOwn(f.writes[1], MIGRATION_KEY), false);
});

test("a failed first v1 fold leaves raw data and protected undo intact until atomic retry", async () => {
  const initial = originals();
  const f = fixture(initial);
  const request = { type: "FAVMOA_ACTION", expectedRevision: 7,
    action: { type: "toggleGroup", libraryId: "library-personal", groupId: "research" } };
  f.rejectSet = true;
  assert.equal((await f.send(request)).code, "SAVE_FAILED");
  assert.deepEqual(f.data, initial);
  assert.equal((await f.send({ type: "FAVMOA_GET" })).canUndo, true);
  const attempted = clone(f.writes[0]);
  assert.deepEqual(attempted[MIGRATION_KEY].storage[FAVMOA_UNDO_KEY], initial[FAVMOA_UNDO_KEY]);
  f.rejectSet = false;
  const retry = await f.send(request);
  assert.equal(retry.ok, true);
  assert.equal(retry.canUndo, true);
  assert.deepEqual(f.writes[1], attempted);
  const expectedUndo = validateCatalog(initial[FAVMOA_UNDO_KEY].catalog);
  expectedUndo.libraries[0].groups[0].groups[0].collapsed = false;
  assert.deepEqual((await f.send({ type: "FAVMOA_UNDO", expectedRevision: 8 })).catalog, expectedUndo);
  assert.deepEqual(f.data[FAVMOA_RESTORE_POINT_KEY], initial[FAVMOA_RESTORE_POINT_KEY]);
});

test("a v1 fold does not revive unreadable undo but archives its raw value before clearing it", async () => {
  const initial = originals();
  initial[FAVMOA_UNDO_KEY] = { revertsRevision: 7, catalog: { schemaVersion: 1, malformed: true } };
  const f = fixture(initial);
  const folded = await f.send({ type: "FAVMOA_ACTION", expectedRevision: 7,
    action: { type: "toggleGroup", libraryId: "library-personal", groupId: "work" } });
  assert.equal(folded.ok, true);
  assert.equal(folded.canUndo, false);
  assert.equal(f.data[FAVMOA_UNDO_KEY], null);
  assert.deepEqual(f.data[MIGRATION_KEY].storage[FAVMOA_UNDO_KEY], initial[FAVMOA_UNDO_KEY]);
  assert.equal((await f.send({ type: "FAVMOA_UNDO", expectedRevision: 8 })).code, "NOTHING_TO_UNDO");
});

test("fold-only saves cannot bypass an unreadable pre-existing v1 migration archive", async () => {
  const initial = { ...originals(), [MIGRATION_KEY]: { malformed: true } };
  const f = fixture(initial);
  const result = await f.send({ type: "FAVMOA_ACTION", expectedRevision: 7,
    action: { type: "toggleGroup", libraryId: "library-personal", groupId: "work" } });
  assert.equal(result.code, "MIGRATION_BACKUP_INVALID");
  assert.deepEqual(f.data, initial);
  assert.deepEqual(f.writes, []);
});
