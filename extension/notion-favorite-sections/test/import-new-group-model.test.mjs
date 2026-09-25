import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogAction, createCatalog, flattenGroups } from "../src/link-library.js";

const libraryId = "library-personal";
const group = (id, groups = [], collapsed = true) => ({ id, name: id, groups, links: [], collapsed });
const links = [
  { title: "Reference", url: "https://example.com/reference?lang=ko#details" },
  { title: "Notion page", url: "https://app.notion.com/p/example/0123456789abcdef0123456789abcdef" }
];
function catalog() {
  const value = createCatalog();
  value.libraries[0].groups.push(group("parent", [group("target"), group("sibling")]));
  value.libraries.push({ id: "other-library", name: "Other", groups: [group("other-target")] });
  return value;
}
const find = (value, id) => flattenGroups(value.libraries[0]).find(item => item.group.id === id);
const command = changes => ({ type: "addLinksToNewGroup", libraryId, parentGroupId: "target", name: "  Imported references  ", links, revealTarget: true, ...changes });

test("importing selected links into a new group creates one revealed destination and leaves the source unchanged", () => {
  const before = catalog(), snapshot = structuredClone(before);
  const result = applyCatalogAction(before, command());
  const created = find(result, "target").group.groups[0];
  assert.equal(created.name, "Imported references");
  assert.ok(created.id);
  assert.equal(flattenGroups(before.libraries[0]).some(item => item.group.id === created.id), false);
  assert.equal(created.collapsed, false);
  assert.deepEqual(created.groups, []);
  assert.deepEqual(created.links.map(({ title, url }) => ({ title, url })), links);
  assert.equal(created.links[1].provider, "notion");
  assert.equal(created.links[1].resourceId, "0123456789abcdef0123456789abcdef");
  assert.equal(find(result, "parent").group.collapsed, false);
  assert.equal(find(result, "target").group.collapsed, false);
  assert.equal(find(result, "sibling").group.collapsed, true);
  assert.deepEqual(result.libraries[1], before.libraries[1]);
  assert.deepEqual(before, snapshot);
});

test("new-group import requires an explicit root or existing parent rather than falling back on malformed input", () => {
  const before = catalog(), snapshot = structuredClone(before);
  for (const parentGroupId of [undefined, false, 0, {}, [], "", "missing", "other-target"]) {
    assert.throws(() => applyCatalogAction(before, command({ parentGroupId })));
    assert.deepEqual(before, snapshot);
  }
});

test("a new root group is distinct from same-named siblings and never trusts a supplied group ID", () => {
  const before = catalog();
  const result = applyCatalogAction(before, command({ parentGroupId: null, name: "parent", groupId: "parent" }));
  const matches = result.libraries[0].groups.filter(item => item.name === "parent");
  assert.equal(matches.length, 2);
  assert.notEqual(matches[0].id, matches[1].id);
  assert.deepEqual(matches[0], find(before, "parent").group);
  assert.deepEqual(matches[1].links.map(({ title, url }) => ({ title, url })), links);
});

test("new-group import preserves ancestor folds unless reveal is explicitly requested", () => {
  for (const revealTarget of [undefined, false]) {
    const action = command({ revealTarget });
    if (revealTarget === undefined) delete action.revealTarget;
    const result = applyCatalogAction(catalog(), action);
    assert.equal(find(result, "parent").group.collapsed, true);
    assert.equal(find(result, "target").group.collapsed, true);
    assert.equal(find(result, "target").group.groups[0].collapsed, false);
  }
});

for (const [label, changes] of [
  ["missing library", { libraryId: "missing" }],
  ["blank group name", { name: "  " }],
  ["long group name", { name: "x".repeat(81) }],
  ["malformed group name", { name: null }],
  ["control in group name", { name: "new\ngroup" }],
  ["empty links", { links: [] }],
  ["sparse links", { links: new Array(2) }],
  ["unsafe last link", { links: [...links, { title: "Unsafe", url: "javascript:alert(1)" }] }],
  ["empty last title", { links: [...links, { title: "", url: "https://example.com/empty" }] }],
  ["duplicate batch route", { links: [...links, links[0]] }],
  ["duplicate Notion identity", { links: [...links, { title: "Same page", url: "https://www.notion.so/0123456789abcdef0123456789abcdef" }] }],
  ["nonboolean reveal", { revealTarget: "true" }],
  ["obsolete section", { sectionId: "old-section" }],
  ["oversized batch", { links: Array.from({ length: 1001 }, (_, i) => ({ title: `Reference ${i}`, url: `https://example.com/link-${i}` })) }]
]) {
  test(`new-group import rejects ${label} without leaving an empty group or modifying source data`, () => {
    const before = catalog(), snapshot = structuredClone(before);
    assert.throws(() => applyCatalogAction(before, command(changes)));
    assert.deepEqual(before, snapshot);
  });
}

test("links already stored anywhere in the destination library prevent the whole new-group import", () => {
  const before = applyCatalogAction(catalog(), { type: "addLink", libraryId, groupId: "sibling", link: links[0] });
  const snapshot = structuredClone(before);
  assert.throws(() => applyCatalogAction(before, command()), /중복/u);
  assert.deepEqual(before, snapshot);
});

test("exactly 1,000 selected links can be imported into one new group in source order", () => {
  const selected = Array.from({ length: 1000 }, (_, i) => ({ title: `Reference ${i}`, url: `https://example.com/link-${i}` }));
  const result = applyCatalogAction(catalog(), command({ links: selected }));
  assert.deepEqual(find(result, "target").group.groups[0].links.map(({ title, url }) => ({ title, url })), selected);
});

test("new-group import permits depth 32 but rejects a child at depth 33 atomically", () => {
  const before = createCatalog();
  let siblings = before.libraries[0].groups;
  for (let depth = 1; depth <= 31; depth += 1) {
    const child = group(`depth-${depth}`);
    siblings.push(child); siblings = child.groups;
  }
  const result = applyCatalogAction(before, command({ parentGroupId: "depth-31" }));
  const created = find(result, "depth-31").group.groups[0];
  assert.equal(find(result, created.id).path.length, 32);
  const snapshot = structuredClone(result);
  assert.throws(() => applyCatalogAction(result, command({ parentGroupId: created.id, links: [{ title: "Next", url: "https://example.com/next" }] })), /32/u);
  assert.deepEqual(result, snapshot);
});

test("the catalog link limit rejects an otherwise valid new-group import without mutation", () => {
  const before = createCatalog();
  before.libraries[0].groups[0].links = Array.from({ length: 10000 }, (_, i) => ({ id: `saved-${i}`, title: `Saved ${i}`, url: `https://example.org/saved-${i}`, icon: "", provider: "generic" }));
  const snapshot = structuredClone(before);
  assert.throws(() => applyCatalogAction(before, command({ parentGroupId: null, links: [links[0]] })), /10,000/u);
  assert.deepEqual(before, snapshot);
});

test("the catalog node limit counts both the new group and imported links before returning any result", () => {
  const before = createCatalog();
  before.libraries[0].groups.push(...Array.from({ length: 19997 }, (_, i) => group(`group-${i}`)));
  const snapshot = structuredClone(before);
  assert.throws(() => applyCatalogAction(before, command({ parentGroupId: null, links: [links[0]] })), /20,000/u);
  assert.deepEqual(before, snapshot);
});
