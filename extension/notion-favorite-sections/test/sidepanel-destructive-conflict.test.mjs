import assert from "node:assert/strict";
import test from "node:test";
import { fixture, flush } from "../test-support/candidate-picker-fixture.mjs";
import { SYSTEM_GROUP_ID } from "../src/link-library.js";

const current = f => structuredClone(f.context.initial.catalog);
const reviewButton = f => f.$("dialog-body").querySelector(".destructive-review-button");
const acknowledgement = f => f.$("dialog-body").querySelector(".destructive-review-ack");
async function open(f, kind) {
  if (kind === "reset") await f.$("reset-library").emit("click");
  else await f.document.querySelectorAll("button").find(item => item.textContent === (kind === "link" ? "팹모아에서 제거" : "그룹만 제거")).emit("click");
  await flush();
}
async function conflict(f, catalog = current(f), revision = 8) {
  f.setCatalog(catalog, revision);
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "다른 화면에서 목록이 변경되었습니다.", catalog, revision }));
  await f.submit();
}
async function review(f) { assert.ok(reviewButton(f)); await reviewButton(f).emit("click"); await flush(); }
async function agree(f) { assert.ok(acknowledgement(f)); acknowledgement(f).checked = true; await acknowledgement(f).emit("change"); }

test("reset conflict requires a read and acknowledgement before a separate current-revision reset", async () => {
  const f = fixture(); await open(f, "reset"); await conflict(f);
  assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1);
  await review(f); assert.equal(f.loads(), 1); assert.equal(f.actions.length, 1);
  assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1);
  await agree(f); f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.actions[1].action.libraryId, "library-personal");
  assert.equal(f.$("dialog").open, false); assert.equal(f.run("linksOf(library()).length"), 0);
});

for (const kind of ["link", "group"]) test(`${kind} removal requires a fresh read and explicit acknowledgement after conflict`, async () => {
  const f = fixture(); await open(f, kind); await conflict(f);
  assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1);
  await review(f); assert.equal(f.loads(), 1); assert.equal(f.$("dialog-submit").disabled, true);
  await agree(f); f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.actions[1].action.libraryId, "library-personal");
  assert.equal(f.actions[1].action.type, kind === "link" ? "removeLink" : "removeGroup");
  assert.equal(f.$("dialog").open, false);
});

for (const kind of ["link", "group", "reset"]) test(`${kind}: missing original library cannot redirect or enable destructive execution`, async () => {
  const f = fixture(); await open(f, kind); const latest = current(f); latest.libraries.shift();
  await conflict(f, latest); await review(f); await agree(f); await f.submit();
  assert.equal(f.actions.length, 1); assert.equal(f.$("dialog-submit").disabled, true);
  assert.match(f.$("dialog-body").querySelector(".destructive-review-note").textContent, /보관함.*삭제/u);
});

test("link: review displays old and latest title, URL and path before removal", async () => {
  const f = fixture(); await open(f, "link"); const latest = current(f), link = latest.libraries[0].groups[0].links.pop();
  link.title = "Latest title"; link.url = "https://example.org/latest"; latest.libraries[0].groups[1].groups[0].links.push(link);
  await conflict(f, latest); await review(f);
  const comparison = f.$("dialog-body").querySelector(".destructive-review-comparison");
  assert.ok(comparison); assert.match(comparison.textContent, /Saved/u); assert.match(comparison.textContent, /Latest title/u);
  assert.match(comparison.textContent, /https:\/\/example.org\/latest/u); assert.match(comparison.textContent, /Parent › Destination/u);
  assert.match(f.$("dialog-body").querySelector(".destructive-description").textContent, /Latest title/u);
  await agree(f); f.setResponse(null); await f.submit(); assert.equal(f.run("linksOf(library()).length"), 0);
});

function seed(f, catalog) { f.setCatalog(catalog, 7); f.context.initial = { catalog, revision: 7 }; f.run("adopt(initial)"); }
test("root group removal describes the default group that will be created if absent", async () => {
  const f = fixture(), initial = current(f); initial.libraries[0].groups.shift(); seed(f, initial);
  await open(f, "group"); assert.equal(f.$("dialog").open, true);
  assert.match(f.$("dialog-body").textContent, /미분류 그룹.*새로 만/u);
  await f.submit(); assert.equal(f.$("dialog").open, false);
  assert.equal(f.run('library().groups[0].id === SYSTEM_GROUP_ID'), true);
  assert.equal(f.run('library().groups[0].groups[0].id'), "destination");
});

for (const kind of ["link", "group", "reset"]) test(`${kind}: successful confirmation returns to its captured library, not background navigation`, async () => {
  const f = fixture(); await open(f, kind); f.run('libraryId = "other-library"; render()');
  await f.submit(); assert.equal(f.actions[0].action.libraryId, "library-personal");
  assert.equal(f.run("libraryId"), "library-personal");
});

const link = (id, title = id) => ({ id, title, url: `https://example.org/${id}`, icon: "", provider: "generic" });
test("group: latest parent and added subtree contents are reviewed and all contents survive removal", async () => {
  const f = fixture(); await open(f, "group"); const latest = current(f), library = latest.libraries[0], source = library.groups.pop();
  source.links.push(link("new-direct")); source.groups[0].links.push(link("new-child"));
  library.groups.push({ id: "new-parent", name: "New parent", collapsed: false, links: [link("keep")], groups: [source] });
  const untouched = structuredClone(latest.libraries[1]); await conflict(f, latest); await review(f);
  const text = f.$("dialog-body").querySelector(".destructive-description").textContent;
  assert.match(text, /링크 2개와 하위 그룹 1개/u); assert.match(text, /보존 위치 · 내 링크 › New parent/u);
  assert.match(text, /new-direct/u); assert.match(text, /new-child/u);
  const comparison = f.$("dialog-body").querySelector(".destructive-review-comparison").textContent;
  assert.match(comparison, /미분류 그룹/u); assert.match(comparison, /New parent/u);
  await agree(f); f.setResponse(null); await f.submit();
  assert.equal(f.run('flattenGroups(library()).some(item => item.group.id === "parent")'), false);
  assert.equal(f.run('library().groups.find(group => group.id === "new-parent").links.length'), 2);
  assert.equal(f.run('library().groups.find(group => group.id === "new-parent").groups[0].links[0].id'), "new-child");
  assert.equal(f.run('linksOf(library()).length'), 4);
  assert.deepEqual(structuredClone(f.run('state.catalog.libraries[1]')), untouched);
});

test("reset: latest counts and names are visible, and only the confirmed library is emptied", async () => {
  const f = fixture(); await open(f, "reset"); const latest = current(f);
  latest.libraries[0].name = "Latest library"; latest.libraries[0].groups[1].links.push(link("new-link"));
  latest.libraries[1].groups[0].links.push(link("leave-alone"));
  const untouched = structuredClone(latest.libraries[1]);
  await conflict(f, latest); await review(f);
  const text = f.$("dialog-body").querySelector(".destructive-description").textContent;
  assert.match(text, /Latest library/u); assert.match(text, /그룹 3개/u); assert.match(text, /링크 2개/u); assert.match(text, /new-link/u);
  assert.doesNotMatch(text, /leave-alone/u);
  assert.equal(f.$("dialog-body").querySelector("details").open, false, "full impact can be expanded without crowding the confirmation");
  await agree(f); f.setResponse(null); await f.submit();
  assert.equal(f.run("library().groups.length"), 1); assert.equal(f.run("linksOf(library()).length"), 0);
  assert.deepEqual(structuredClone(f.run('state.catalog.libraries[1]')), untouched);
});

for (const kind of ["link", "group"]) test(`${kind}: missing target is not replaced by an identical ID in another library`, async () => {
  const f = fixture(); await open(f, kind); const latest = current(f);
  if (kind === "link") latest.libraries[1].groups[0].links.push(latest.libraries[0].groups[0].links.pop());
  else latest.libraries[1].groups.push(latest.libraries[0].groups.pop());
  await conflict(f, latest); await review(f); await agree(f); await f.submit();
  assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.actions.length, 1);
  assert.equal(acknowledgement(f).parentElement.hidden, true);
});

for (const action of [{ type: "removeLink", linkId: "missing" }, { type: "removeGroup", groupId: "missing" }, { type: "removeGroup", groupId: SYSTEM_GROUP_ID }]) {
  test(`stale/protected confirmation target ${action.type}/${action.groupId || action.linkId} opens blocked without throwing`, async () => {
    const f = fixture(); f.context.testAction = action;
    assert.doesNotThrow(() => f.run("destructiveDialog(testAction)"));
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); assert.equal(f.actions.length, 0);
  });
}

for (const kind of ["link", "group", "reset"]) test(`${kind}: cancelling after review leaves latest data and search intact`, async () => {
  const f = fixture(); f.$("search").value = "keep this context"; await open(f, kind);
  const latest = current(f); latest.libraries[0].name = "Latest untouched";
  await conflict(f, latest); await review(f); await f.$("dialog-cancel").emit("click");
  assert.equal(f.actions.length, 1); assert.equal(f.$("search").value, "keep this context");
  assert.deepEqual(structuredClone(f.run("state.catalog")), latest);
});
