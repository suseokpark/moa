import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogAction, createCatalog, flattenGroups, SYSTEM_GROUP_ID } from "../src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY } from "../src/favmoa-service.js";

const LIB = "library-personal";
const group = (id, groups = [], collapsed = true) => ({ id, name: id, groups, links: [], collapsed });
const inputLinks = [
  { title: "📚 Product reference", url: "https://app.notion.com/p/example/Product-0123456789abcdef0123456789abcdef?view=board#details", icon: "📚" },
  { title: "Shared folder", url: "https://drive.google.com/drive/u/0/folders/example-folder?usp=sharing", icon: "🗂️" },
  { title: "Web reference", url: "https://example.com/reference?lang=ko#outline", icon: "" }
];
function catalog() {
  const value = createCatalog();
  value.libraries[0].groups.push(group("parent", [group("target"), group("sibling")]));
  value.libraries.push({ id: "other-library", name: "Other", groups: [group("other-target")] });
  return value;
}
const find = (value, id) => flattenGroups(value.libraries[0]).find(item => item.group.id === id).group;
const action = values => ({ type: "addLinks", libraryId: LIB, groupId: "target", links: inputLinks, revealTarget: true, ...values });

test("open-tab batch addition preserves exact route, metadata and order while revealing only the destination path", () => {
  const before = catalog(), original = structuredClone(before);
  const result = applyCatalogAction(before, action());
  const saved = find(result, "target").links;
  assert.deepEqual(saved.map(({ title, url, icon }) => ({ title, url, icon })), inputLinks);
  assert.deepEqual(saved.map(link => link.provider), ["notion", "google-drive", "generic"]);
  assert.deepEqual(saved.map(link => link.resourceId), ["0123456789abcdef0123456789abcdef", "example-folder", undefined]);
  assert.equal(new Set(saved.map(link => link.id)).size, 3);
  assert.equal(find(result, "parent").collapsed, false);
  assert.equal(find(result, "target").collapsed, false);
  assert.equal(find(result, "sibling").collapsed, true);
  assert.deepEqual(result.libraries[1], before.libraries[1]);
  assert.deepEqual(before, original);
});

test("existing bulk import behavior preserves folds unless revealTarget is explicitly true", () => {
  for (const revealTarget of [undefined, false]) {
    const command = action({ revealTarget });
    if (revealTarget === undefined) delete command.revealTarget;
    const result = applyCatalogAction(catalog(), command);
    assert.equal(find(result, "parent").collapsed, true);
    assert.equal(find(result, "target").collapsed, true);
  }
});

test("batch reveal option, destination, malformed entries and oversized input fail without changing source data", () => {
  const before = catalog(), original = structuredClone(before);
  for (const changes of [
    { revealTarget: "true" }, { revealTarget: 1 }, { revealTarget: null },
    { groupId: "other-target" }, { groupId: "missing" }, { libraryId: "missing" },
    { sectionId: "obsolete" }, { links: [] }, { links: new Array(2) },
    { links: [inputLinks[0], { title: "Bad address", url: "javascript:alert(1)" }] },
    { links: [inputLinks[0], { title: "", url: "https://example.com/empty-title" }] },
    { links: Array.from({ length: 1001 }, (_, i) => ({ title: `Tab ${i}`, url: `https://example.org/tab-${i}` })) }
  ]) {
    assert.throws(() => applyCatalogAction(before, action(changes)));
    assert.deepEqual(before, original);
  }
});

const sender = { id: "extension-test", url: "chrome-extension://extension-test/sidepanel/sidepanel.html" };
function fixture(input = catalog()) {
  const data = { [FAVMOA_STORAGE_KEY]: { revision: 7, catalog: structuredClone(input) } };
  const writes = [];
  const storage = {
    async setAccessLevel() {},
    async get(keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])])); },
    async set(values) { writes.push(structuredClone(values)); Object.assign(data, structuredClone(values)); }
  };
  const service = createCatalogService({ storage, runtimeId: sender.id });
  return {
    data, writes, storage,
    add: (changes = {}, expectedRevision = 7) => service.handle({ type: "FAVMOA_ACTION", action: action(changes), expectedRevision }, sender),
    undo: expectedRevision => service.handle({ type: "FAVMOA_UNDO", expectedRevision }, sender)
  };
}

test("one selected-tab batch uses one write, one revision and one undo including destination folds", async () => {
  const before = catalog(), f = fixture(before);
  const added = await f.add();
  assert.equal(added.ok, true); assert.equal(added.revision, 8); assert.equal(added.canUndo, true);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(Object.keys(f.writes[0]).sort(), [FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY].sort());
  assert.deepEqual(f.data[FAVMOA_UNDO_KEY], { catalog: before, revertsRevision: 8 });
  assert.equal(find(added.catalog, "target").links.length, 3);
  assert.equal(find(added.catalog, "parent").collapsed, false);
  const undone = await f.undo(8);
  assert.equal(undone.ok, true); assert.equal(undone.revision, 9); assert.equal(undone.canUndo, false);
  assert.deepEqual(undone.catalog, before);
  assert.equal((await f.undo(9)).code, "NOTHING_TO_UNDO");
});

test("logical duplicates within an open-tab batch or the library reject the whole batch and preserve prior undo", async () => {
  const initial = applyCatalogAction(catalog(), action({ groupId: SYSTEM_GROUP_ID, links: [inputLinks[0]], revealTarget: false }));
  const duplicates = [
    [inputLinks[2], { title: "Another route to saved page", url: "https://www.notion.so/0123456789abcdef0123456789abcdef" }],
    [inputLinks[2], { title: "Same web route", url: inputLinks[2].url }]
  ];
  for (const links of duplicates) {
    const f = fixture(initial);
    f.data[FAVMOA_UNDO_KEY] = { catalog: catalog(), revertsRevision: 7 };
    const before = structuredClone(f.data);
    const result = await f.add({ links });
    assert.equal(result.code, "INVALID_DATA"); assert.equal(f.writes.length, 0);
    assert.deepEqual(f.data, before);
    assert.equal(find(f.data[FAVMOA_STORAGE_KEY].catalog, "target").links.length, 0);
  }
});

test("stale tab-dialog revision cannot partially add links or overwrite a newer catalog", async () => {
  const f = fixture(), before = structuredClone(f.data);
  const conflict = await f.add({}, 6);
  assert.equal(conflict.code, "CONFLICT"); assert.equal(conflict.revision, 7);
  assert.deepEqual(f.data, before); assert.equal(f.writes.length, 0);
  const [first, second] = await Promise.all([f.add(), f.add({ links: [{ title: "Other change", url: "https://example.org/other" }] })]);
  assert.equal(first.ok, true); assert.equal(second.code, "CONFLICT");
  assert.equal(f.writes.length, 1);
  assert.deepEqual(find(second.catalog, "target").links.map(link => link.url), inputLinks.map(link => link.url));
});

test("failed tab-batch save leaves catalog and undo unchanged and the same request can be retried", async () => {
  const f = fixture(), before = structuredClone(f.data), save = f.storage.set;
  f.storage.set = async () => { throw new Error("storage quota exceeded"); };
  const failed = await f.add();
  assert.equal(failed.code, "SAVE_FAILED"); assert.deepEqual(f.data, before); assert.equal(f.writes.length, 0);
  f.storage.set = save;
  const retried = await f.add();
  assert.equal(retried.ok, true); assert.equal(retried.revision, 8); assert.equal(f.writes.length, 1);
  assert.deepEqual(find(retried.catalog, "target").links.map(link => link.url), inputLinks.map(link => link.url));
});
