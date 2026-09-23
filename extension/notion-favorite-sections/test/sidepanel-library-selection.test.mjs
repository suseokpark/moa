import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const script = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const shipped = name => {
  const pattern = new RegExp(`(?:async )?function ${name}\\(`, "u");
  const start = script.search(pattern);
  assert.ok(start >= 0, `missing shipped ${name} function`);
  const after = script.slice(start).search(/\n(?:async )?function /u);
  assert.ok(after > 0, `review ${name} fixture boundary`);
  return script.slice(start, start + after);
};
const catalog = (...ids) => ({ libraries: ids.map(id => ({ id, name: id, groups: [] })) });

// Exercise the shipped dialog -> dispatch -> adopt chain. The platform result
// and DOM rendering are controlled here; browser QA separately checks focus.
function fixture() {
  const search = { value: "previous search" };
  const picker = { id: "library-picker" };
  const oldOrigin = { id: "add-library" };
  const input = { value: "" };
  const renders = [], calls = [];
  let submit;
  let response = { ok: true, revision: 2, catalog: catalog("old", "new") };
  const context = vm.createContext({
    state: { revision: 1, catalog: catalog("old"), canUndo: false },
    libraryId: "old", suppressedFolds: new Set(["g:old:collapsed"]), mutationBusy: false,
    dialogOrigin: oldOrigin, dialogReturnKeys: ["old-key"],
    $: id => ({ search, "library-picker": picker })[id],
    showDialog(_title, _submitText, populate, onSubmit) { populate({}); submit = onSubmit; },
    field(_body, _label, current) { input.value = current; return input; },
    platform: { dispatch: async (action, revision) => { calls.push({ action, revision }); return response; } },
    announce() {},
    render() { renders.push({ libraryId: context.libraryId, search: search.value }); }
  });
  vm.runInContext(["library", "adopt", "requireResult", "dispatch", "nameDialog"].map(shipped).join("\n"), context);
  return {
    context, search, picker, oldOrigin, input, calls, renders,
    open(action = { type: "addLibrary" }, current = "") { context.nameDialog("Synthetic dialog", action, current); },
    submit() { return submit(); },
    respond(value) { response = value; }
  };
}

test("creating a library selects it, clears the old search and fold overrides, and returns focus to its picker", async () => {
  const view = fixture();
  view.open(); view.input.value = "  New library  ";
  assert.equal(await view.submit(), true);
  assert.equal(view.context.libraryId, "new", "a newly created library must become the visible destination");
  assert.equal(view.search.value, "", "a prior library search must not hide the new library empty state");
  assert.equal(view.context.suppressedFolds.size, 0);
  assert.equal(view.context.dialogOrigin, view.picker);
  assert.deepEqual(view.renders.at(-1), { libraryId: "new", search: "" });
  assert.equal(view.calls[0].action.name, "New library");
  assert.equal(view.calls[0].revision, 1);
});

test("creation compares IDs at submit time, not against an outdated dialog-open catalog", async () => {
  const view = fixture(); view.open();
  view.context.state = { revision: 1, catalog: catalog("old", "already-present") };
  view.respond({ ok: true, revision: 2, catalog: catalog("old", "already-present", "new") });
  await view.submit();
  assert.equal(view.context.libraryId, "new");
});

for (const type of ["renameLibrary", "addGroup", "renameGroup"]) {
  test(`${type} preserves the selected library, search, fold overrides and original return focus`, async () => {
    const view = fixture();
    view.respond({ ok: true, revision: 2, catalog: catalog("old", "existing-other") });
    view.open({ type }, "Existing name");
    assert.equal(await view.submit(), true);
    assert.equal(view.context.libraryId, "old");
    assert.equal(view.search.value, "previous search");
    assert.equal(view.context.suppressedFolds.size, 1);
    assert.equal(view.context.dialogOrigin, view.oldOrigin);
    assert.equal(view.renders.length, 1);
  });
}

test("failed library creation does not change selection or clear the user's view", async () => {
  const view = fixture(); view.open();
  view.respond({ ok: false, error: "Synthetic save failure" });
  await assert.rejects(view.submit(), /Synthetic save failure/u);
  assert.equal(view.context.libraryId, "old");
  assert.equal(view.search.value, "previous search");
  assert.equal(view.context.suppressedFolds.size, 1);
  assert.equal(view.context.dialogOrigin, view.oldOrigin);
  assert.equal(view.renders.length, 0);
});

test("a conflict can adopt the latest catalog without selecting an unrelated library from it", async () => {
  const view = fixture(); view.open();
  view.respond({ ok: false, conflict: true, error: "Synthetic conflict", revision: 3, catalog: catalog("old", "someone-elses-library") });
  await assert.rejects(view.submit(), /Synthetic conflict/u);
  assert.equal(view.context.libraryId, "old");
  assert.equal(view.search.value, "previous search");
  assert.equal(view.context.suppressedFolds.size, 1);
  assert.equal(view.context.dialogOrigin, view.oldOrigin);
  assert.equal(view.renders.length, 1);
});

for (const ids of [["old"], ["old", "ambiguous-one", "ambiguous-two"]]) {
  test(`a success result with ${ids.length - 1} new IDs does not guess which library to select`, async () => {
    const view = fixture(); view.open();
    view.respond({ ok: true, revision: 2, catalog: catalog(...ids) });
    assert.equal(await view.submit(), true);
    assert.equal(view.context.libraryId, "old");
    assert.equal(view.search.value, "previous search");
    assert.equal(view.context.suppressedFolds.size, 1);
    assert.equal(view.context.dialogOrigin, view.oldOrigin);
    assert.equal(view.renders.length, 1);
  });
}
