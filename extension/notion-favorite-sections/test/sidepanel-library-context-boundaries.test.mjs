import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogAction } from "../src/link-library.js";
import { fixture, deferred } from "../test-support/candidate-picker-fixture.mjs";

async function switchLibrary(f, id) {
  f.$("library-picker").value = id;
  f.$("library-picker").focus();
  await f.$("library-picker").emit("change");
}

test("switching library ends old link selection immediately even while tree painting is deferred", async () => {
  const f = fixture();
  await f.$("select-mode").emit("click");
  const checkbox = f.$("tree").querySelector('input');
  assert.ok(checkbox, "saved link has a selection checkbox");
  checkbox.checked = true; await checkbox.emit("change");
  assert.equal(f.run("linkSelection.count()"), 1);
  f.setInteraction(true);
  await switchLibrary(f, "other-library");
  assert.equal(f.run("linkSelection.isActive()"), false, "old-library selection must stop before deferred paint");
  assert.equal(f.run("linkSelection.count()"), 0);
  f.setInteraction(false); f.run("flushPendingUI()");
  assert.equal(f.$("selection-bar").hidden, true);
  assert.equal(f.$("move-selected").disabled, true);
  assert.equal(f.actions.length, 0);
});

test("a queued saved-location reveal cannot regain focus after switching away and back", async () => {
  const f = fixture();
  f.run('currentPage = { title: "Saved", url: "https://example.com/saved" };');
  f.setInteraction(true);
  await f.$("save-current").emit("click");
  await switchLibrary(f, "other-library");
  await switchLibrary(f, "library-personal");
  f.setInteraction(false); f.run("flushPendingUI()");
  assert.ok(f.document.activeElement === f.$("library-picker"), "later library navigation retains focus");
  const row = f.$("tree").querySelector('[data-link-id="saved"]');
  assert.ok(row, "saved link is visible after returning");
  assert.equal(row.scrolled, undefined, "old saved-location reveal must not scroll the tree");
  assert.equal(f.actions.length, 0);
});

test("a pending link move does not clear a fresh search after the user switches away and back", async () => {
  const f = fixture(), gate = deferred(), before = structuredClone(f.run("state.catalog"));
  f.setResponse(async action => {
    await gate.promise;
    return { ok: true, catalog: applyCatalogAction(before, structuredClone(action)), revision: 8, canUndo: true };
  });
  const moved = f.dragMove({ type: "moveLink", linkId: "saved", targetGroupId: "destination" }, 7);
  await switchLibrary(f, "other-library");
  await switchLibrary(f, "library-personal");
  f.$("search").value = "fresh search after returning";
  f.$("search").focus(); await f.$("search").emit("input");
  gate.resolve(); await moved;
  assert.equal(f.$("search").value, "fresh search after returning", "old save must not reset the user's newer query");
  assert.ok(f.document.activeElement === f.$("search"), "fresh search retains focus");
  assert.equal(f.actions.length, 1, "view navigation performs no extra content actions");
  assert.equal(f.run('library().groups.find(group => group.id === "parent").groups[0].links[0].id'), "saved", "original link move still saves");
});

test("a pending group move preserves the fresh view after a library round trip without cancelling the save", async () => {
  const f = fixture(), gate = deferred(), catalog = structuredClone(f.run("state.catalog"));
  catalog.libraries[0].groups.push({ id: "moving", name: "Moving", collapsed: true, links: [], groups: [] });
  f.context.groupBoundaryCatalog = catalog;
  f.run("adopt({ catalog: groupBoundaryCatalog, revision: 7 })");
  f.setResponse(async action => {
    await gate.promise;
    return { ok: true, catalog: applyCatalogAction(catalog, structuredClone(action)), revision: 8, canUndo: true };
  });
  const moved = f.dragMove({ type: "moveGroup", groupId: "moving", targetParentGroupId: "destination" }, 7);
  await switchLibrary(f, "other-library"); await switchLibrary(f, "library-personal");
  f.$("search").value = "fresh group query";
  f.$("search").focus(); await f.$("search").emit("input");
  gate.resolve(); await moved;
  assert.equal(f.$("search").value, "fresh group query");
  assert.ok(f.document.activeElement === f.$("search"), "newer group query retains focus");
  assert.equal(f.actions.length, 1);
  assert.equal(f.run('library().groups.find(group => group.id === "parent").groups[0].groups[0].id'), "moving");
});

async function ineffectiveSwitch(f, kind) {
  if (kind === "same") return switchLibrary(f, "library-personal");
  f.$("library-picker").focus();
  // An invalid native select value becomes empty; pass the stale option ID
  // explicitly because this synthetic select instead defaults to option one.
  await f.$("library-picker").emit("change", { target: { value: "removed-library" } });
}

for (const kind of ["same", "invalid"]) {
  test(`${kind} library selection does not cancel a legitimate queued saved-location reveal`, async () => {
    const f = fixture();
    f.run('currentPage = { title: "Saved", url: "https://example.com/saved" };');
    f.setInteraction(true); await f.$("save-current").emit("click");
    await ineffectiveSwitch(f, kind);
    f.setInteraction(false); f.run("flushPendingUI()");
    const row = f.$("tree").querySelector('[data-link-id="saved"]');
    assert.ok(row);
    assert.ok(f.document.activeElement === row.querySelector("a"), "unchanged view keeps its requested result focus");
    assert.equal(row.scrolled, true);
    assert.equal(f.actions.length, 0);
  });

  test(`${kind} library selection preserves existing multi-selection even during deferred painting`, async () => {
    const f = fixture();
    await f.$("select-mode").emit("click");
    const checkbox = f.$("tree").querySelector("input");
    checkbox.checked = true; await checkbox.emit("change");
    f.setInteraction(true); await ineffectiveSwitch(f, kind);
    assert.equal(f.run("linkSelection.isActive()"), true);
    assert.equal(f.run("linkSelection.count()"), 1);
    f.setInteraction(false); f.run("flushPendingUI()");
    assert.equal(f.$("selection-bar").hidden, false);
    assert.equal(f.$("move-selected").disabled, false);
    assert.equal(f.actions.length, 0);
  });
}
