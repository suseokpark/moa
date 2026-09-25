import assert from "node:assert/strict";
import test from "node:test";
import { MAX_GROUP_DEPTH, flattenGroups } from "../src/link-library.js";
import { deferred, fixture, flush } from "../test-support/candidate-picker-fixture.mjs";

// Independent edge review of shipped handlers and reducer with synthetic DOM,
// candidates and storage only. Native form validation and layout are not tested.
const control = (f, name) => f.$("dialog-body").querySelector(`.candidate-new-group-${name}`);
const catalog = f => structuredClone(f.run("state.catalog"));
const group = (id, name = id, groups = []) => ({ id, name, groups, links: [], collapsed: true });
const seed = (f, value) => {
  f.context.seedCatalog = value;
  f.run("adopt({catalog: seedCatalog, revision: 7});");
  f.setCatalog(value, 7);
};
async function draft(f, name = "Reading", parent = "root") {
  await f.clickText("새 그룹에 담기");
  control(f, "name").value = name; await control(f, "name").emit("input");
  control(f, "parent").value = parent; await control(f, "parent").emit("change");
}
async function conflict(f, latest) {
  f.setCatalog(latest, 8);
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "목록이 바뀌었습니다.", catalog: latest, revision: 8 }));
  await f.submit();
}
async function review(f) {
  await f.$("dialog-body").querySelector(".candidate-review-button").emit("click"); await flush();
}

for (const bookmarks of [false, true]) {
  const kind = bookmarks ? "bookmark" : "tab";

  test(`${kind} new-group parent options allow depth 31 but exclude depth 32 and show complete paths`, async () => {
    const f = fixture(undefined, { bookmarks }), initial = catalog(f);
    let nested;
    for (let depth = MAX_GROUP_DEPTH; depth >= 1; depth--) nested = group(`depth-${depth}`, `Level ${depth}`, nested ? [nested] : []);
    initial.libraries[0].groups.push(nested); seed(f, initial);
    await f.open(); await f.check("Alpha"); await draft(f, "Leaf", "group:depth-31");
    const options = control(f, "parent").children;
    assert.ok(options.some(option => option.value === "root"));
    assert.ok(options.some(option => option.value === "group:depth-31"));
    assert.ok(!options.some(option => option.value === "group:depth-32"));
    assert.match(control(f, "parent").selectedOptions[0].textContent, /^Level 1 › Level 2.*Level 31$/u);
    await f.submit();
    assert.equal(f.$("dialog").open, false);
    const created = flattenGroups(catalog(f).libraries[0]).find(row => row.group.name === "Leaf");
    assert.equal(created.path.length, MAX_GROUP_DEPTH);
    assert.equal(created.parent.id, "depth-31");
  });

  test(`${kind} same-name parents and existing same-name groups do not redirect new import or focus`, async () => {
    const f = fixture(undefined, { bookmarks }), initial = catalog(f);
    initial.libraries[0].groups.push(group("branch-a", "Branch A", [group("duplicate-a", "Shared", [group("reading-a", "Reading")])]),
      group("branch-b", "Branch B", [group("duplicate-b", "Shared", [group("reading-b", "Reading")])]));
    seed(f, initial); await f.open(); await f.check("Beta"); await draft(f, "Reading", "group:duplicate-b");
    assert.equal(control(f, "parent").selectedOptions[0].textContent, "Branch B › Shared");
    assert.match(control(f, "preview").textContent, /Branch B › Shared › Reading/u);
    await f.submit();
    const rows = flattenGroups(catalog(f).libraries[0]);
    const created = rows.find(row => row.group.links.some(link => link.title === "Beta"));
    assert.ok(created); assert.equal(created.parent.id, "duplicate-b");
    assert.notEqual(created.group.id, "reading-b");
    assert.equal(rows.find(row => row.group.id === "reading-a").group.links.length, 0);
    assert.equal(rows.find(row => row.group.id === "reading-b").group.links.length, 0);
    assert.equal(f.document.activeElement.dataset.focusKey, `g:library-personal:${created.group.id}`);
  });

  test(`${kind} a parent moved to maximum depth during conflict review requires explicit replacement`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open(); await f.check("Alpha");
    await draft(f, "Preserved draft", "group:destination"); await f.search("alpha");
    const latest = catalog(f), originalParent = latest.libraries[0].groups[1];
    let nested = originalParent.groups.pop();
    for (let depth = MAX_GROUP_DEPTH - 1; depth >= 2; depth--) nested = group(`deep-${depth}`, `Deep ${depth}`, [nested]);
    originalParent.groups.push(nested);
    await conflict(f, latest); await review(f);
    assert.equal(control(f, "name").value, "Preserved draft");
    assert.equal(control(f, "parent").value, "group:destination");
    assert.equal(control(f, "parent").selectedOptions[0].disabled, true);
    assert.match(control(f, "parent").selectedOptions[0].textContent, /다시 선택/u);
    assert.equal(f.filter().value, "alpha"); assert.equal(f.count(), "1개 선택");
    assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1);
    control(f, "parent").value = "root"; await control(f, "parent").emit("change");
    assert.equal(f.$("dialog-submit").disabled, false);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.actions[1].action.parentGroupId, null);
    assert.ok(catalog(f).libraries[0].groups.some(item => item.name === "Preserved draft"));
  });

  test(`${kind} replacing a deleted library requires a new parent choice even if its ID or root still exists`, async () => {
    for (const initialChoice of ["root", "group:parent"]) {
      const f = fixture(undefined, { bookmarks }); await f.open(); await f.check("Alpha"); await draft(f, "Preserved", initialChoice);
      const latest = catalog(f); latest.libraries.shift(); latest.libraries[0].groups.push(group("parent", "Unrelated parent"));
      await conflict(f, latest); await review(f);
      assert.equal(f.$("dialog-submit").disabled, true);
      const chooseLibrary = f.$("dialog-body").querySelector(".candidate-review-library");
      assert.equal(chooseLibrary.value, ""); chooseLibrary.value = "other-library"; await chooseLibrary.emit("change");
      assert.equal(control(f, "name").value, "Preserved"); assert.equal(f.count(), "1개 선택");
      assert.equal(f.$("dialog-submit").disabled, true, "library selection alone must not consent to root or a same-ID parent");
      assert.equal(control(f, "parent").selectedOptions[0].disabled, true);
      assert.match(control(f, "parent").selectedOptions[0].textContent, /다시 선택/u);
      await f.submit(); assert.equal(f.actions.length, 1);
      control(f, "parent").value = "group:parent"; await control(f, "parent").emit("change");
      assert.match(control(f, "preview").textContent, /Other library › Unrelated parent › Preserved/u);
      f.setResponse(null); await f.submit();
      assert.equal(f.actions[1].action.libraryId, "other-library");
      assert.equal(f.actions[1].action.parentGroupId, "parent"); assert.equal(f.actions[1].expectedRevision, 8);
    }
  });

  test(`${kind} hidden draft fields cannot block existing-group submit and toggling retains all unsaved input`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open(); await f.check("Alpha");
    const name = control(f, "name"), parent = control(f, "parent"), fields = control(f, "fields");
    const existing = f.$("dialog-body").querySelector(".candidate-target-group");
    assert.equal(fields.hidden, true); assert.equal(name.disabled, true); assert.equal(name.required, false); assert.equal(parent.disabled, true);
    await draft(f, "Draft", "group:parent"); await f.search("Beta"); await f.check("Beta");
    assert.equal(fields.hidden, false); assert.equal(name.disabled, false); assert.equal(name.required, true); assert.equal(parent.disabled, false);
    assert.equal(existing.disabled, true); assert.equal(existing.parentElement.hidden, true);
    assert.equal(control(f, "toggle").getAttribute("aria-expanded"), "true");
    await f.clickText("기존 그룹에 담기");
    assert.equal(fields.hidden, true); assert.equal(name.disabled, true); assert.equal(name.required, false); assert.equal(parent.disabled, true);
    assert.equal(existing.disabled, false); assert.equal(existing.parentElement.hidden, false);
    assert.equal(f.document.activeElement, existing);
    await f.clickText("새 그룹에 담기");
    assert.equal(name.value, "Draft"); assert.equal(parent.value, "group:parent");
    assert.equal(f.filter().value, "Beta"); assert.equal(f.count(), "2개 선택 · 화면 밖 1개 포함");
    assert.equal(f.document.activeElement, name); assert.equal(f.actions.length, 0);
    await f.clickText("기존 그룹에 담기"); await f.submit();
    assert.equal(f.actions.length, 1); assert.equal(f.actions[0].action.type, "addLinks");
    assert.ok(!flattenGroups(catalog(f).libraries[0]).some(row => row.group.name === "Draft"));
  });

  test(`${kind} cancelling a pending review cannot overwrite or toggle a newer new-group draft`, async () => {
    const f = fixture(undefined, { bookmarks }), pending = deferred(); await f.open(); await f.check("Alpha");
    await draft(f, "Old draft", "group:parent"); const latest = catalog(f); await conflict(f, latest);
    f.setLoadResponse(() => pending.promise); await review(f);
    const oldToggle = control(f, "toggle");
    assert.equal(oldToggle.disabled, true); assert.equal(control(f, "name").disabled, true);
    assert.equal(control(f, "parent").disabled, true); assert.equal(f.$("dialog-cancel").disabled, false);
    await oldToggle.emit("click"); await flush(); assert.equal(control(f, "fields").hidden, false);
    await f.$("dialog-cancel").emit("click"); await f.open(); await f.check("Gamma");
    await draft(f, "New draft", "group:destination"); await f.search("Gamma");
    const newName = control(f, "name"), newParent = control(f, "parent"), newCheck = f.checks()[0];
    const late = structuredClone(latest); late.libraries[0].name = "Stale title";
    pending.resolve({ ok: true, revision: 9, catalog: late }); await flush();
    await oldToggle.emit("click"); await flush();
    assert.equal(control(f, "name"), newName); assert.equal(control(f, "parent"), newParent);
    assert.equal(newName.value, "New draft"); assert.equal(newParent.value, "group:destination");
    assert.equal(control(f, "fields").hidden, false); assert.equal(control(f, "toggle").getAttribute("aria-expanded"), "true");
    assert.equal(f.checks()[0], newCheck); assert.equal(newCheck.checked, true);
    assert.equal(f.filter().value, "Gamma"); assert.equal(f.count(), "1개 선택");
    assert.equal(f.run("state.revision"), 8); assert.notEqual(catalog(f).libraries[0].name, "Stale title");
    assert.equal(f.actions.length, 1); assert.equal(f.loads(), 1); assert.equal(f.fetches(), 2);
  });

  test(`${kind} pending new-group save locks duplicate submits and restores draft controls after storage failure`, async () => {
    const f = fixture(undefined, { bookmarks }), pending = deferred(); await f.open(); await f.check("Beta");
    await draft(f, "Retry draft", "group:parent"); const before = catalog(f);
    f.setResponse(() => pending.promise); const saving = f.submit(); await flush();
    assert.equal(f.actions.length, 1); assert.equal(f.$("dialog-submit").disabled, true);
    assert.equal(f.$("dialog-cancel").disabled, true); assert.equal(control(f, "toggle").disabled, true);
    assert.equal(control(f, "name").disabled, true); assert.equal(control(f, "parent").disabled, true);
    await control(f, "toggle").emit("click"); await flush(); await f.submit(); await f.$("dialog-cancel").emit("click");
    assert.equal(f.$("dialog").open, true); assert.equal(control(f, "fields").hidden, false); assert.equal(f.actions.length, 1);
    pending.resolve({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }); await saving; await flush();
    assert.equal(control(f, "name").disabled, false); assert.equal(control(f, "name").required, true);
    assert.equal(control(f, "parent").disabled, false); assert.equal(control(f, "name").value, "Retry draft");
    assert.equal(control(f, "parent").value, "group:parent"); assert.equal(f.count(), "1개 선택");
    assert.equal(f.$("dialog-submit").disabled, false); assert.deepEqual(catalog(f), before);
    assert.equal(f.$("dialog-body").querySelector(".candidate-target-group").disabled, true);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 7);
    assert.equal(f.$("dialog").open, false);
    assert.equal(flattenGroups(catalog(f).libraries[0]).filter(row => row.group.name === "Retry draft").length, 1);
  });

  test(`${kind} reviewed renamed and moved parent keeps identity while preview shows its latest path`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open(); await f.check("Alpha");
    await draft(f, "Draft", "group:destination"); await f.search("alpha");
    const latest = catalog(f), moved = latest.libraries[0].groups[1].groups.pop();
    moved.name = "Renamed location"; latest.libraries[0].groups.push(group("replacement-parent", "New branch", [moved]));
    await conflict(f, latest); await review(f);
    assert.equal(control(f, "parent").value, "group:destination");
    assert.equal(control(f, "parent").selectedOptions[0].textContent, "New branch › Renamed location");
    assert.match(control(f, "preview").textContent, /New branch › Renamed location › Draft/u);
    assert.equal(control(f, "name").value, "Draft"); assert.equal(f.filter().value, "alpha");
    assert.equal(f.actions.length, 1); assert.equal(f.$("dialog-submit").disabled, false);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions[1].action.parentGroupId, "destination");
    const created = flattenGroups(catalog(f).libraries[0]).find(row => row.group.name === "Draft");
    assert.deepEqual(created.path.map(item => item.name), ["New branch", "Renamed location", "Draft"]);
  });
}
