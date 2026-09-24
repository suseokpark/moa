import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog } from "../src/link-library.js";
import { fixture as pickerFixture } from "../test-support/candidate-picker-fixture.mjs";

const catalog = (...ids) => {
  const result = createCatalog();
  result.libraries = ids.map(id => ({
    ...structuredClone(result.libraries[0]), id, name: id,
    groups: [{ id: "existing-group", name: "Existing name", collapsed: false, groups: [], links: [] }]
  }));
  return result;
};

// Use the complete shipped handlers, valid catalogs and actual rendering. The
// synthetic platform controls responses; these checks do not claim native QA.
function fixture() {
  const view = pickerFixture();
  const search = view.$("search"), picker = view.$("library-picker"), oldOrigin = view.$("add-library");
  const renders = [];
  let response = { ok: true, revision: 2, catalog: catalog("old", "new") };
  view.context.selectionCatalog = catalog("old");
  view.context.recordSelectionRender = snapshot => renders.push(JSON.parse(JSON.stringify(snapshot)));
  view.run(`
    state = { revision: 1, catalog: selectionCatalog, canUndo: false };
    libraryId = "old"; suppressedFolds = new Set(["g:old:collapsed"]);
    const selectionOriginalRender = render;
    render = function () { recordSelectionRender({ libraryId, search: $("search").value }); return selectionOriginalRender(); };
  `);
  search.value = "previous search";
  view.setResponse(async () => response);
  return {
    ...view, search, picker, oldOrigin, calls: view.actions, renders,
    get input() { return view.$("dialog-body").querySelector("input"); },
    open(action = { type: "addLibrary" }, current = "New library") {
      view.context.selectionAction = action;
      view.context.selectionCurrent = current;
      oldOrigin.focus();
      view.run('nameDialog("Synthetic dialog", selectionAction, selectionCurrent);');
    },
    submit() { return view.run("dialogSubmit()"); },
    respond(value) { response = value; },
    setVisibleState(value) { view.context.selectionState = value; view.run("state = selectionState;"); }
  };
}

test("creating a library selects it, clears the old search and fold overrides, and returns focus to its picker", async () => {
  const view = fixture();
  view.open(); view.input.value = "  New library  ";
  assert.equal(await view.submit(), true);
  assert.equal(view.run("libraryId"), "new", "a newly created library must become the visible destination");
  assert.equal(view.search.value, "", "a prior library search must not hide the new library empty state");
  assert.equal(view.run("suppressedFolds.size"), 0);
  assert.equal(view.run("dialogOrigin"), view.picker);
  assert.deepEqual(view.renders.at(-1), { libraryId: "new", search: "" });
  assert.equal(view.calls[0].action.name, "New library");
  assert.equal(view.calls[0].expectedRevision, 1);
});

test("creation compares IDs at submit time, not against an outdated dialog-open catalog", async () => {
  const view = fixture(); view.open();
  view.setVisibleState({ revision: 1, catalog: catalog("old", "already-present") });
  view.respond({ ok: true, revision: 2, catalog: catalog("old", "already-present", "new") });
  await view.submit();
  assert.equal(view.run("libraryId"), "new");
});

for (const type of ["renameLibrary", "addGroup", "renameGroup"]) {
  test(`${type} preserves the selected library, search, fold overrides and original return focus`, async () => {
    const view = fixture();
    view.respond({ ok: true, revision: 2, catalog: catalog("old", "existing-other") });
    view.open({ type, ...(type === "renameGroup" ? { groupId: "existing-group" } : {}) }, "Existing name");
    assert.equal(await view.submit(), true);
    assert.equal(view.run("libraryId"), "old");
    assert.equal(view.search.value, "previous search");
    assert.equal(view.run("suppressedFolds.size"), 1);
    assert.equal(view.run("dialogOrigin"), view.oldOrigin);
    assert.equal(view.renders.length, 1);
  });
}

test("failed library creation does not change selection or clear the user's view", async () => {
  const view = fixture(); view.open();
  view.respond({ ok: false, error: "Synthetic save failure" });
  await assert.rejects(view.submit(), /Synthetic save failure/u);
  assert.equal(view.run("libraryId"), "old");
  assert.equal(view.search.value, "previous search");
  assert.equal(view.run("suppressedFolds.size"), 1);
  assert.equal(view.run("dialogOrigin"), view.oldOrigin);
  assert.equal(view.renders.length, 0);
});

test("a conflict can adopt the latest catalog without selecting an unrelated library from it", async () => {
  const view = fixture(); view.open();
  view.respond({ ok: false, conflict: true, code: "CONFLICT", error: "Synthetic conflict", revision: 3, catalog: catalog("old", "someone-elses-library") });
  await assert.rejects(view.submit(), /Synthetic conflict/u);
  assert.equal(view.run("libraryId"), "old");
  assert.equal(view.search.value, "previous search");
  assert.equal(view.run("suppressedFolds.size"), 1);
  assert.equal(view.run("dialogOrigin"), view.oldOrigin);
  assert.equal(view.renders.length, 1);
});

for (const ids of [["old"], ["old", "ambiguous-one", "ambiguous-two"]]) {
  test(`a success result with ${ids.length - 1} new IDs does not guess which library to select`, async () => {
    const view = fixture(); view.open();
    view.respond({ ok: true, revision: 2, catalog: catalog(...ids) });
    assert.equal(await view.submit(), true);
    assert.equal(view.run("libraryId"), "old");
    assert.equal(view.search.value, "previous search");
    assert.equal(view.run("suppressedFolds.size"), 1);
    assert.equal(view.run("dialogOrigin"), view.oldOrigin);
    assert.equal(view.renders.length, 1);
  });
}
