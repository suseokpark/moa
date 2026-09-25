import assert from "node:assert/strict";
import test from "node:test";
import { fixture, flush } from "../test-support/candidate-picker-fixture.mjs";
import { createCatalogService, FAVMOA_STORAGE_KEY } from "../src/favmoa-service.js";

function populatedFixture() {
  const f = fixture(), catalog = structuredClone(f.context.initial.catalog);
  catalog.libraries[1].groups[0].links.push({ id: "astronomy", title: "천문 관측 안내", url: "https://example.org/astronomy", icon: "", provider: "generic" });
  f.setCatalog(catalog, 7); f.context.initial = { catalog, revision: 7, canUndo: true }; f.run("adopt(initial)");
  return f;
}
async function query(f, value) { f.$("search").value = value; await f.$("search").emit("input"); }
async function switchTo(f, value) { f.$("library-picker").value = value; await f.$("library-picker").emit("change"); }
const visibleIds = f => f.$("tree").querySelectorAll("[data-link-id]").map(row => row.dataset.linkId);

test("switching to another library clears the previous query and shows its links without writing or consuming Undo", async () => {
  const f = populatedFixture(), before = structuredClone(f.run("state"));
  await query(f, "Saved"); assert.deepEqual(visibleIds(f), ["saved"]);
  f.$("library-picker").focus(); await switchTo(f, "other-library");
  assert.equal(f.$("search").value, "");
  assert.deepEqual(visibleIds(f), ["astronomy"]);
  assert.equal(f.$("link-count").textContent, "내 링크 1개");
  assert.equal(f.$("clear-search").hidden, true);
  assert.ok(f.document.activeElement === f.$("library-picker"));
  assert.deepEqual(structuredClone(f.run("state")), before);
  assert.equal(f.actions.length, 0); assert.equal(f.$("undo").disabled, false);
});

test("reselecting the current library preserves search, current-page fold choice and selected links", async () => {
  const f = populatedFixture();
  f.run('suppressedFolds.add("g:library-personal:parent")');
  await query(f, "Saved"); await f.$("select-mode").emit("click");
  await f.$("tree").querySelector(".link-checkbox").emit("change");
  const before = structuredClone(f.run("state"));
  f.$("library-picker").focus(); await switchTo(f, "library-personal");
  assert.equal(f.$("search").value, "Saved"); assert.deepEqual(visibleIds(f), ["saved"]);
  assert.equal(f.run('suppressedFolds.has("g:library-personal:parent")'), true);
  assert.equal(f.$("selection-count").textContent, "1개 선택");
  assert.ok(f.document.activeElement === f.$("library-picker"));
  assert.deepEqual(structuredClone(f.run("state")), before); assert.equal(f.actions.length, 0);
});

for (const id of ["missing-library", ""]) test(`invalid library ${JSON.stringify(id)} leaves the current view intact`, async () => {
  const f = populatedFixture(); await switchTo(f, "other-library"); await query(f, "천문");
  const before = structuredClone(f.run("state")); f.$("library-picker").focus();
  await f.$("library-picker").emit("change", { target: { value: id } });
  assert.equal(f.$("library-picker").value, "other-library");
  assert.equal(f.$("search").value, "천문"); assert.deepEqual(visibleIds(f), ["astronomy"]);
  assert.ok(f.document.activeElement === f.$("library-picker"));
  assert.deepEqual(structuredClone(f.run("state")), before); assert.equal(f.actions.length, 0);
});

test("returning to a library does not revive its old query or unfold stored groups", async () => {
  const f = populatedFixture(), before = structuredClone(f.run("state"));
  await query(f, "Parent"); await switchTo(f, "other-library");
  await query(f, "天文 missing"); await switchTo(f, "library-personal");
  assert.equal(f.$("search").value, ""); assert.deepEqual(visibleIds(f), ["saved"]);
  const parent = f.$("tree").querySelectorAll("[data-group-id]").find(row => row.dataset.groupId === "parent");
  assert.equal(parent.querySelector(".fold").getAttribute("aria-expanded"), "false");
  assert.deepEqual(structuredClone(f.run("state")), before); assert.equal(f.actions.length, 0);
});

test("switching to an empty library shows onboarding instead of a leftover zero-result search", async () => {
  const f = fixture(); await query(f, "Saved"); await switchTo(f, "other-library");
  assert.equal(f.$("search").value, ""); assert.equal(f.$("link-count").textContent, "내 링크 0개");
  assert.match(f.$("tree").textContent, /자주 찾는 곳부터 담아보세요/u);
  assert.doesNotMatch(f.$("tree").textContent, /일치하는 링크가 없어요/u);
  assert.equal(f.actions.length, 0);
});

test("a stale option removed by a newer catalog cannot clear the current query or select a missing library", async () => {
  const f = populatedFixture(); await query(f, "Saved");
  const catalog = structuredClone(f.run("state.catalog")); catalog.libraries.pop();
  f.context.latest = { catalog, revision: 8, canUndo: true }; f.setInteraction(true); f.run("adopt(latest)");
  await switchTo(f, "other-library");
  assert.equal(f.$("library-picker").value, "library-personal"); assert.equal(f.$("search").value, "Saved");
  f.setInteraction(false); f.run("flushPendingUI()");
  assert.deepEqual(visibleIds(f), ["saved"]); assert.equal(f.actions.length, 0);
});

test("library view switches perform no service writes and preserve the previous real content Undo", async () => {
  const f = populatedFixture(), original = structuredClone(f.run("state.catalog")), writes = [];
  const values = { [FAVMOA_STORAGE_KEY]: { catalog: original, revision: 7 } };
  const sender = { id: "context-test", url: "chrome-extension://context-test/sidepanel/sidepanel.html" };
  const service = createCatalogService({ runtimeId: sender.id, storage: {
    async setAccessLevel() {},
    async get(keys) { return structuredClone(Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]]))); },
    async set(next) { writes.push(structuredClone(next)); Object.assign(values, structuredClone(next)); }
  } });
  f.context.realDispatch = (action, expectedRevision) => service.handle({ type: "FAVMOA_ACTION", action: structuredClone(action), expectedRevision }, sender);
  f.context.realUndo = expectedRevision => service.handle({ type: "FAVMOA_UNDO", expectedRevision }, sender);
  f.run("platform.dispatch = realDispatch; platform.undo = realUndo");
  await f.$("rename-library").emit("click"); await flush();
  f.$("dialog-body").querySelector("input").value = "여행 보관함"; await f.submit();
  assert.equal(writes.length, 1); const afterEdit = structuredClone(values);
  await query(f, "Saved"); await switchTo(f, "other-library");
  await query(f, "천문"); await switchTo(f, "library-personal");
  assert.equal(writes.length, 1); assert.deepEqual(values, afterEdit);
  assert.equal(f.$("undo").disabled, false); await f.$("undo").emit("click");
  assert.equal(writes.length, 2); assert.deepEqual(structuredClone(f.run("state.catalog")), original);
});
