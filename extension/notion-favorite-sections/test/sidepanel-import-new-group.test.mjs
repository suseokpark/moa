import assert from "node:assert/strict";
import test from "node:test";
import { fixture, flush, tab } from "../test-support/candidate-picker-fixture.mjs";
import { createCatalogService, FAVMOA_STORAGE_KEY } from "../src/favmoa-service.js";

const control = (f, name) => f.$("dialog-body").querySelector(`.candidate-new-group-${name}`);
async function draft(f, name, parent = "root") {
  await f.clickText("새 그룹에 담기");
  const input = control(f, "name"); assert.ok(input, "new group name can be entered in the same picker");
  input.value = name; await input.emit("input");
  control(f, "parent").value = parent; await control(f, "parent").emit("change");
}

test("new group draft in the tab picker preserves search and hidden selections without creating an empty group on cancel", async () => {
  const f = fixture(), before = structuredClone(f.run("state"));
  await f.open(); await f.check("Alpha"); await f.search("Beta"); await f.check("Beta");
  await draft(f, "Read later", "group:parent");
  assert.equal(f.filter().value, "Beta"); assert.equal(f.count(), "2개 선택 · 화면 밖 1개 포함");
  assert.match(control(f, "preview").textContent, /Parent.*Read later/u);
  assert.equal(f.$("dialog-submit").textContent, "새 그룹에 2개 담기");
  assert.equal(f.actions.length, 0); assert.deepEqual(structuredClone(f.run("state")), before);
  await f.$("dialog-cancel").emit("click"); await flush();
  assert.equal(f.actions.length, 0); assert.deepEqual(structuredClone(f.run("state")), before);
});

test("new group and selected links are submitted together and the resulting generated group is revealed", async () => {
  const f = fixture(); await f.open(); await f.check("Alpha"); await f.check("Beta");
  await draft(f, "  Read later  ", "group:parent"); await f.submit();
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0].action.type, "addLinksToNewGroup");
  assert.equal(f.actions[0].action.name, "Read later"); assert.equal(f.actions[0].action.parentGroupId, "parent");
  assert.equal(f.actions[0].action.links.length, 2);
  assert.equal(f.$("dialog").open, false);
  const parent = structuredClone(f.run('library().groups.find(group => group.id === "parent")'));
  const created = parent.groups.find(group => group.name === "Read later");
  assert.ok(created); assert.equal(created.links.length, 2); assert.equal(parent.collapsed, false);
  assert.equal(f.document.activeElement.dataset.focusKey, `g:library-personal:${created.id}`);
});

test("reviewing a deleted new-group parent preserves draft and selections and requires an explicit new location", async () => {
  const f = fixture(); await f.open(); await f.check("Alpha"); await f.search("Beta");
  await draft(f, "Read later", "group:parent");
  const latest = structuredClone(f.run("state.catalog")); latest.libraries[0].groups.pop();
  f.setCatalog(latest, 8);
  f.setResponse(async () => ({ ok: false, code: "CONFLICT", conflict: true, catalog: latest, revision: 8, error: "다른 창에서 변경" }));
  await f.submit(); await f.clickText("선택 유지하고 최신 목록 검토");
  assert.equal(f.actions.length, 1); assert.equal(control(f, "name").value, "Read later");
  assert.equal(f.filter().value, "Beta"); assert.equal(f.count(), "1개 선택 · 화면 밖 1개 포함");
  assert.equal(f.$("dialog-submit").disabled, true);
  assert.equal(control(f, "parent").selectedOptions[0].disabled, true);
  assert.equal(f.document.activeElement, control(f, "parent"));
  control(f, "parent").value = "root"; await control(f, "parent").emit("change");
  assert.equal(f.$("dialog-submit").disabled, false);
  f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].action.parentGroupId, null); assert.equal(f.actions[1].expectedRevision, 8);
});

for (const bookmarks of [false, true]) {
  const kind = bookmarks ? "bookmarks" : "tabs";
  test(`${kind}: root new-group import uses all selected results and one service Undo restores the original catalog`, async () => {
    const inputs = Array.from({ length: 205 }, (_, i) => tab(`Reference ${i}`, `https://example.org/reference/${i}`));
    const f = fixture(inputs, { bookmarks }), original = structuredClone(f.run("state.catalog")), writes = [];
    const values = { [FAVMOA_STORAGE_KEY]: { catalog: original, revision: 7 } };
    const sender = { id: "new-group-ui", url: "chrome-extension://new-group-ui/sidepanel/sidepanel.html" };
    const service = createCatalogService({ runtimeId: sender.id, storage: {
      async setAccessLevel() {},
      async get(keys) { return structuredClone(Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]]))); },
      async set(next) { writes.push(structuredClone(next)); Object.assign(values, structuredClone(next)); }
    } });
    f.context.realDispatch = (action, expectedRevision) => service.handle({ type: "FAVMOA_ACTION", action: structuredClone(action), expectedRevision }, sender);
    f.context.realUndo = expectedRevision => service.handle({ type: "FAVMOA_UNDO", expectedRevision }, sender);
    f.run("platform.dispatch = realDispatch; platform.undo = realUndo");
    f.$("search").value = "outer filter";
    await f.open(); await f.search("Reference"); await f.clickText("검색 결과 전체");
    await draft(f, "모은 자료"); assert.equal(writes.length, 0);
    await f.submit(); assert.equal(writes.length, 1); assert.equal(f.run("state.revision"), 8);
    const created = structuredClone(f.run('library().groups.find(group => group.name === "모은 자료")'));
    assert.equal(created.links.length, 205); assert.equal(f.$("search").value, "");
    assert.equal(f.document.activeElement.dataset.focusKey, `g:library-personal:${created.id}`);
    await f.$("undo").emit("click"); assert.equal(writes.length, 2);
    assert.deepEqual(structuredClone(f.run("state.catalog")), original);
  });

  test(`${kind}: blank, long or control-character group names preserve the picker and focus the invalid field`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open(); await f.check("Alpha"); await draft(f, "Draft");
    for (const value of ["", "  ", "a".repeat(81), "Group\nName", "Group\u0000Name"]) {
      control(f, "name").value = value; await control(f, "name").emit("input"); await f.submit();
      assert.equal(f.$("dialog").open, true); assert.equal(f.actions.length, 0);
      assert.equal(control(f, "name").getAttribute("aria-invalid"), "true");
      assert.equal(f.document.activeElement, control(f, "name"));
      assert.match(f.$("dialog-error").textContent, /1~80/u); assert.equal(f.count(), "1개 선택");
    }
    control(f, "name").value = "정상 이름"; await control(f, "name").emit("input");
    assert.equal(control(f, "name").getAttribute("aria-invalid"), null); assert.equal(f.$("dialog-error").textContent, "");
    await f.submit(); assert.equal(f.actions[0].action.name, "정상 이름");
  });

  test(`${kind}: no selection or explicit switch back to existing group never creates a draft group`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open(); await draft(f, "Unused draft", "group:parent");
    await f.submit(); assert.equal(f.actions.length, 0); assert.equal(f.$("dialog-submit").disabled, true);
    await f.check("Alpha"); await f.clickText("기존 그룹에 담기"); await f.target("destination"); await f.submit();
    assert.equal(f.actions.length, 1); assert.equal(f.actions[0].action.type, "addLinks");
    assert.equal(f.actions[0].action.groupId, "destination");
    assert.equal(f.run('flattenGroups(library()).some(row => row.group.name === "Unused draft")'), false);
  });

  test(`${kind}: all selected links already saved elsewhere leave the reviewed draft unsaved until new explicit selection`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open(); await f.check("Alpha"); await draft(f, "Still draft");
    const latest = structuredClone(f.run("state.catalog"));
    latest.libraries[0].groups[0].links.push({ id: "remote-alpha", title: "Alpha", url: "https://example.org/alpha", icon: "", provider: "generic" });
    f.setCatalog(latest, 8); f.setResponse(async () => ({ ok: false, code: "CONFLICT", conflict: true, catalog: latest, revision: 8, error: "다른 창에서 변경" }));
    await f.submit(); await f.clickText("선택 유지하고 최신 목록 검토"); await f.submit();
    assert.equal(f.actions.length, 1); assert.equal(f.count(), "0개 선택");
    assert.equal(f.$("dialog-submit").disabled, true); assert.equal(control(f, "name").value, "Still draft");
    assert.equal(f.run('flattenGroups(library()).some(row => row.group.name === "Still draft")'), false);
    await f.check("Beta"); f.setResponse(null); await f.submit();
    assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.actions[1].action.links[0].title, "Beta");
  });
}
