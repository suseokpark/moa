import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog, flattenGroups } from "../src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY } from "../src/favmoa-service.js";

const libraryId = "library-personal";
const group = (id, groups = []) => ({ id, name: id, groups, links: [], collapsed: true });
const links = [{ title: "Selected reference", url: "https://example.com/selected" }];
const command = changes => ({ type: "addLinksToNewGroup", libraryId, parentGroupId: "target", name: "Imported references", links, revealTarget: true, ...changes });
const sender = { id: "import-test", url: "chrome-extension://import-test/sidepanel/sidepanel.html" };
const find = (value, id) => flattenGroups(value.libraries[0]).find(item => item.group.id === id)?.group;
function fixture() {
  const initial = createCatalog();
  initial.libraries[0].groups.push(group("parent", [group("target"), group("sibling")]));
  const data = {
    [FAVMOA_STORAGE_KEY]: { revision: 7, catalog: structuredClone(initial) },
    [FAVMOA_UNDO_KEY]: { revertsRevision: 7, catalog: createCatalog() }
  };
  const writes = [];
  let failWrites = false;
  const storage = {
    async setAccessLevel() {},
    async get(keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])])); },
    async set(values) {
      if (failWrites) throw Error("synthetic quota exceeded");
      writes.push(structuredClone(values)); Object.assign(data, structuredClone(values));
    }
  };
  const service = createCatalogService({ storage, runtimeId: sender.id });
  return {
    initial, data, writes,
    failWrites: value => { failWrites = value; },
    add: (changes = {}, expectedRevision = 7) => service.handle({ type: "FAVMOA_ACTION", action: command(changes), expectedRevision }, sender),
    action: (action, expectedRevision) => service.handle({ type: "FAVMOA_ACTION", action, expectedRevision }, sender),
    undo: expectedRevision => service.handle({ type: "FAVMOA_UNDO", expectedRevision }, sender),
    get: () => service.handle({ type: "FAVMOA_GET" }, sender)
  };
}

test("import creates group, links and revealed ancestors in one saved revision and one Undo restores everything", async () => {
  const f = fixture();
  const result = await f.add();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.revision, 8); assert.equal(result.canUndo, true);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(Object.keys(f.writes[0]).sort(), [FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY].sort());
  assert.deepEqual(f.data[FAVMOA_UNDO_KEY], { catalog: f.initial, revertsRevision: 8 });
  assert.equal(find(result.catalog, "parent").collapsed, false);
  assert.equal(find(result.catalog, "target").collapsed, false);
  assert.deepEqual(find(result.catalog, "target").groups[0].links.map(({ title, url }) => ({ title, url })), links);
  assert.deepEqual((await f.get()).catalog, result.catalog);
  const undone = await f.undo(8);
  assert.equal(undone.ok, true); assert.equal(undone.revision, 9); assert.equal(undone.canUndo, false);
  assert.deepEqual(undone.catalog, f.initial);
  assert.equal((await f.undo(9)).code, "NOTHING_TO_UNDO");
});

test("a stale import leaves the latest catalog, prior Undo and all folds intact without creating an empty group", async () => {
  const f = fixture(), before = structuredClone(f.data);
  const result = await f.add({}, 6);
  assert.equal(result.code, "CONFLICT"); assert.equal(result.revision, 7); assert.equal(result.canUndo, true);
  assert.deepEqual(result.catalog, f.initial);
  assert.deepEqual(f.data, before); assert.equal(f.writes.length, 0);
});

test("two imports based on one revision cannot create duplicate groups or partially save the losing selection", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.add(), f.add({ name: "Other references", links: [{ title: "Other", url: "https://example.com/other" }] })]);
  assert.equal(first.ok, true); assert.equal(second.code, "CONFLICT");
  assert.deepEqual(second.catalog, first.catalog);
  assert.equal(find(second.catalog, "target").groups.length, 1);
  assert.equal(f.writes.length, 1);
});

test("a failed atomic import preserves current data and prior Undo and allows a same-revision retry", async () => {
  const f = fixture(), before = structuredClone(f.data);
  f.failWrites(true);
  assert.equal((await f.add()).code, "SAVE_FAILED");
  assert.deepEqual(f.data, before); assert.equal(f.writes.length, 0);
  assert.deepEqual((await f.get()).catalog, f.initial);
  f.failWrites(false);
  const result = await f.add();
  assert.equal(result.ok, true); assert.equal(result.revision, 8);
  assert.equal(find(result.catalog, "target").groups.length, 1);
  assert.equal(f.writes.length, 1);
  assert.deepEqual((await f.undo(8)).catalog, f.initial);
});

for (const [label, changes] of [
  ["empty selection", { links: [] }],
  ["duplicate selection", { links: [...links, ...links] }],
  ["invalid final link", { links: [...links, { title: "Invalid", url: "javascript:alert(1)" }] }],
  ["missing parent", { parentGroupId: "deleted-parent" }],
  ["missing name", { name: "" }]
]) {
  test(`${label} does not create an orphan group, write a revision or replace an existing Undo`, async () => {
    const f = fixture(), before = structuredClone(f.data);
    assert.equal((await f.add(changes)).code, "INVALID_DATA");
    assert.deepEqual(f.data, before); assert.equal(f.writes.length, 0);
    const current = await f.get();
    assert.equal(current.revision, 7); assert.equal(current.canUndo, true);
    assert.deepEqual(current.catalog, f.initial);
  });
}

test("folding the newly imported group does not consume the one-step content Undo", async () => {
  const f = fixture(), added = await f.add();
  const created = find(added.catalog, "target").groups[0];
  const folded = await f.action({ type: "toggleGroup", libraryId, groupId: created.id }, 8);
  assert.equal(folded.ok, true); assert.equal(folded.canUndo, true);
  assert.equal(find(folded.catalog, created.id).collapsed, true);
  const undone = await f.undo(9);
  assert.equal(undone.ok, true); assert.deepEqual(undone.catalog, f.initial);
});
