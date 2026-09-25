import assert from "node:assert/strict";
import test from "node:test";
import { fixture, flush } from "../test-support/candidate-picker-fixture.mjs";
import { createCatalogService, FAVMOA_STORAGE_KEY } from "../src/favmoa-service.js";

async function add(f) {
  await f.$("add-link").emit("click"); await flush();
  const [url, title] = f.$("dialog-body").querySelectorAll("input");
  url.value = "https://example.org/new-result"; title.value = "New result";
  await f.target("destination");
}
test("manual add clears search, expands its full destination path, and focuses the saved result after closing", async () => {
  const f = fixture(); f.$("search").value = "unmatched query"; f.run("render()");
  await add(f); await f.submit();
  assert.equal(f.$("dialog").open, false); assert.equal(f.actions.length, 1);
  assert.equal(f.$("search").value, "");
  assert.equal(f.run('library().groups.find(group => group.id === "parent").collapsed'), false);
  assert.equal(f.run('library().groups.find(group => group.id === "parent").groups[0].collapsed'), false);
  const anchor = f.document.querySelectorAll("a").find(item => item.href === "https://example.org/new-result");
  assert.ok(anchor); assert.equal(f.document.activeElement, anchor);
  assert.equal(anchor.scrolled, true);
});

for (const kind of ["link", "group"]) test(`drag callback: ${kind} move reveals destination after drag-end paint without a second write`, async () => {
  const f = kind === "group" ? groupFixture() : fixture(); f.$("search").value = kind === "group" ? "Moving" : "Saved"; f.run("render()");
  const action = kind === "group" ? { type: "moveGroup", groupId: "moving", targetParentGroupId: "destination" }
    : { type: "moveLink", linkId: "saved", targetGroupId: "destination" };
  f.setDragging(true); await f.dragMove(action, 7);
  assert.equal(f.actions.length, 1); assert.equal(f.$("search").value, "");
  assert.equal(f.run("deferredRender"), true);
  f.setDragging(false); f.run("flushPendingUI()");
  const row = f.document.querySelectorAll(kind === "group" ? "[data-group-id]" : "[data-link-id]")
    .find(item => (kind === "group" ? item.dataset.groupId : item.dataset.linkId) === (kind === "group" ? "moving" : "saved"));
  assert.ok(row); assert.equal(f.document.activeElement, row.querySelector(kind === "group" ? ".fold" : "a"));
  assert.equal(f.document.activeElement.scrolled, true); assert.equal(f.actions.length, 1);
});

function groupFixture() {
  const f = fixture(), catalog = structuredClone(f.context.initial.catalog);
  catalog.libraries[0].groups.push({ id: "moving", name: "Moving", collapsed: true, links: [], groups: [
    { id: "moving-child", name: "Moving child", collapsed: true, links: [], groups: [] }
  ] });
  f.setCatalog(catalog, 7); f.context.initial = { catalog, revision: 7 }; f.run("adopt(initial)"); return f;
}
test("group menu move clears a search that would hide the moved group and reveals its header, preserving its own fold", async () => {
  const f = groupFixture(); f.$("search").value = "Moving"; f.run("render()");
  const row = f.document.querySelectorAll("[data-group-id]").find(item => item.dataset.groupId === "moving");
  const control = row.querySelectorAll("button").find(item => item.textContent === "다른 그룹으로 이동");
  control.focus(); await control.emit("click"); await flush(); await f.target("destination"); await f.submit();
  assert.equal(f.$("dialog").open, false); assert.equal(f.$("search").value, "");
  const moved = f.document.querySelectorAll("[data-group-id]").find(item => item.dataset.groupId === "moving");
  assert.ok(moved); assert.equal(moved.querySelector(".fold").getAttribute("aria-expanded"), "false");
  assert.equal(f.document.activeElement, moved.querySelector(".fold"));
  assert.equal(moved.querySelector(".fold").scrolled, true);
});

async function move(f) {
  const row = f.document.querySelectorAll("[data-link-id]").find(item => item.dataset.linkId === "saved");
  const control = row.querySelectorAll("button").find(item => item.textContent === "다른 그룹으로 이동");
  control.focus(); await control.emit("click"); await flush(); await f.target("destination");
}
test("single-link menu move reveals the moved link rather than restoring focus to its former location", async () => {
  const f = fixture(); f.$("search").value = "Saved"; f.run("render()");
  await move(f); await f.submit();
  assert.equal(f.$("search").value, ""); assert.equal(f.$("dialog").open, false);
  assert.equal(f.actions.length, 1);
  assert.equal(f.run('library().groups.find(group => group.id === "parent").collapsed'), false);
  const anchor = f.document.querySelectorAll("a").find(item => item.href === "https://example.com/saved");
  assert.ok(anchor); assert.equal(f.document.activeElement, anchor); assert.equal(anchor.scrolled, true);
});

function attachService(f) {
  const original = structuredClone(f.run("state.catalog")), writes = [], requests = [];
  const values = { [FAVMOA_STORAGE_KEY]: { catalog: original, revision: 7 } };
  const sender = { id: "result-test", url: "chrome-extension://result-test/sidepanel/sidepanel.html" };
  const service = createCatalogService({ runtimeId: sender.id, storage: {
    async setAccessLevel() {},
    async get(keys) { return structuredClone(Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]]))); },
    async set(next) { writes.push(structuredClone(next)); Object.assign(values, structuredClone(next)); }
  } });
  f.context.realDispatch = async (action, expectedRevision) => {
    requests.push({ action: structuredClone(action), expectedRevision });
    return service.handle({ type: "FAVMOA_ACTION", action: structuredClone(action), expectedRevision }, sender);
  };
  f.context.realUndo = expectedRevision => service.handle({ type: "FAVMOA_UNDO", expectedRevision }, sender);
  f.run("platform.dispatch = realDispatch; platform.undo = realUndo");
  return { original, writes, values, requests };
}
for (const kind of ["add", "move"]) test(`${kind}: full UI and service persist result+reveal once and a UI Undo restores both`, async () => {
  const f = fixture(), store = attachService(f); f.$("search").value = "Saved"; f.run("render()");
  await (kind === "add" ? add(f) : move(f)); await f.submit();
  assert.equal(store.writes.length, 1); assert.equal(f.run("state.revision"), 8); assert.equal(f.$("search").value, "");
  assert.equal(f.document.activeElement.tagName, "A");
  await f.$("undo").emit("click"); assert.equal(store.writes.length, 2);
  assert.deepEqual(structuredClone(f.run("state.catalog")), store.original);
});

test("same-group move preserves search, folds, and prior Undo instead of pretending to move the result", async () => {
  const f = fixture(), store = attachService(f); f.$("search").value = "Saved"; f.run("render()");
  await move(f); await f.target("system-group-uncategorized"); await f.submit();
  assert.equal(f.$("search").value, "Saved"); assert.equal(store.writes.length, 0);
  assert.deepEqual(structuredClone(f.run("state.catalog")), store.original);
  assert.match(f.$("status").textContent, /이미.*그룹/u);
});
