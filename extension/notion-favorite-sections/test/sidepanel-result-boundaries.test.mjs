import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogAction, SYSTEM_GROUP_ID } from "../src/link-library.js";
import { fixture, flush, deferred } from "../test-support/candidate-picker-fixture.mjs";

function groupFixture() {
  const f = fixture(), catalog = structuredClone(f.context.initial.catalog);
  catalog.libraries[0].groups.push({ id: "moving", name: "Moving", collapsed: true, links: [], groups: [
    { id: "moving-child", name: "Moving child", collapsed: true, links: [], groups: [] }
  ] });
  f.setCatalog(catalog, 7); f.context.initial = { catalog, revision: 7 }; f.run("adopt(initial)"); return f;
}
function setSearch(f, value = "Saved") { f.$("search").value = value; f.run("render()"); }
async function openMove(f, kind = "link", destination = "destination") {
  const id = kind === "group" ? "moving" : "saved";
  const rows = f.document.querySelectorAll(kind === "group" ? "[data-group-id]" : "[data-link-id]");
  const row = rows.find(item => (kind === "group" ? item.dataset.groupId : item.dataset.linkId) === id);
  const control = row.querySelectorAll("button").find(item => item.textContent === "다른 그룹으로 이동");
  control.focus(); await control.emit("click"); await flush(); await f.target(destination); return control;
}
async function openAdd(f) {
  f.$("add-link").focus(); await f.$("add-link").emit("click"); await flush();
  const [url, title] = f.$("dialog-body").querySelectorAll("input");
  url.value = "https://example.org/new-boundary"; title.value = "New boundary";
  await f.target("destination");
}
async function openEditor(f, kind) { return kind === "add" ? openAdd(f) : openMove(f, kind); }
const queryFor = kind => kind === "group" ? "Moving" : "Saved";
const fixtureFor = kind => kind === "group" ? groupFixture() : fixture();

for (const kind of ["link", "group"]) test(`${kind} move to its existing location does not clear search or create a result reveal`, async () => {
  const f = kind === "group" ? groupFixture() : fixture();
  const query = kind === "group" ? "Moving" : "Saved";
  setSearch(f, query);
  const before = structuredClone(f.context.initial.catalog);
  f.setResponse(async action => {
    const catalog = applyCatalogAction(before, structuredClone(action));
    assert.deepEqual(catalog, before, "real reducer confirms true no-op");
    return { ok: true, catalog, revision: 7, canUndo: false };
  });
  await openMove(f, kind, kind === "group" ? "" : SYSTEM_GROUP_ID);
  await f.submit();
  assert.equal(f.$("dialog").open, kind === "group", "group menu blocks an unchanged parent before dispatch");
  assert.equal(f.$("search").value, query);
  assert.equal(f.run("state.revision"), 7);
  assert.deepEqual(structuredClone(f.run("state.catalog")), before);
  assert.equal(f.document.activeElement.scrolled, undefined);
});

for (const kind of ["link", "group"]) test(`drag callback: ${kind} same-location no-op retains the search and current focus`, async () => {
  const f = kind === "group" ? groupFixture() : fixture();
  const query = kind === "group" ? "Moving" : "Saved";
  setSearch(f, query); f.$("search").focus();
  const before = structuredClone(f.context.initial.catalog);
  f.setResponse(async action => {
    const catalog = applyCatalogAction(before, structuredClone(action));
    assert.deepEqual(catalog, before);
    return { ok: true, catalog, revision: 7, canUndo: false };
  });
  await f.dragMove(kind === "group" ? { type: "moveGroup", groupId: "moving", targetParentGroupId: null }
    : { type: "moveLink", linkId: "saved", targetGroupId: SYSTEM_GROUP_ID }, 7);
  assert.equal(f.$("search").value, query);
  assert.ok(f.document.activeElement === f.$("search"), "search retains focus");
  assert.equal(f.run("state.revision"), 7);
  assert.deepEqual(structuredClone(f.run("state.catalog")), before);
});

for (const kind of ["add", "link", "group"]) {
  test(`${kind}: cancelling the dialog preserves the search, fold choices and content`, async () => {
    const f = fixtureFor(kind), query = queryFor(kind); setSearch(f, query);
    const before = structuredClone(f.run("state.catalog"));
    await openEditor(f, kind); await f.$("dialog-cancel").emit("click");
    assert.equal(f.$("dialog").open, false);
    assert.equal(f.$("search").value, query);
    assert.deepEqual(structuredClone(f.run("state.catalog")), before);
    assert.equal(f.actions.length, 0);
    assert.equal(f.document.activeElement.scrolled, undefined);
  });
  test(`${kind}: save failure keeps the user's search and dialog focus without revealing anything`, async () => {
    const f = fixtureFor(kind), query = queryFor(kind); setSearch(f, query);
    const before = structuredClone(f.run("state.catalog"));
    f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "Synthetic save failure" }));
    await openEditor(f, kind); f.$("dialog-submit").focus(); await f.submit();
    assert.equal(f.$("dialog").open, true);
    assert.equal(f.$("search").value, query);
    assert.deepEqual(structuredClone(f.run("state.catalog")), before);
    assert.equal(f.actions.length, 1);
    assert.ok(f.document.activeElement === f.$("dialog-submit"), "failed submit retains dialog focus");
    assert.equal(f.document.activeElement.scrolled, undefined);
    assert.match(f.$("dialog-error").textContent, /Synthetic save failure/u);
  });
  test(`${kind}: conflict and read-only latest review preserve search and never reveal a not-yet-saved result`, async () => {
    const f = fixtureFor(kind), query = queryFor(kind); setSearch(f, query);
    const latest = structuredClone(f.run("state.catalog")); latest.libraries[1].name = "Other renamed";
    f.setCatalog(latest, 8);
    f.setResponse(async () => ({ ok: false, code: "CONFLICT", conflict: true, catalog: latest, revision: 8, error: "Synthetic conflict" }));
    await openEditor(f, kind); await f.submit();
    assert.equal(f.$("search").value, query);
    const review = f.$("dialog-body").querySelector(".edit-review-button");
    assert.ok(f.document.activeElement === review, "conflict focuses review control");
    await review.emit("click"); await flush();
    assert.equal(f.actions.length, 1);
    assert.equal(f.loads(), 1);
    assert.equal(f.$("search").value, query);
    assert.deepEqual(structuredClone(f.run("state.catalog")), latest);
    assert.equal(f.$("dialog").open, true);
    assert.equal(f.$("dialog-body").contains(f.document.activeElement), true);
    assert.equal(f.document.activeElement.scrolled, undefined);
  });
}

for (const kind of ["link", "group"]) test(`drag callback: failed ${kind} move leaves search, folds and focus untouched`, async () => {
  const f = fixtureFor(kind), query = queryFor(kind); setSearch(f, query); f.$("search").focus();
  const before = structuredClone(f.run("state.catalog"));
  f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "Synthetic save failure" }));
  await assert.rejects(f.dragMove(kind === "group" ? { type: "moveGroup", groupId: "moving", targetParentGroupId: "destination" }
    : { type: "moveLink", linkId: "saved", targetGroupId: "destination" }, 7), /Synthetic save failure/u);
  assert.equal(f.$("search").value, query);
  assert.ok(f.document.activeElement === f.$("search"), "failed drag preserves focus");
  assert.deepEqual(structuredClone(f.run("state.catalog")), before);
  assert.equal(f.run("pendingTreeEffect"), null);
});

test("deferred manual-add result does not focus a row inside a newer open dialog", async () => {
  const f = fixture(); setSearch(f); await openAdd(f);
  f.setInteraction(true); await f.submit();
  assert.equal(f.run("deferredRender"), true); assert.equal(f.$("dialog").open, false);
  await f.$("add-group").emit("click"); await flush();
  const nextInput = f.$("dialog-body").querySelector("input"); assert.ok(f.document.activeElement === nextInput);
  f.setInteraction(false); f.run("flushPendingUI()");
  assert.ok(f.document.activeElement === nextInput, "newer open dialog retains focus");
  assert.equal(f.$("dialog").open, true);
  assert.equal(f.document.activeElement.scrolled, undefined);
});

test("deferred drag result does not steal focus after the user switches library", async () => {
  const f = fixture(); setSearch(f); f.setDragging(true);
  await f.dragMove({ type: "moveLink", linkId: "saved", targetGroupId: "destination" }, 7);
  assert.equal(f.run("deferredRender"), true);
  f.$("library-picker").value = "other-library"; f.$("library-picker").focus(); await f.$("library-picker").emit("change");
  f.setDragging(false); f.run("flushPendingUI()");
  assert.equal(f.run("libraryId"), "other-library");
  assert.ok(f.document.activeElement === f.$("library-picker"), "switched library retains focus");
  assert.equal(f.document.activeElement.scrolled, undefined);
});

test("deferred result does not regain focus after a newer dialog has already been opened and cancelled", async () => {
  const f = fixture(); setSearch(f); await openAdd(f);
  f.setInteraction(true); await f.submit();
  f.$("add-group").focus(); await f.$("add-group").emit("click"); await flush();
  await f.$("dialog-cancel").emit("click"); assert.ok(f.document.activeElement === f.$("add-group"));
  f.setInteraction(false); f.run("flushPendingUI()");
  assert.ok(f.document.activeElement === f.$("add-group"), "cancelled newer dialog must invalidate old reveal focus");
});

test("deferred result does not focus or scroll the tree while the theme dialog is open", async () => {
  const f = fixture(); setSearch(f); await openAdd(f);
  f.setInteraction(true); await f.submit();
  const theme = f.$("theme-dialog"), colorInput = f.document.createElement("input");
  theme.append(colorInput); theme.showModal(); colorInput.focus();
  f.setInteraction(false); f.run("flushPendingUI()");
  assert.ok(f.document.activeElement === colorInput, "theme dialog retains focus");
  const result = f.document.querySelectorAll("a").find(item => item.href === "https://example.org/new-boundary");
  assert.ok(result); assert.equal(result.scrolled, undefined);
});

function pendingDrag(f) {
  const before = structuredClone(f.run("state.catalog")), pending = deferred();
  f.setResponse(async action => {
    await pending.promise;
    return { ok: true, catalog: applyCatalogAction(before, structuredClone(action)), revision: 8, canUndo: true };
  });
  const moved = f.dragMove({ type: "moveLink", linkId: "saved", targetGroupId: "destination" }, 7);
  return { moved, finish: () => pending.resolve() };
}

test("a library switch during drag save remains selected when the original move completes", async () => {
  const f = fixture(); setSearch(f); const pending = pendingDrag(f);
  f.$("library-picker").value = "other-library"; f.$("library-picker").focus(); await f.$("library-picker").emit("change");
  f.$("search").value = "Other query";
  pending.finish(); await pending.moved;
  assert.equal(f.run("libraryId"), "other-library");
  assert.equal(f.$("search").value, "Other query");
  assert.ok(f.document.activeElement === f.$("library-picker"), "later library choice retains focus");
  assert.equal(f.run('state.catalog.libraries[0].groups.find(group => group.id === "parent").groups[0].links[0].id'), "saved");
});

test("a newer dialog opened during drag save keeps its return focus when that save completes", async () => {
  const f = fixture(); setSearch(f); const pending = pendingDrag(f);
  f.$("add-group").focus(); await f.$("add-group").emit("click"); await flush();
  const input = f.$("dialog-body").querySelector("input"); input.value = "In-progress group";
  pending.finish(); await pending.moved;
  assert.equal(f.$("dialog").open, true);
  assert.equal(f.$("search").value, "Saved");
  assert.equal(input.value, "In-progress group");
  assert.ok(f.document.activeElement === input, "newer dialog retains input focus");
  const result = f.document.querySelectorAll("a").find(item => item.href === "https://example.com/saved");
  assert.ok(result); assert.equal(result.scrolled, undefined);
  await f.$("dialog-cancel").emit("click");
  assert.ok(f.document.activeElement === f.$("add-group"), "newer dialog keeps its own return focus");
});

test("a newer dialog opened and cancelled during drag save invalidates the original result reveal", async () => {
  const f = fixture(); setSearch(f); const pending = pendingDrag(f);
  f.$("add-group").focus(); await f.$("add-group").emit("click"); await flush();
  await f.$("dialog-cancel").emit("click");
  pending.finish(); await pending.moved;
  assert.equal(f.$("dialog").open, false);
  assert.equal(f.$("search").value, "Saved");
  assert.ok(f.document.activeElement === f.$("add-group"), "cancelled newer dialog does not reactivate an old move reveal");
});
