import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog, flattenGroups, SYSTEM_GROUP_ID, validateCatalog } from "../src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY, FAVMOA_RESTORE_POINT_KEY, FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY } from "../src/favmoa-service.js";

const libraryId = "library-personal";
const sender = { id: "fold-test", url: "chrome-extension://fold-test/sidepanel/sidepanel.html" };
const groupIn = (catalog, id = SYSTEM_GROUP_ID, library = libraryId) => flattenGroups(catalog.libraries.find(item => item.id === library)).find(({ group }) => group.id === id)?.group;
function initialCatalog() {
  const catalog = createCatalog();
  groupIn(catalog).links.push({ id: "test-link", title: "Travel guide", url: "https://example.org/travel", provider: "generic", icon: "" });
  return catalog;
}
function nestedCatalog() {
  const catalog = initialCatalog();
  catalog.libraries[0].groups.push({ id: "parent", name: "Research", collapsed: true, color: "#2563eb", links: [], groups: [
    { id: "child", name: "Reference", collapsed: true, links: [], groups: [] }
  ] }, { id: "destination", name: "Projects", collapsed: false, links: [], groups: [] });
  return catalog;
}
function catalogAtByteLimit(spareBytes = 0) {
  const targetBytes = 5 * 1024 * 1024 - spareBytes;
  const catalog = createCatalog();
  const group = groupIn(catalog);
  group.collapsed = true;
  let bytes = Buffer.byteLength(JSON.stringify(catalog));
  let index = 0;
  // Count each ASCII link once instead of repeatedly serializing the growing
  // 5 MiB catalog. The final URL pads to the exact UTF-8 size while staying
  // below the 4,096-character URL limit and the 10,000-link limit.
  while (targetBytes - bytes > 4050) {
    const link = { id: `limit-link-${index}`, title: "Boundary fixture", url: `https://example.org/${index}/` + "a".repeat(3800), icon: "", provider: "generic" };
    bytes += Buffer.byteLength(JSON.stringify(link)) + (index ? 1 : 0);
    group.links.push(link);
    index += 1;
  }
  const last = { id: `limit-link-${index}`, title: "Boundary fixture", url: `https://example.org/${index}/`, icon: "", provider: "generic" };
  const padding = targetBytes - bytes - Buffer.byteLength(JSON.stringify(last)) - 1;
  if (padding >= 0) {
    last.url += "b".repeat(padding);
    group.links.push(last);
  } else {
    group.links.at(-1).url += "b".repeat(targetBytes - bytes);
  }
  const validated = validateCatalog(catalog);
  assert.equal(Buffer.byteLength(JSON.stringify(validated)), targetBytes);
  return validated;
}
function fixture(catalog = initialCatalog(), extra = {}) {
  const data = structuredClone({ [FAVMOA_STORAGE_KEY]: { revision: 0, catalog }, ...extra });
  const writes = [];
  let failed = false;
  const storage = {
    async setAccessLevel() {},
    async get(keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])])); },
    async set(values) { if (failed) throw Error("test save failure"); writes.push(structuredClone(values)); Object.assign(data, structuredClone(values)); }
  };
  const send = message => create.handle(message, sender);
  const create = createCatalogService({ storage, runtimeId: sender.id });
  const revision = () => data[FAVMOA_STORAGE_KEY].revision;
  return { data, writes, send, failWrites: value => { failed = value; },
    action: (action, expectedRevision = revision()) => send({ type: "FAVMOA_ACTION", action: { libraryId, ...action }, expectedRevision }),
    fold: (groupId = SYSTEM_GROUP_ID) => send({ type: "FAVMOA_ACTION", action: { type: "toggleGroup", libraryId, groupId }, expectedRevision: revision() }),
    undo: (expectedRevision = revision()) => send({ type: "FAVMOA_UNDO", expectedRevision }) };
}

test("folding after removing a link preserves the content undo and the chosen fold", async () => {
  const f = fixture();
  const removed = await f.action({ type: "removeLink", linkId: "test-link" });
  assert.equal(removed.ok, true, removed.error);
  const folded = await f.fold();
  assert.equal(folded.ok, true);
  assert.equal(folded.canUndo, true);
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(groupIn(undone.catalog).links, groupIn(initialCatalog()).links);
  assert.equal(groupIn(undone.catalog).collapsed, true);
  assert.equal(undone.canUndo, false);
  assert.equal((await f.undo()).code, "NOTHING_TO_UNDO");
});

test("repeated nested folds preserve the last content edit and every explicit fold choice", async () => {
  const original = nestedCatalog();
  const f = fixture(original);
  assert.equal((await f.action({ type: "renameLibrary", name: "Edited library" })).ok, true);
  for (const id of ["parent", "child", "parent", "destination"]) {
    const folded = await f.fold(id);
    assert.equal(folded.ok, true, folded.error);
    assert.equal(folded.canUndo, true);
    assert.equal(f.data[FAVMOA_UNDO_KEY].revertsRevision, folded.revision);
  }
  const expected = structuredClone(original);
  groupIn(expected, "child").collapsed = false;
  groupIn(expected, "destination").collapsed = true;
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.catalog, expected);
  assert.equal(undone.canUndo, false);
});

test("folding without any content edit does not create an undo record", async () => {
  const f = fixture();
  for (let index = 0; index < 3; index += 1) {
    const folded = await f.fold();
    assert.equal(folded.ok, true);
    assert.equal(folded.canUndo, false);
    assert.equal(f.data[FAVMOA_UNDO_KEY], null);
    assert.equal((await f.send({ type: "FAVMOA_GET" })).canUndo, false);
  }
  assert.equal((await f.undo()).code, "NOTHING_TO_UNDO");
  assert.equal(f.writes.length, 3);
});

for (const [name, previous, revision = 0] of [
  ["null", null],
  ["missing snapshot", { revertsRevision: 0 }],
  ["corrupt snapshot", { revertsRevision: 0, catalog: {} }],
  ["stale revision", { revertsRevision: 0, catalog: initialCatalog() }, 1],
  ["future revision", { revertsRevision: 1, catalog: initialCatalog() }]
]) {
  test(`folding cannot revive an undo with ${name}`, async () => {
    const f = fixture(initialCatalog(), {
      [FAVMOA_STORAGE_KEY]: { revision, catalog: initialCatalog() },
      [FAVMOA_UNDO_KEY]: previous
    });
    assert.equal((await f.send({ type: "FAVMOA_GET" })).canUndo, false);
    const folded = await f.fold();
    assert.equal(folded.ok, true);
    assert.equal(folded.revision, revision + 1);
    assert.equal(folded.canUndo, false);
    assert.equal(f.data[FAVMOA_UNDO_KEY], null);
    assert.equal((await f.send({ type: "FAVMOA_GET" })).canUndo, false);
    assert.equal((await f.undo()).code, "NOTHING_TO_UNDO");
  });
}

test("fold preservation is scoped to its library even when group IDs are shared", async () => {
  const original = initialCatalog();
  original.libraries.push({ ...structuredClone(original.libraries[0]), id: "other-library", name: "Other library" });
  const f = fixture(original);
  assert.equal((await f.action({ type: "renameLibrary", name: "Changed" })).ok, true);
  assert.equal((await f.action({ type: "toggleGroup", libraryId: "other-library", groupId: SYSTEM_GROUP_ID })).ok, true);
  const expected = structuredClone(original);
  groupIn(expected, SYSTEM_GROUP_ID, "other-library").collapsed = true;
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.catalog, expected);
});

test("folding a newly added group keeps the undo that removes that group", async () => {
  const original = initialCatalog();
  const f = fixture(original);
  const added = await f.action({ type: "addGroup", name: "New group" });
  assert.equal(added.ok, true);
  const addedId = added.catalog.libraries[0].groups.find(group => group.id !== SYSTEM_GROUP_ID).id;
  const folded = await f.fold(addedId);
  assert.equal(folded.ok, true);
  assert.equal(folded.canUndo, true);
  assert.deepEqual(f.data[FAVMOA_UNDO_KEY].catalog, original);
  assert.deepEqual((await f.undo()).catalog, original);
});

test("folding a newly added library keeps the undo that removes that library", async () => {
  const original = initialCatalog();
  const f = fixture(original);
  const added = await f.action({ type: "addLibrary", name: "New library" });
  assert.equal(added.ok, true);
  const addedLibrary = added.catalog.libraries.find(item => item.id !== libraryId);
  const folded = await f.action({ type: "toggleGroup", libraryId: addedLibrary.id, groupId: SYSTEM_GROUP_ID });
  assert.equal(folded.ok, true);
  assert.equal(folded.canUndo, true);
  assert.deepEqual(f.data[FAVMOA_UNDO_KEY].catalog, original);
  assert.deepEqual((await f.undo()).catalog, original);
});

test("folding a moved child preserves its fold when undo restores the original parent", async () => {
  const original = nestedCatalog();
  const f = fixture(original);
  const moved = await f.action({ type: "moveGroup", groupId: "child", targetParentGroupId: "destination" });
  assert.equal(moved.ok, true);
  assert.equal((await f.fold("child")).ok, true);
  const expected = structuredClone(original);
  groupIn(expected, "child").collapsed = false;
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.catalog, expected);
});

test("folding a surviving child does not prevent undo from restoring a removed parent", async () => {
  const original = nestedCatalog();
  const f = fixture(original);
  assert.equal((await f.action({ type: "removeGroup", groupId: "parent" })).ok, true);
  assert.equal((await f.fold("child")).ok, true);
  const expected = structuredClone(original);
  groupIn(expected, "child").collapsed = false;
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.catalog, expected);
});

test("an explicit fold after automatic reveal uses the chosen value, not a toggled old snapshot", async () => {
  const original = nestedCatalog();
  const f = fixture(original);
  const added = await f.action({ type: "addLinks", groupId: "child", revealTarget: true, links: [
    { title: "New reference", url: "https://example.org/reference" }
  ] });
  assert.equal(added.ok, true);
  assert.equal(groupIn(added.catalog, "child").collapsed, false);
  assert.equal(groupIn(added.catalog, "parent").collapsed, false);
  const folded = await f.fold("child");
  assert.equal(folded.ok, true);
  assert.equal(groupIn(folded.catalog, "child").collapsed, true);
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.catalog, original);
});

test("undo still reverses automatic reveal when there was no explicit fold", async () => {
  const original = nestedCatalog();
  const f = fixture(original);
  const added = await f.action({ type: "addLinks", groupId: "child", revealTarget: true, links: [
    { title: "New reference", url: "https://example.org/reference" }
  ] });
  assert.equal(added.ok, true);
  assert.equal(groupIn(added.catalog, "parent").collapsed, false);
  assert.equal(groupIn(added.catalog, "child").collapsed, false);
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.catalog, original);
});

test("failed fold save preserves catalog, undo, checkpoints and unrelated data for retry", async () => {
  const checkpoint = { catalog: initialCatalog() };
  const archive = { fromSchemaVersion: 1, toSchemaVersion: 2, storage: {
    [FAVMOA_STORAGE_KEY]: { revision: 0, catalog: { schemaVersion: 1, migratedLegacyKeys: [],
      libraries: [{ id: libraryId, name: "Archived library", groups: [] }] } }
  } };
  const f = fixture(initialCatalog(), {
    [FAVMOA_RESTORE_POINT_KEY]: checkpoint,
    [FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY]: archive,
    "other-setting": "preserved"
  });
  assert.equal((await f.action({ type: "removeLink", linkId: "test-link" })).ok, true);
  const snapshot = structuredClone(f.data);
  f.failWrites(true);
  assert.equal((await f.fold()).code, "SAVE_FAILED");
  assert.deepEqual(f.data, snapshot);
  assert.equal(f.writes.length, 1);
  f.failWrites(false);
  const folded = await f.fold();
  assert.equal(folded.ok, true);
  assert.equal(folded.revision, 2);
  assert.equal(folded.canUndo, true);
  assert.equal(folded.hasRestorePoint, true);
  assert.deepEqual(Object.keys(f.writes[1]).sort(), [FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY].sort());
  assert.deepEqual(f.data[FAVMOA_RESTORE_POINT_KEY], checkpoint);
  assert.deepEqual(f.data[FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY], snapshot[FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY]);
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.equal(groupIn(undone.catalog).links.length, 1);
  assert.equal(groupIn(undone.catalog).collapsed, true);
});

test("concurrent fold and edit remain serialized and stale edits cannot replace the protected undo", async () => {
  const f = fixture();
  assert.equal((await f.action({ type: "removeLink", linkId: "test-link" })).ok, true);
  const [folded, stale] = await Promise.all([
    f.action({ type: "toggleGroup", groupId: SYSTEM_GROUP_ID }, 1),
    f.action({ type: "renameLibrary", name: "Must not save" }, 1)
  ]);
  assert.equal(folded.ok, true);
  assert.equal(folded.revision, 2);
  assert.equal(stale.code, "CONFLICT");
  assert.equal(stale.canUndo, true);
  assert.equal(f.writes.length, 2);
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.equal(undone.catalog.libraries[0].name, initialCatalog().libraries[0].name);
  assert.equal(groupIn(undone.catalog).links.length, 1);
  assert.equal(groupIn(undone.catalog).collapsed, true);
});

test("rejected and stale folds leave the protected undo byte-for-byte unchanged", async () => {
  const f = fixture();
  assert.equal((await f.action({ type: "removeLink", linkId: "test-link" })).ok, true);
  const snapshot = structuredClone(f.data);
  assert.equal((await f.fold("missing-group")).code, "INVALID_DATA");
  assert.equal((await f.action({ type: "toggleGroup", groupId: SYSTEM_GROUP_ID }, 0)).code, "CONFLICT");
  assert.deepEqual(f.data, snapshot);
  assert.equal(f.writes.length, 1);
});

test("folds after consuming undo stay non-undoable and the next edit creates a fresh undo", async () => {
  const f = fixture();
  assert.equal((await f.action({ type: "removeLink", linkId: "test-link" })).ok, true);
  assert.equal((await f.undo()).ok, true);
  const folded = await f.fold();
  assert.equal(folded.ok, true);
  assert.equal(folded.canUndo, false);
  assert.equal((await f.undo()).code, "NOTHING_TO_UNDO");
  assert.equal((await f.action({ type: "renameLibrary", name: "Fresh edit" })).canUndo, true);
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.catalog, folded.catalog);
  assert.equal(undone.canUndo, false);
});

test("a service restart retains the protected undo and its explicit fold choices", async () => {
  const f = fixture();
  assert.equal((await f.action({ type: "removeLink", linkId: "test-link" })).ok, true);
  assert.equal((await f.fold()).ok, true);
  const restarted = fixture(initialCatalog(), f.data);
  const loaded = await restarted.send({ type: "FAVMOA_GET" });
  assert.equal(loaded.revision, 2);
  assert.equal(loaded.canUndo, true);
  assert.equal(restarted.writes.length, 0);
  const undone = await restarted.undo();
  assert.equal(undone.ok, true);
  assert.equal(groupIn(undone.catalog).links.length, 1);
  assert.equal(groupIn(undone.catalog).collapsed, true);
});

test("a fold exceeding the undo byte limit saves nothing and leaves the original content recoverable", async () => {
  const original = catalogAtByteLimit();
  const f = fixture(original, { "other-setting": "preserved" });
  assert.equal((await f.action({ type: "removeLink", linkId: "limit-link-0" })).ok, true);
  const beforeFold = structuredClone(f.data);
  // true -> false adds one JSON byte to the previously valid undo catalog.
  const folded = await f.fold();
  assert.equal(folded.ok, false);
  assert.equal(folded.code, "UNDO_PROTECTION_FAILED");
  assert.deepEqual(f.data, beforeFold);
  assert.equal(f.writes.length, 1);
  const loaded = await f.send({ type: "FAVMOA_GET" });
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.canUndo, true);
  assert.equal(groupIn(loaded.catalog).collapsed, true);
  const undone = await f.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.catalog, original);
  assert.equal(undone.canUndo, false);
});

test("a fold exactly reaching the undo byte limit remains recoverable across a service restart", async () => {
  const original = catalogAtByteLimit(1);
  const f = fixture(original);
  assert.equal((await f.action({ type: "removeLink", linkId: "limit-link-0" })).ok, true);
  const folded = await f.fold();
  assert.equal(folded.ok, true, folded.error);
  assert.equal(folded.revision, 2);
  assert.equal(folded.canUndo, true);
  assert.equal(groupIn(folded.catalog).collapsed, false);
  assert.equal(Buffer.byteLength(JSON.stringify(f.data[FAVMOA_UNDO_KEY].catalog)), 5 * 1024 * 1024);
  const restarted = fixture(original, f.data);
  assert.equal((await restarted.send({ type: "FAVMOA_GET" })).canUndo, true);
  const undone = await restarted.undo();
  assert.equal(undone.ok, true, undone.error);
  const expected = structuredClone(original);
  groupIn(expected).collapsed = false;
  assert.deepEqual(undone.catalog, expected);
  assert.equal(undone.canUndo, false);
});
