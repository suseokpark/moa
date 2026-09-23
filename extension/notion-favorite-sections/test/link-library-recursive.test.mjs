import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogAction, countGroupLinks, createCatalog, flattenGroups, getSystemSectionId, MAX_GROUP_DEPTH, migrateLegacyStorage, SYSTEM_GROUP_ID, validateCatalog } from "../src/link-library.js";

const LIB = "library-personal";
const group = (id, groups = [], links = []) => ({ id, name: `Group ${id}`, collapsed: false, groups, links });
const link = (id, url = `https://example.com/${id}`) => ({ id, title: `Link ${id}`, url, icon: "📄", provider: "generic" });
const section = (id, links = [], name = `Section ${id}`) => ({ id, name, collapsed: true, links });
const catalog = groups => ({ schemaVersion: 2, libraries: [{ id: LIB, name: "내 링크", groups }], migratedLegacyKeys: [] });
const v1 = groups => ({ schemaVersion: 1, libraries: [{ id: LIB, name: "내 링크", groups }], migratedLegacyKeys: [] });
const oldGroup = (id, sections = []) => ({ id, name: `Group ${id}`, collapsed: true, sections });
const act = (input, action) => applyCatalogAction(input, { libraryId: LIB, ...action });
const links = input => flattenGroups(input.libraries[0]).flatMap(item => item.group.links);

test("v1 automatic sections lift links; named sections become child groups with their metadata and order", () => {
  const input = v1([oldGroup("work", [
    section("notes", [link("notes-link")], "기록"),
    section(getSystemSectionId("work"), [link("direct-1"), link("direct-2")]),
    section("references", [link("reference-link")], "참고 자료")
  ])]);
  input.libraries[0].origin = { type: "notion", workspaceKey: "company" };
  input.migratedLegacyKeys = ["nfs:workspace:company"];
  const snapshot = structuredClone(input), result = validateCatalog(input);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.libraries[0].groups[0].collapsed, true);
  assert.deepEqual(result.libraries[0].groups[0].links, [link("direct-1"), link("direct-2")]);
  assert.deepEqual(result.libraries[0].groups[0].groups.map(child => [child.id, child.name, child.collapsed]), [
    ["notes", "기록", true], ["references", "참고 자료", true]
  ]);
  assert.deepEqual(links(result).map(item => item.id).sort(), ["direct-1", "direct-2", "notes-link", "reference-link"]);
  assert.deepEqual(result.libraries[0].origin, input.libraries[0].origin);
  assert.deepEqual(result.migratedLegacyKeys, input.migratedLegacyKeys);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(validateCatalog(result), result);
  assert.equal(JSON.stringify(result).includes('"sections"'), false);
});

test("migration uses exact automatic section ID, never a translated or matching name", () => {
  const input = v1([oldGroup("work", [
    section("my-section", [link("custom")], "미분류 섹션"),
    section(getSystemSectionId("work"), [link("direct")], "Renamed old automatic section"),
    section(getSystemSectionId("elsewhere"), [], "미분류 섹션")
  ])]);
  const root = validateCatalog(input).libraries[0].groups[0];
  assert.deepEqual(root.links.map(item => item.id), ["direct"]);
  assert.deepEqual(root.groups.map(item => item.id), ["my-section", getSystemSectionId("elsewhere")]);
});

test("migration resolves group versus section namespace collisions deterministically with no loss", () => {
  const input = v1([
    oldGroup("same", [section("same", [link("a")]), section("migrated-section-1", [link("b")])]),
    oldGroup("other", [section(SYSTEM_GROUP_ID, [link("c")]), section("other", [link("d")])])
  ]);
  const snapshot = structuredClone(input), result = validateCatalog(input);
  assert.deepEqual(flattenGroups(result.libraries[0]).map(item => item.group.id), [
    "same", "migrated-section-2", "migrated-section-1", "other", "migrated-section-3", "migrated-section-4"
  ]);
  assert.deepEqual(links(result).map(item => item.id), ["a", "b", "c", "d"]);
  assert.deepEqual(validateCatalog(input), result);
  assert.deepEqual(validateCatalog(result), result);
  assert.deepEqual(input, snapshot);
});

test("migration preserves maximal section IDs and handles empty old containers without synthetic child groups", () => {
  const longId = "s".repeat(320);
  const result = validateCatalog(v1([oldGroup("empty"), oldGroup("full", [section(longId, [], "Long ID")])]));
  assert.deepEqual(result.libraries[0].groups[0], { id: "empty", name: "Group empty", collapsed: true, groups: [], links: [] });
  assert.equal(result.libraries[0].groups[1].groups[0].id, longId);
  assert.deepEqual(validateCatalog(result), result);
  assert.deepEqual(validateCatalog(v1([])), createCatalog());
});

test("v1 still rejects unknown fields, duplicate old namespaces and malformed links before conversion", () => {
  const base = v1([oldGroup("a", [section("b", [link("one")])])]);
  for (const mutate of [
    c => { c.libraries[0].groups[0].groups = []; },
    c => { c.libraries[0].groups[0].sections[0].extra = true; },
    c => { c.libraries[0].groups.push(oldGroup("a")); },
    c => { c.libraries[0].groups[0].sections.push(section("b")); },
    c => { c.libraries[0].groups[0].sections[0].links.push(link("one", "https://example.com/two")); },
    c => { c.libraries[0].groups[0].sections[0].links.push(link("two", "https://example.com/one")); },
    c => { c.libraries[0].groups[0].sections[0].links[0].url = "javascript:alert(1)"; },
    c => { c.libraries[0].groups[0].sections = new Array(1); },
    c => { c.libraries[0].groups[0].sections = Array.from({ length: 101 }, (_, i) => section(`s-${i}`)); }
  ]) {
    const input = structuredClone(base); mutate(input);
    const snapshot = structuredClone(input);
    assert.throws(() => validateCatalog(input));
    assert.deepEqual(input, snapshot);
  }
});

test("preorder helper exposes real parents and complete paths and counts mixed contents recursively", () => {
  const nested = group("a", [group("b", [group("c", [], [link("deep")])], [link("middle")]), group("d")], [link("direct")]);
  const library = catalog([nested, group("e")]).libraries[0];
  const rows = flattenGroups(library);
  assert.deepEqual(rows.map(item => item.group.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(rows.map(item => item.parent?.id ?? null), [null, "a", "b", "a", null]);
  assert.deepEqual(rows[2].path.map(item => item.id), ["a", "b", "c"]);
  assert.strictEqual(rows[2].group, nested.groups[0].groups[0]);
  assert.strictEqual(rows[2].parent, nested.groups[0]);
  assert.equal(countGroupLinks(nested), 3);
  assert.equal(countGroupLinks(nested.groups[0]), 2);
  assert.equal(countGroupLinks(nested.groups[1]), 0);
});

test("deep mixed groups accept links and bulk links and preserve unrelated subtree state", () => {
  const input = catalog([group("a", [group("b", [group("c")])]), group("other", [], [link("existing")])]);
  const snapshot = structuredClone(input);
  let result = act(input, { type: "addLink", groupId: "c", link: { title: "One", url: "https://example.com/one" } });
  result = act(result, { type: "addLinks", groupId: "b", links: [{ title: "Two", url: "https://example.com/two" }, { title: "Three", url: "https://example.com/three" }] });
  result = act(result, { type: "addGroup", parentGroupId: "c", name: "Deep child" });
  assert.equal(countGroupLinks(result.libraries[0].groups[0]), 3);
  assert.equal(flattenGroups(result.libraries[0])[3].path.length, 4);
  assert.deepEqual(result.libraries[0].groups[1], input.libraries[0].groups[1]);
  assert.deepEqual(input, snapshot);
  const firstId = links(result).find(item => item.title === "One").id;
  result = act(result, { type: "moveLink", linkId: firstId, targetGroupId: "a" });
  result = act(result, { type: "updateLink", linkId: firstId, title: "Renamed" });
  assert.equal(result.libraries[0].groups[0].links[0].title, "Renamed");
  assert.equal(result.libraries[0].groups[0].groups[0].groups[0].links.length, 0);
});

test("duplicates anywhere in a recursive library are rejected atomically for add, bulk add and update", () => {
  const input = catalog([group("a", [group("b", [group("c", [], [link("existing")])])]), group("d", [], [link("other")])]);
  const snapshot = structuredClone(input);
  for (const action of [
    { type: "addLink", groupId: "d", link: { title: "Duplicate", url: "https://example.com/existing" } },
    { type: "addLinks", groupId: "a", links: [{ title: "New", url: "https://example.com/new" }, { title: "Duplicate", url: "https://example.com/existing" }] },
    { type: "updateLink", linkId: "other", url: "https://example.com/existing" }
  ]) assert.throws(() => act(input, action), /이미/u);
  assert.deepEqual(input, snapshot);
});

test("deleting a nested group lifts children at its position and appends links without losing descendants", () => {
  const doomed = group("remove", [group("first", [group("grandchild", [], [link("deep")])]), group("second")], [link("lifted")]);
  const input = catalog([group("parent", [group("before"), doomed, group("after")], [link("parent-link")])]);
  const result = act(input, { type: "removeGroup", groupId: "remove" });
  assert.deepEqual(result.libraries[0].groups[0].groups.map(item => item.id), ["before", "first", "second", "after"]);
  assert.deepEqual(result.libraries[0].groups[0].links.map(item => item.id), ["parent-link", "lifted"]);
  assert.deepEqual(links(result).map(item => item.id).sort(), links(input).map(item => item.id).sort());
  assert.deepEqual(result.libraries[0].groups[0].groups[1], doomed.groups[0]);
});

test("deleting a custom root without an existing system root creates a safe target and retains deep contents", () => {
  const input = catalog([group("remove", [group("child", [group("deep", [], [link("deep-link")])])], [link("direct")]), group("other")]);
  const result = act(input, { type: "removeGroup", groupId: "remove" });
  assert.deepEqual(result.libraries[0].groups.map(item => item.id), ["other", SYSTEM_GROUP_ID]);
  assert.equal(countGroupLinks(result.libraries[0].groups[1]), 2);
  assert.deepEqual(links(result), links(input));
});

test("moving groups rejects own descendants and invalid parents without mutating input", () => {
  const input = catalog([group("a", [group("b", [group("c")])]), group("other")]);
  const snapshot = structuredClone(input);
  for (const action of [
    { type: "moveGroup", groupId: "a", targetParentGroupId: "a" },
    { type: "moveGroup", groupId: "a", targetParentGroupId: "c" },
    { type: "moveGroup", groupId: "b", targetParentGroupId: "missing" },
    { type: "addGroup", name: "Bad", parentGroupId: "missing" }
  ]) assert.throws(() => act(input, action));
  assert.deepEqual(input, snapshot);
  const result = act(input, { type: "moveGroup", groupId: "b", targetParentGroupId: "other" });
  assert.deepEqual(result.libraries[0].groups[0].groups, []);
  assert.deepEqual(result.libraries[0].groups[1].groups[0], input.libraries[0].groups[0].groups[0]);
});

function chain(length, prefix = "deep") {
  let current = null;
  for (let i = length; i >= 1; i -= 1) current = group(`${prefix}-${i}`, current ? [current] : []);
  return current;
}

test("32 group levels work; deeper imports, additions and moves fail atomically without truncation", () => {
  assert.equal(MAX_GROUP_DEPTH, 32);
  const input = catalog([chain(MAX_GROUP_DEPTH), group("move", [group("move-child")])]);
  const snapshot = structuredClone(input);
  assert.equal(flattenGroups(validateCatalog(input).libraries[0]).length, 34);
  assert.throws(() => validateCatalog(catalog([chain(MAX_GROUP_DEPTH + 1)])), /32단계/u);
  assert.throws(() => act(input, { type: "addGroup", name: "Too deep", parentGroupId: `deep-${MAX_GROUP_DEPTH}` }), /32단계/u);
  assert.throws(() => act(input, { type: "moveGroup", groupId: "move", targetParentGroupId: `deep-${MAX_GROUP_DEPTH - 1}` }), /32단계/u);
  assert.deepEqual(input, snapshot);
  const result = act(input, { type: "moveGroup", groupId: "move", targetParentGroupId: `deep-${MAX_GROUP_DEPTH - 2}` });
  assert.equal(flattenGroups(result.libraries[0]).at(-1).path.length, MAX_GROUP_DEPTH);
});

test("validation and traversal reject actual cyclic structures without recursing indefinitely", () => {
  const root = group("root"), child = group("child");
  root.groups.push(child); child.groups.push(root);
  const input = catalog([root]);
  assert.throws(() => validateCatalog(input), /순환/u);
  assert.throws(() => flattenGroups(input.libraries[0]), /순환/u);
  assert.throws(() => countGroupLinks(root), /순환/u);
  const nestedSystem = catalog([group("root", [createCatalog().libraries[0].groups[0]])]);
  assert.throws(() => validateCatalog(nestedSystem), /미분류 그룹은 최상위/u);
});

test("legacy Notion generated sections migrate directly while custom names stay child groups", () => {
  const page = "0123456789abcdef0123456789abcdef";
  const workspace = { schemaVersion: 1, groups: [{
    id: "project", name: "Project", color: "", emoji: "", collapsed: true, order: 1, system: false,
    sections: [{ id: getSystemSectionId("project"), name: "미분류 섹션", color: "", emoji: "", collapsed: true, order: 0, system: true,
      favorites: [{ pageId: page, order: 0, dormant: false, updatedAt: "2026-09-21T00:00:00.000Z" }] },
    { id: "custom", name: "미분류 섹션", color: "", emoji: "", collapsed: true, order: 1, system: false, favorites: [] }]
  }] };
  const storage = { "nfs:workspace:alpha": workspace }, snapshot = structuredClone(storage);
  const result = migrateLegacyStorage(createCatalog(), storage);
  assert.equal(result.importedLibraries, 1);
  assert.equal(result.importedLinks, 1);
  assert.equal(result.catalog.schemaVersion, 2);
  const migrated = result.catalog.libraries[1].groups[0];
  assert.equal(migrated.links[0].resourceId, page);
  assert.equal(migrated.groups[0].id, "custom");
  assert.equal(migrated.groups[0].collapsed, true);
  assert.deepEqual(storage, snapshot);
  assert.deepEqual(migrateLegacyStorage(result.catalog, storage).catalog, result.catalog);
});
