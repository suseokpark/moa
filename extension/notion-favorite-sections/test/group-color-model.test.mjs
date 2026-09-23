import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogAction, createCatalog, flattenGroups, getSystemSectionId, SYSTEM_GROUP_ID, validateCatalog } from "../src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY } from "../src/favmoa-service.js";

const LIB = "library-personal";
const group = (id, color, groups = [], links = []) => ({ id, name: `Group ${id}`, collapsed: false, groups, links, ...(color === undefined ? {} : { color }) });
const link = id => ({ id, title: `Link ${id}`, url: `https://example.com/${id}`, icon: "", provider: "generic" });
const catalog = groups => ({ schemaVersion: 2, libraries: [{ id: LIB, name: "내 링크", groups }], migratedLegacyKeys: [] });
const act = (input, action) => applyCatalogAction(input, { libraryId: LIB, ...action });
const find = (input, id) => flattenGroups(input.libraries[0]).find(item => item.group.id === id).group;

test("optional group colors normalize to HEX6 without changing input or uncolored group shape", () => {
  const input = catalog([group("work", "#Aa11FF", [group("child", "#00CC88"), group("plain")], [link("one")])]);
  const snapshot = structuredClone(input);
  const result = validateCatalog(input);
  assert.equal(find(result, "work").color, "#aa11ff");
  assert.equal(find(result, "child").color, "#00cc88");
  assert.equal(Object.hasOwn(find(result, "plain"), "color"), false);
  assert.deepEqual(input, snapshot);
  assert.notEqual(find(result, "work"), find(input, "work"));
  assert.deepEqual(validateCatalog(JSON.parse(JSON.stringify(result))), result);
  assert.deepEqual(validateCatalog(createCatalog()), createCatalog());
});

test("set and reset target only the chosen group, including the protected root", () => {
  const input = catalog([group(SYSTEM_GROUP_ID, undefined, [group("child", "#00cc88")]), group("other", "#abcdef")]);
  const snapshot = structuredClone(input);
  const colored = act(input, { type: "setGroupColor", groupId: SYSTEM_GROUP_ID, color: "#AA0000" });
  assert.equal(find(colored, SYSTEM_GROUP_ID).color, "#aa0000");
  assert.equal(find(colored, "child").color, "#00cc88");
  assert.deepEqual(find(colored, "other"), find(input, "other"));
  const reset = act(colored, { type: "setGroupColor", groupId: SYSTEM_GROUP_ID, color: null });
  assert.deepEqual(reset, input);
  assert.equal(Object.hasOwn(find(reset, SYSTEM_GROUP_ID), "color"), false);
  assert.deepEqual(input, snapshot);
  assert.equal(find(colored, SYSTEM_GROUP_ID).color, "#aa0000");
});

test("color customization does not loosen protected group structural operations", () => {
  const input = catalog([group(SYSTEM_GROUP_ID, "#aabbcc"), group("other")]);
  const snapshot = structuredClone(input);
  for (const action of [
    { type: "renameGroup", name: "Changed" },
    { type: "removeGroup" },
    { type: "moveGroup", targetParentGroupId: "other" },
    { type: "reorderGroup", direction: "down" }
  ]) assert.throws(() => act(input, { groupId: SYSTEM_GROUP_ID, ...action }), /미분류/u);
  assert.deepEqual(input, snapshot);
});

test("invalid colors and CSS injection are rejected atomically in imports and actions", () => {
  const input = catalog([group("work", "#123456", [], [link("existing")])]);
  const snapshot = structuredClone(input);
  for (const color of [undefined, null, "", "red", "#abc", "#12345678", "#gggggg", " #123456", "#123456 ", "#123456\n", "url(https://example.com)", "var(--accent)", "#123456;display:none", 0, false, [], {}, new String("#123456"), Symbol("#123456")]) {
    assert.throws(() => validateCatalog(catalog([group("bad", "#123456")].map(item => ({ ...item, color })))));
    if (color !== null) assert.throws(() => act(input, { type: "setGroupColor", groupId: "work", color }));
    assert.deepEqual(input, snapshot);
  }
  assert.throws(() => act(input, { type: "setGroupColor", groupId: "work" }));
  assert.throws(() => act(input, { type: "setGroupColor", groupId: "missing", color: "#123456" }));
});

test("prototype and accessor color values cannot execute during validation or mutation", () => {
  let calls = 0;
  const malicious = { toString() { calls += 1; return "#123456"; } };
  const raw = group("work", malicious);
  assert.throws(() => validateCatalog(catalog([raw])));
  Object.defineProperty(raw, "color", { enumerable: true, get() { calls += 1; return "#123456"; } });
  assert.throws(() => validateCatalog(catalog([raw])));
  const action = { type: "setGroupColor", libraryId: LIB, groupId: "work" };
  Object.defineProperty(action, "color", { enumerable: true, get() { calls += 1; return "#123456"; } });
  assert.throws(() => applyCatalogAction(catalog([group("work")]), action));
  const inherited = Object.assign(Object.create({ color: "#123456" }), group("work"));
  assert.throws(() => validateCatalog(catalog([inherited])));
  const ownNullPrototype = Object.assign(Object.create(null), group("valid", "#ABCDEF"));
  assert.equal(find(validateCatalog(catalog([ownNullPrototype])), "valid").color, "#abcdef");
  const nonEnumerable = group("hidden");
  Object.defineProperty(nonEnumerable, "color", { value: "#123456" });
  assert.throws(() => validateCatalog(catalog([nonEnumerable])));
  assert.equal(calls, 0);
});

test("parent, child and new child colors remain independent through nesting changes", () => {
  const input = catalog([group("work", "#aa0000", [group("child", "#00bb00", [group("deep", "#0000cc")])]), group("other", "#abcdef")]);
  let result = act(input, { type: "addGroup", parentGroupId: "child", name: "New child" });
  assert.equal(Object.hasOwn(find(result, "child").groups[1], "color"), false);
  result = act(result, { type: "moveGroup", groupId: "child", targetParentGroupId: "other" });
  result = act(result, { type: "toggleGroup", groupId: "child" });
  result = act(result, { type: "renameGroup", groupId: "child", name: "Renamed" });
  result = act(result, { type: "reorderGroup", groupId: "other", direction: "up" });
  assert.deepEqual(flattenGroups(result.libraries[0]).filter(item => item.group.color).map(item => [item.group.id, item.group.color]), [
    ["other", "#abcdef"], ["child", "#00bb00"], ["deep", "#0000cc"], ["work", "#aa0000"]
  ]);
  result = act(result, { type: "removeGroup", groupId: "child" });
  assert.equal(find(result, "deep").color, "#0000cc");
  assert.equal(find(result, "other").color, "#abcdef");
  assert.equal(find(input, "child").name, "Group child");
});

test("schema1 migration preserves old groups and sections without inventing color overrides", () => {
  const input = { schemaVersion: 1, libraries: [{ id: LIB, name: "내 링크", groups: [{
    id: "work", name: "Work", collapsed: false, sections: [
      { id: getSystemSectionId("work"), name: "미분류 섹션", collapsed: false, links: [link("one")] },
      { id: "child", name: "Child", collapsed: true, links: [link("two")] }
    ]
  }] }], migratedLegacyKeys: [] };
  const snapshot = structuredClone(input);
  const result = validateCatalog(input);
  assert.equal(result.schemaVersion, 2);
  assert.equal(flattenGroups(result.libraries[0]).every(item => !Object.hasOwn(item.group, "color")), true);
  const colored = act(input, { type: "setGroupColor", groupId: "child", color: "#AbC123" });
  assert.equal(find(colored, "child").color, "#abc123");
  assert.deepEqual(find(colored, "work").links, [link("one")]);
  assert.deepEqual(find(colored, "child").links, [link("two")]);
  assert.deepEqual(input, snapshot);
  input.libraries[0].groups[0].color = "#123456";
  assert.throws(() => validateCatalog(input), /지원하지/u);
});

const sender = { id: "extension-test", url: "chrome-extension://extension-test/sidepanel/sidepanel.html" };
function service(initial) {
  const data = { [FAVMOA_STORAGE_KEY]: { revision: 0, catalog: structuredClone(initial) }, "favmoa:theme:v1": { accent: "unchanged" }, "nfs:workspace:original": { preserved: true } };
  const writes = [];
  const storage = {
    async setAccessLevel() {},
    async get(keys) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]]))); },
    async set(values) { writes.push(structuredClone(values)); Object.assign(data, structuredClone(values)); }
  };
  const { handle } = createCatalogService({ storage, runtimeId: sender.id });
  return { data, writes, storage, handle: message => handle(message, sender) };
}
const colorAction = (color, expectedRevision, groupId = "work") => ({ type: "FAVMOA_ACTION", expectedRevision, action: { type: "setGroupColor", libraryId: LIB, groupId, color } });

test("service saves color with revision guard and undo restores the exact previous catalog", async () => {
  const input = catalog([group("work", undefined, [group("child", "#aabbcc")], [link("one")])]);
  const { data, writes, handle } = service(input);
  const saved = await handle(colorAction("#ABC123", 0));
  assert.equal(saved.ok, true);
  assert.equal(saved.revision, 1);
  assert.equal(find(saved.catalog, "work").color, "#abc123");
  assert.deepEqual(data[FAVMOA_UNDO_KEY].catalog, input);
  const unchanged = await handle(colorAction("#ABC123", 1));
  assert.equal(unchanged.revision, 1);
  assert.equal(writes.length, 1);
  const conflict = await handle(colorAction("#000000", 0));
  assert.equal(conflict.code, "CONFLICT");
  assert.equal(find(conflict.catalog, "work").color, "#abc123");
  const undo = await handle({ type: "FAVMOA_UNDO", expectedRevision: 1 });
  assert.equal(undo.ok, true);
  assert.deepEqual(undo.catalog, input);
  assert.deepEqual(data["favmoa:theme:v1"], { accent: "unchanged" });
  assert.deepEqual(data["nfs:workspace:original"], { preserved: true });
});

test("colored JSON backups round-trip through import, reset, undo and recovery", async () => {
  const original = catalog([group("original", "#112233", [], [link("one")])]);
  const backup = catalog([group("work", "#abcdef", [group("child", "#123456")], [link("two")])]);
  const { handle } = service(original);
  const imported = await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: JSON.parse(JSON.stringify(backup)), expectedRevision: 0 });
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.catalog, backup);
  const reset = await handle(colorAction(null, 1));
  assert.equal(reset.ok, true);
  assert.equal(Object.hasOwn(find(reset.catalog, "work"), "color"), false);
  assert.equal(find(reset.catalog, "child").color, "#123456");
  const undo = await handle({ type: "FAVMOA_UNDO", expectedRevision: 2 });
  assert.deepEqual(undo.catalog, backup);
  const recovered = await handle({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 3 });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.catalog, original);
});

test("invalid color and storage failures keep catalog, undo and other settings intact", async () => {
  const input = catalog([group("work", "#123456", [], [link("one")])]);
  const { data, writes, storage, handle } = service(input);
  const snapshot = structuredClone(data);
  const invalid = await handle(colorAction("url(https://example.com)", 0));
  assert.equal(invalid.code, "INVALID_DATA");
  assert.deepEqual(data, snapshot);
  assert.equal(writes.length, 0);
  storage.set = async () => { throw new Error("Quota exceeded"); };
  const failed = await handle(colorAction("#abcdef", 0));
  assert.equal(failed.code, "SAVE_FAILED");
  assert.deepEqual(data, snapshot);
});
