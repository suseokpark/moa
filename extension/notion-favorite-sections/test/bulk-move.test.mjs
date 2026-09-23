import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogAction, flattenGroups, validateCatalog } from "../src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY } from "../src/favmoa-service.js";

const LIB = "library-example";
const group = (id, links = [], groups = [], collapsed = false) => ({ id, name: `Group ${id}`, collapsed, groups, links });
const link = (id, values = {}) => ({ id, title: `Link ${id}`, url: `https://example.com/${id}`, icon: "📄", provider: "generic", ...values });
const catalog = groups => ({ schemaVersion: 2, libraries: [{ id: LIB, name: "Example library", groups }], migratedLegacyKeys: [] });
const act = (input, action) => applyCatalogAction(input, { type: "moveLinks", libraryId: LIB, ...action });
const find = (input, id) => flattenGroups(input.libraries[0]).find(item => item.group.id === id).group;

test("multi-link move appends selected links in tree order, not selection order, and preserves the source catalog", () => {
  const input = catalog([
    group("first", [link("a"), link("keep-a"), link("b")], [group("child", [link("c")])]),
    group("second", [link("d"), link("keep-d")]),
    group("target", [link("existing")])
  ]);
  const before = structuredClone(input);
  const result = act(input, { linkIds: ["d", "c", "b", "a"], targetGroupId: "target" });
  assert.deepEqual(find(result, "target").links.map(item => item.id), ["existing", "a", "b", "c", "d"]);
  assert.deepEqual(find(result, "first").links.map(item => item.id), ["keep-a"]);
  assert.deepEqual(find(result, "child").links, []);
  assert.deepEqual(find(result, "second").links.map(item => item.id), ["keep-d"]);
  assert.deepEqual(input, before);
  assert.deepEqual(validateCatalog(result), result);
});

test("multi-link move rejects malformed, empty, sparse, oversized or duplicate selections before moving any link", () => {
  const input = catalog([group("source", [link("a"), link("b")]), group("target")]);
  const before = structuredClone(input);
  for (const linkIds of [undefined, null, "a", {}, [], [""], [" "], [1], [null], ["a", "a"], ["a", " a "], ["a", "missing"], ["a", "bad\n"], ["a", "x".repeat(321)], new Array(2), Array.from({ length: 10_001 }, (_, index) => `id-${index}`)]) {
    assert.throws(() => act(input, { linkIds, targetGroupId: "target" }), undefined, `selection ${String(linkIds).slice(0, 30)}`);
    assert.deepEqual(input, before);
  }
});

test("an actual multi-link move reveals the destination and its ancestors while preserving unrelated folds", () => {
  const input = catalog([
    group("source", [link("a")], [], true),
    group("parent", [], [group("target", [link("existing")], [], true), group("sibling", [], [], true)], true)
  ]);
  const result = act(input, { linkIds: ["a"], targetGroupId: "target" });
  assert.equal(find(result, "parent").collapsed, false);
  assert.equal(find(result, "target").collapsed, false);
  assert.equal(find(result, "sibling").collapsed, true);
  assert.equal(find(result, "source").collapsed, true);
  assert.equal(find(input, "parent").collapsed, true);
});

test("multi-link move rejects obsolete sections and destinations outside the current library", () => {
  const input = catalog([group("source", [link("a")]), group("target")]);
  input.libraries.push({ id: "library-other", name: "Other", groups: [group("other-target", [link("other-link")])] });
  const before = structuredClone(input);
  for (const change of [
    { targetSectionId: "old-section" },
    { targetGroupId: "other-target" },
    { targetGroupId: "missing" },
    { targetGroupId: undefined },
    { targetGroupId: {} },
    { linkIds: ["a", "other-link"] },
    { libraryId: "missing" }
  ]) {
    assert.throws(() => act(input, { linkIds: ["a"], targetGroupId: "target", ...change }));
    assert.deepEqual(input, before);
  }
});

test("selected destination links keep their exact positions; only incoming links append", () => {
  const input = catalog([
    group("target", [link("stay-a"), link("unselected"), link("stay-b")]),
    group("source", [link("incoming-a"), link("incoming-b")])
  ]);
  const result = act(input, { linkIds: ["stay-b", "incoming-b", "stay-a", "incoming-a"], targetGroupId: "target" });
  assert.deepEqual(find(result, "target").links.map(item => item.id), ["stay-a", "unselected", "stay-b", "incoming-a", "incoming-b"]);
  assert.deepEqual(find(result, "source").links, []);
});

test("multi-link move preserves exact title, icon, destination URL, provider metadata and unrelated library data", () => {
  const notionId = "0123456789abcdef0123456789abcdef";
  const moved = [
    link("notion", { title: "📚 제품 문서", icon: "📚", url: `https://app.notion.com/p/example/${notionId}?view=board#details`, provider: "notion", resourceId: notionId }),
    link("drive", { title: "Shared specification", icon: "🗂️", url: "https://drive.google.com/drive/folders/example-folder?usp=sharing", provider: "google-drive", resourceId: "example-folder" }),
    link("web", { title: "Reference ↗", icon: "", url: "https://example.com/reference?lang=ko#outline" })
  ];
  const input = catalog([group("source", moved), { ...group("target"), color: "#236789" }]);
  input.libraries.push({ id: "library-other", name: "Other", origin: { type: "notion", workspaceKey: "example" }, groups: [group("untouched", [link("notion")], [], true)] });
  input.migratedLegacyKeys = ["nfs:workspace:example"];
  const before = structuredClone(input);
  const result = act(input, { linkIds: ["web", "drive", "notion"], targetGroupId: "target" });
  assert.deepEqual(find(result, "target").links, moved);
  assert.equal(find(result, "target").color, "#236789");
  assert.deepEqual(result.libraries[1], input.libraries[1]);
  assert.deepEqual(result.migratedLegacyKeys, input.migratedLegacyKeys);
  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(input, before);
});

test("all-already-destination selection is a full no-op, including order and collapsed paths", () => {
  const input = catalog([group("parent", [], [group("target", [link("a"), link("b"), link("c")], [], true)], true)]);
  const result = act(input, { linkIds: ["c", "a"], targetGroupId: "target" });
  assert.deepEqual(result, input);
});

const sender = { id: "extension-test", url: "chrome-extension://extension-test/sidepanel/sidepanel.html" };
function serviceFixture(input, revision = 7, undo = undefined) {
  const data = { [FAVMOA_STORAGE_KEY]: { revision, catalog: structuredClone(input) }, ...(undo ? { [FAVMOA_UNDO_KEY]: structuredClone(undo) } : {}) };
  const calls = [];
  const storage = {
    async setAccessLevel() {},
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])])); },
    async set(values) { calls.push(structuredClone(values)); Object.assign(data, structuredClone(values)); }
  };
  const { handle } = createCatalogService({ storage, runtimeId: sender.id });
  return { data, calls, storage, handle: message => handle(message, sender),
    move: (action = {}, expectedRevision = revision) => handle({ type: "FAVMOA_ACTION", expectedRevision, action: { type: "moveLinks", libraryId: LIB, linkIds: ["a", "b"], targetGroupId: "target", ...action } }, sender) };
}

test("service persists every selected move and destination fold change with one revision, one write and one undo", async () => {
  const input = catalog([group("source", [link("a"), link("b")]), group("parent", [], [group("target", [], [], true)], true)]);
  const fixture = serviceFixture(input);
  const result = await fixture.move();
  assert.equal(result.ok, true);
  assert.equal(result.revision, 8);
  assert.equal(result.canUndo, true);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(Object.keys(fixture.calls[0]).sort(), [FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY].sort());
  assert.deepEqual(fixture.data[FAVMOA_UNDO_KEY], { catalog: input, revertsRevision: 8 });
  assert.deepEqual(find(result.catalog, "target").links.map(item => item.id), ["a", "b"]);
  assert.equal(find(result.catalog, "parent").collapsed, false);
  const restored = await fixture.handle({ type: "FAVMOA_UNDO", expectedRevision: 8 });
  assert.equal(restored.ok, true);
  assert.equal(restored.revision, 9);
  assert.equal(restored.canUndo, false);
  assert.deepEqual(restored.catalog, input);
  assert.equal((await fixture.handle({ type: "FAVMOA_UNDO", expectedRevision: 9 })).code, "NOTHING_TO_UNDO");
  assert.equal(fixture.calls.length, 2);
});

test("service does not change existing undo or revision when all selected links already belong to the destination", async () => {
  const input = catalog([group("parent", [], [group("target", [link("a"), link("b")], [], true)], true)]);
  const oldCatalog = catalog([group("source", [link("a"), link("b")]), group("target")]);
  const fixture = serviceFixture(input, 7, { catalog: oldCatalog, revertsRevision: 7 });
  const before = structuredClone(fixture.data);
  const result = await fixture.move({ linkIds: ["b", "a"] });
  assert.equal(result.ok, true);
  assert.equal(result.revision, 7);
  assert.equal(result.canUndo, true);
  assert.deepEqual(result.catalog, input);
  assert.deepEqual(fixture.data, before);
  assert.equal(fixture.calls.length, 0);
});

test("service rejects incomplete selections and stale revisions without partial moves or undo changes", async () => {
  const input = catalog([group("source", [link("a"), link("b")]), group("target")]);
  const fixture = serviceFixture(input);
  const before = structuredClone(fixture.data);
  const invalid = await fixture.move({ linkIds: ["a", "missing"] });
  assert.equal(invalid.code, "INVALID_DATA");
  const conflict = await fixture.move({}, 6);
  assert.equal(conflict.code, "CONFLICT");
  assert.equal(conflict.revision, 7);
  assert.deepEqual(conflict.catalog, input);
  assert.deepEqual(fixture.data, before);
  assert.equal(fixture.calls.length, 0);
});

test("failed atomic storage write leaves the entire source and undo intact and permits retry", async () => {
  const input = catalog([group("source", [link("a"), link("b")]), group("target")]);
  const fixture = serviceFixture(input);
  const before = structuredClone(fixture.data);
  const save = fixture.storage.set;
  fixture.storage.set = async () => { throw new Error("storage quota exceeded"); };
  const result = await fixture.move();
  assert.equal(result.code, "SAVE_FAILED");
  assert.deepEqual(fixture.data, before);
  fixture.storage.set = save;
  const retried = await fixture.move();
  assert.equal(retried.ok, true);
  assert.equal(retried.revision, 8);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(find(retried.catalog, "target").links.map(item => item.id), ["a", "b"]);
});

test("concurrent multi-link moves with the same expected revision cannot overwrite each other", async () => {
  const input = catalog([group("source", [link("a"), link("b")]), group("target"), group("other")]);
  const fixture = serviceFixture(input);
  const [first, second] = await Promise.all([fixture.move(), fixture.move({ targetGroupId: "other" })]);
  assert.equal(first.ok, true);
  assert.equal(second.code, "CONFLICT");
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(find(second.catalog, "target").links.map(item => item.id), ["a", "b"]);
  assert.deepEqual(find(second.catalog, "other").links, []);
});
