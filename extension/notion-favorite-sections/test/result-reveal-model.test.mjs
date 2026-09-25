import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogAction, createCatalog, flattenGroups, SYSTEM_GROUP_ID } from "../src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY } from "../src/favmoa-service.js";

const libraryId = "library-personal";
const group = (id, groups = [], links = [], collapsed = true) => ({ id, name: id, collapsed, groups, links });
const link = (id) => ({ id, title: id, url: `https://example.org/${id}`, provider: "generic", icon: "" });
const inputLink = { title: "New reference", url: "https://example.org/new-reference", icon: "" };
function catalog() {
  const value = createCatalog();
  value.libraries[0].groups.push(
    group("source", [group("moving", [group("nested")], [link("nested-link")])], [link("moving-link")]),
    group("parent", [group("target"), group("sibling")])
  );
  value.libraries.push({ id: "other-library", name: "Other", groups: [group("other-target")] });
  return value;
}
const find = (value, id) => flattenGroups(value.libraries[0]).find(item => item.group.id === id);
const actions = {
  addLink: { type: "addLink", libraryId, groupId: "target", link: inputLink, revealTarget: true },
  moveLink: { type: "moveLink", libraryId, linkId: "moving-link", targetGroupId: "target", revealTarget: true },
  moveGroup: { type: "moveGroup", libraryId, groupId: "moving", targetParentGroupId: "target", revealTarget: true }
};

test("adding one link can reveal the complete destination path without changing unrelated folds", () => {
  const before = catalog(), snapshot = structuredClone(before);
  const result = applyCatalogAction(before, actions.addLink);
  assert.deepEqual(find(result, "target").group.links.map(({ title, url, icon }) => ({ title, url, icon })), [inputLink]);
  assert.equal(find(result, "parent").group.collapsed, false);
  assert.equal(find(result, "target").group.collapsed, false);
  assert.equal(find(result, "sibling").group.collapsed, true);
  assert.equal(find(result, "source").group.collapsed, true);
  assert.deepEqual(result.libraries[1], before.libraries[1]);
  assert.deepEqual(before, snapshot);
});

test("moving one link reveals its new path and preserves link metadata and other branches", () => {
  const before = catalog(), snapshot = structuredClone(before);
  const result = applyCatalogAction(before, actions.moveLink);
  assert.deepEqual(find(result, "target").group.links, [link("moving-link")]);
  assert.deepEqual(find(result, "source").group.links, []);
  assert.equal(find(result, "parent").group.collapsed, false);
  assert.equal(find(result, "target").group.collapsed, false);
  assert.equal(find(result, "source").group.collapsed, true);
  assert.equal(find(result, "sibling").group.collapsed, true);
  assert.deepEqual(result.libraries[1], before.libraries[1]);
  assert.deepEqual(before, snapshot);
});

test("moving a group reveals only its destination ancestors and preserves the moved subtree folds", () => {
  const before = catalog(), snapshot = structuredClone(before);
  const result = applyCatalogAction(before, actions.moveGroup);
  assert.deepEqual(find(result, "moving").path.map(item => item.id), ["parent", "target", "moving"]);
  assert.equal(find(result, "parent").group.collapsed, false);
  assert.equal(find(result, "target").group.collapsed, false);
  assert.deepEqual(find(result, "moving").group, find(before, "moving").group);
  assert.equal(find(result, "source").group.collapsed, true);
  assert.equal(find(result, "sibling").group.collapsed, true);
  assert.deepEqual(result.libraries[1], before.libraries[1]);
  assert.deepEqual(before, snapshot);
});

for (const type of Object.keys(actions)) {
  test(`${type} rejects a nonboolean reveal request without modifying the input`, () => {
    const before = catalog(), snapshot = structuredClone(before);
    for (const revealTarget of ["true", "false", 0, 1, null, {}, []]) {
      assert.throws(() => applyCatalogAction(before, { ...actions[type], revealTarget }), /표시 옵션/u);
      assert.deepEqual(before, snapshot);
    }
  });
  test(`${type} keeps the original folded view when reveal is false or omitted`, () => {
    for (const revealTarget of [false, undefined]) {
      const command = { ...actions[type], revealTarget };
      if (revealTarget === undefined) delete command.revealTarget;
      const result = applyCatalogAction(catalog(), command);
      assert.equal(find(result, "parent").group.collapsed, true);
      assert.equal(find(result, "target").group.collapsed, true);
      assert.equal(find(result, "moving").group.collapsed, true);
      assert.equal(find(result, "nested").group.collapsed, true);
    }
  });
}

test("moving a group to the root preserves every fold and its subtree", () => {
  const before = catalog(), snapshot = structuredClone(before);
  const result = applyCatalogAction(before, { ...actions.moveGroup, targetParentGroupId: null });
  assert.equal(find(result, "moving").parent, null);
  assert.deepEqual(find(result, "moving").group, find(before, "moving").group);
  for (const { group } of flattenGroups(before.libraries[0])) assert.equal(find(result, group.id).group.collapsed, group.collapsed);
  assert.deepEqual(before, snapshot);
});

const sender = { id: "reveal-test", url: "chrome-extension://reveal-test/sidepanel/sidepanel.html" };
function fixture(input = catalog()) {
  const data = { [FAVMOA_STORAGE_KEY]: { revision: 7, catalog: structuredClone(input) } };
  const writes = [];
  let failWrites = false;
  const storage = {
    async setAccessLevel() {},
    async get(keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])])); },
    async set(values) {
      if (failWrites) throw Error("synthetic quota exceeded");
      writes.push(structuredClone(values));
      Object.assign(data, structuredClone(values));
    }
  };
  const { handle } = createCatalogService({ storage, runtimeId: sender.id });
  const revision = () => data[FAVMOA_STORAGE_KEY].revision;
  return { data, writes, setFailWrites: value => { failWrites = value; },
    action: (action, expectedRevision = revision()) => handle({ type: "FAVMOA_ACTION", action, expectedRevision }, sender),
    undo: (expectedRevision = revision()) => handle({ type: "FAVMOA_UNDO", expectedRevision }, sender)
  };
}

for (const type of Object.keys(actions)) {
  test(`${type} persists reveal and content atomically, and one Undo restores placement and folds`, async () => {
    const before = catalog(), f = fixture(before);
    const result = await f.action(actions[type]);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.revision, 8);
    assert.equal(result.canUndo, true);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(Object.keys(f.writes[0]).sort(), [FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY].sort());
    assert.deepEqual(f.data[FAVMOA_UNDO_KEY], { catalog: before, revertsRevision: 8 });
    assert.equal(find(result.catalog, "target").group.collapsed, false);
    assert.equal(find(result.catalog, "parent").group.collapsed, false);
    const undone = await f.undo();
    assert.equal(undone.ok, true);
    assert.equal(undone.revision, 9);
    assert.equal(undone.canUndo, false);
    assert.deepEqual(undone.catalog, before);
    assert.equal(f.writes.length, 2);
    assert.equal((await f.undo()).code, "NOTHING_TO_UNDO");
  });
  test(`${type} preserves a later explicit fold choice when undoing the content change`, async () => {
    const before = catalog(), f = fixture(before);
    assert.equal((await f.action(actions[type])).ok, true);
    for (const groupId of ["target", "target", "parent", "sibling"]) {
      const folded = await f.action({ type: "toggleGroup", libraryId, groupId });
      assert.equal(folded.ok, true);
      assert.equal(folded.canUndo, true);
    }
    const expected = structuredClone(before);
    find(expected, "target").group.collapsed = false;
    find(expected, "sibling").group.collapsed = false;
    const undone = await f.undo();
    assert.equal(undone.ok, true);
    assert.deepEqual(undone.catalog, expected);
  });
  test(`${type} does not change content, folds, revision or prior undo on stale requests`, async () => {
    const f = fixture();
    f.data[FAVMOA_UNDO_KEY] = { catalog: createCatalog(), revertsRevision: 7 };
    const before = structuredClone(f.data);
    const result = await f.action(actions[type], 6);
    assert.equal(result.code, "CONFLICT");
    assert.equal(result.revision, 7);
    assert.equal(result.canUndo, true);
    assert.deepEqual(result.catalog, before[FAVMOA_STORAGE_KEY].catalog);
    assert.deepEqual(f.data, before);
    assert.equal(f.writes.length, 0);
  });
  test(`${type} quota failure leaves reveal and content unchanged and permits the same revision retry`, async () => {
    const f = fixture();
    f.data[FAVMOA_UNDO_KEY] = { catalog: createCatalog(), revertsRevision: 7 };
    const before = structuredClone(f.data);
    f.setFailWrites(true);
    assert.equal((await f.action(actions[type])).code, "SAVE_FAILED");
    assert.deepEqual(f.data, before);
    assert.equal(f.writes.length, 0);
    f.setFailWrites(false);
    const result = await f.action(actions[type]);
    assert.equal(result.ok, true);
    assert.equal(result.revision, 8);
    assert.equal(f.writes.length, 1);
    assert.equal(find(result.catalog, "target").group.collapsed, false);
  });
}

for (const [name, action] of [
  ["same link group", { ...actions.moveLink, targetGroupId: "source" }],
  ["same group parent", { ...actions.moveGroup, targetParentGroupId: "source" }],
  ["same root parent", { ...actions.moveGroup, groupId: "source", targetParentGroupId: null }]
]) {
  test(`${name} is a true no-op despite revealTarget, retaining folds, revision and prior undo`, async () => {
    const f = fixture();
    f.data[FAVMOA_UNDO_KEY] = { catalog: createCatalog(), revertsRevision: 7 };
    const before = structuredClone(f.data);
    const result = await f.action(action);
    assert.equal(result.ok, true);
    assert.equal(result.revision, 7);
    assert.equal(result.canUndo, true);
    assert.deepEqual(result.catalog, before[FAVMOA_STORAGE_KEY].catalog);
    assert.deepEqual(f.data, before);
    assert.equal(f.writes.length, 0);
  });
}

for (const [name, changes] of [
  ["addLink", [{ revealTarget: "true" }, { groupId: "missing" }, { groupId: "other-target" }, { sectionId: "obsolete" },
    { link: { title: "Unsafe", url: "javascript:alert(1)" } }, { link: { title: "Duplicate", url: "https://example.org/moving-link" } }]],
  ["moveLink", [{ revealTarget: "true" }, { targetGroupId: "missing" }, { targetGroupId: "other-target" }, { linkId: "missing" }, { targetSectionId: "obsolete" }]],
  ["moveGroup", [{ revealTarget: "true" }, { targetParentGroupId: "missing" }, { targetParentGroupId: "other-target" }, { groupId: "missing" },
    { groupId: SYSTEM_GROUP_ID }, { targetParentGroupId: "moving" }, { targetParentGroupId: "nested" }]]
]) {
  test(`${name} rejects invalid, missing, cross-library or cyclic targets without a partial reveal or write`, async () => {
    const f = fixture();
    f.data[FAVMOA_UNDO_KEY] = { catalog: createCatalog(), revertsRevision: 7 };
    const before = structuredClone(f.data);
    for (const change of changes) {
      assert.equal((await f.action({ ...actions[name], ...change })).code, "INVALID_DATA");
      assert.deepEqual(f.data, before);
      assert.equal(f.writes.length, 0);
    }
  });
}
