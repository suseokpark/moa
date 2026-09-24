import assert from "node:assert/strict";
import test from "node:test";
import { fixture, flush } from "../test-support/candidate-picker-fixture.mjs";
import { flattenGroups, MAX_GROUP_DEPTH } from "../src/link-library.js";

const reviewButton = f => f.$("dialog-body").querySelector(".move-review-button");
const target = f => f.$("dialog-body").querySelector("select");
function open(f, kind) {
  f.run(kind === "group" ? 'moveGroupDialog(library().groups[1].groups[0])'
    : 'linkSelection.start(libraryId, ["saved"]); linkSelection.toggle("saved"); bulkMoveDialog()');
  target(f).value = kind === "group" ? "" : "destination";
  return target(f).emit("change");
}
async function conflict(f, catalog = structuredClone(f.context.initial.catalog), revision = 8) {
  f.setCatalog(catalog, revision);
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "목록이 바뀌었습니다.", catalog, revision }));
  await f.submit();
}
async function review(f) {
  assert.ok(reviewButton(f), "explicit review action exists");
  await reviewButton(f).emit("click"); await flush();
}

test("group move conflict requires read-only review before a separate current-revision move", async () => {
  const f = fixture(); await open(f, "group"); await conflict(f);
  assert.equal(f.$("dialog-submit").disabled, true);
  await f.submit(); assert.equal(f.actions.length, 1);
  await review(f); assert.equal(f.loads(), 1); assert.equal(f.actions.length, 1);
  assert.equal(target(f).value, ""); assert.equal(f.$("dialog").open, true);
  f.setResponse(null); await f.submit();
  assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
  assert.equal(f.actions[1].action.libraryId, "library-personal");
  assert.equal(f.run('library().groups.some(group => group.id === "destination")'), true);
  assert.equal(f.$("dialog").open, false);
});

test("bulk move preserves captured selection through read-only review and moves atomically", async () => {
  const f = fixture(); await open(f, "bulk"); await conflict(f);
  assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1);
  await review(f); assert.equal(f.loads(), 1); assert.equal(f.actions.length, 1);
  assert.equal(target(f).value, "destination");
  f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].expectedRevision, 8); assert.deepEqual(f.actions[1].action.linkIds, ["saved"]);
  assert.equal(f.run('library().groups[1].groups[0].links[0].id'), "saved");
  assert.equal(f.run('linkSelection.isActive()'), false); assert.equal(f.$("dialog").open, false);
});

for (const kind of ["group", "bulk"]) test(`${kind}: a deleted original library never redirects the move`, async () => {
  const f = fixture(); await open(f, kind); const latest = structuredClone(f.context.initial.catalog); latest.libraries.shift();
  await conflict(f, latest); await review(f);
  assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1);
  assert.match(f.$("dialog-body").querySelector(".move-review-note").textContent, /보관함.*삭제/u);
});

test("bulk: missing one selected link blocks the entire captured selection", async () => {
  const f = fixture(); const initial = structuredClone(f.context.initial.catalog);
  initial.libraries[0].groups[0].links.push({ id: "second", title: "Second", url: "https://example.org/second", icon: "", provider: "generic" });
  f.setCatalog(initial, 7); f.context.initial = { catalog: initial, revision: 7 }; f.run("adopt(initial)");
  f.run('linkSelection.start(libraryId, ["saved", "second"]); linkSelection.toggle("saved"); linkSelection.toggle("second"); bulkMoveDialog()');
  target(f).value = "destination"; await target(f).emit("change");
  const latest = structuredClone(initial); latest.libraries[0].groups[0].links.pop();
  await conflict(f, latest); await review(f); await f.submit();
  assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.actions.length, 1);
  assert.match(f.$("dialog-body").querySelector(".move-review-note").textContent, /1개.*찾을 수 없/u);
  assert.equal(f.run('library().groups[0].links[0].id'), "saved");
});

test("group: latest subtree contents are compared and require acknowledgement before moving", async () => {
  const f = fixture(); await open(f, "group"); const latest = structuredClone(f.context.initial.catalog);
  latest.libraries[0].groups[1].groups[0].links.push({ id: "remote", title: "Remote addition", url: "https://example.org/remote", icon: "", provider: "generic" });
  await conflict(f, latest); await review(f);
  assert.equal(f.$("dialog-submit").disabled, true);
  assert.match(f.$("dialog-body").querySelector(".move-review-comparison").textContent, /Remote addition/u);
  await f.submit(); assert.equal(f.actions.length, 1);
  const ack = f.$("dialog-body").querySelector(".move-review-ack"); ack.checked = true; await ack.emit("change");
  f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].expectedRevision, 8);
  assert.equal(f.run('library().groups.find(group => group.id === "destination").links[0].id'), "remote");
});

test("bulk: deleted destination stays unavailable until an explicit new choice", async () => {
  const f = fixture(); await open(f, "bulk"); const latest = structuredClone(f.context.initial.catalog);
  latest.libraries[0].groups[1].groups = [];
  await conflict(f, latest); await review(f);
  assert.equal(target(f).value, "destination"); assert.equal(f.$("dialog-submit").disabled, true);
  assert.match(target(f).selectedOptions[0].textContent, /사용할 수 없/u);
  await f.submit(); assert.equal(f.actions.length, 1);
  target(f).value = "parent"; await target(f).emit("change");
  f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].action.targetGroupId, "parent");
});

test("bulk: renamed destination is compared, and changing it resets acknowledgement", async () => {
  const f = fixture(); await open(f, "bulk"); const latest = structuredClone(f.context.initial.catalog);
  latest.libraries[0].groups[1].groups[0].name = "Remote target";
  await conflict(f, latest); await review(f);
  assert.equal(f.$("dialog-submit").disabled, true);
  assert.match(target(f).selectedOptions[0].textContent, /Remote target/u);
  assert.match(f.$("dialog-body").querySelector(".move-review-comparison").textContent, /Remote target/u);
  const ack = f.$("dialog-body").querySelector(".move-review-ack"); ack.checked = true; await ack.emit("change");
  assert.equal(f.$("dialog-submit").disabled, false);
  target(f).value = "parent"; await target(f).emit("change");
  assert.equal(ack.checked, false); assert.equal(f.$("dialog-submit").disabled, false);
  target(f).value = "destination"; await target(f).emit("change");
  assert.equal(f.$("dialog-submit").disabled, true);
});

const group = id => ({ id, name: id, collapsed: false, links: [], groups: [] });
function seed(f, catalog) { f.setCatalog(catalog, 7); f.context.initial = { catalog, revision: 7 }; f.run("adopt(initial)"); }
async function agree(f) { const ack = f.$("dialog-body").querySelector(".move-review-ack"); ack.checked = true; await ack.emit("change"); }
test("group: a destination newly inside the moved subtree is blocked until another explicit choice", async () => {
  const f = fixture(), initial = structuredClone(f.context.initial.catalog);
  initial.libraries[0].groups.push(group("external")); seed(f, initial); await open(f, "group");
  target(f).value = "external"; await target(f).emit("change");
  const latest = structuredClone(initial); latest.libraries[0].groups[1].groups[0].groups.push(latest.libraries[0].groups.pop());
  await conflict(f, latest); await review(f); await agree(f);
  assert.equal(target(f).value, "external"); assert.equal(f.$("dialog-submit").disabled, true);
  await f.submit(); assert.equal(f.actions.length, 1);
  target(f).value = ""; await target(f).emit("change"); await agree(f); f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].action.targetParentGroupId, null);
});

test("group: destination depth includes the full moved subtree and excludes overflow", async () => {
  const f = fixture(), initial = structuredClone(f.context.initial.catalog);
  initial.libraries[0].groups[1].groups[0].groups.push(group("child"));
  initial.libraries[0].groups.push(group("external")); seed(f, initial); await open(f, "group");
  target(f).value = "external"; await target(f).emit("change");
  const latest = structuredClone(initial), destination = latest.libraries[0].groups.pop();
  let branch = group("depth-1"); latest.libraries[0].groups.push(branch);
  for (let depth = 2; depth < MAX_GROUP_DEPTH - 1; depth++) { const next = group(`depth-${depth}`); branch.groups.push(next); branch = next; }
  branch.groups.push(destination); // target depth 31 + subtree height 2 = 33
  await conflict(f, latest); await review(f); await agree(f);
  assert.equal(target(f).value, "external"); assert.equal(f.$("dialog-submit").disabled, true);
  assert.match(target(f).selectedOptions[0].textContent, /사용할 수 없/u);
  await f.submit(); assert.equal(f.actions.length, 1);
});

test("group: current parent is a no-op and cannot consume an edit", async () => {
  const f = fixture(); f.run('moveGroupDialog(library().groups[1].groups[0])');
  assert.equal(target(f).value, "parent"); assert.equal(f.$("dialog-submit").disabled, true);
  await f.submit(); assert.equal(f.actions.length, 0);
});

test("group: exactly maximum resulting depth remains an available destination", async () => {
  const f = fixture(), initial = structuredClone(f.context.initial.catalog);
  initial.libraries[0].groups[1].groups[0].groups.push(group("child"));
  let branch = group("depth-1"); initial.libraries[0].groups.push(branch);
  for (let depth = 2; depth <= MAX_GROUP_DEPTH - 2; depth++) { const next = group(`depth-${depth}`); branch.groups.push(next); branch = next; }
  seed(f, initial); await open(f, "group"); target(f).value = branch.id; await target(f).emit("change");
  assert.equal(f.$("dialog-submit").disabled, false); await f.submit();
  assert.equal(f.$("dialog").open, false);
  assert.equal(f.run('flattenGroups(library()).find(item => item.group.id === "child").path.length'), MAX_GROUP_DEPTH);
});

for (const change of ["title", "url", "path", "already-there"]) test(`bulk: latest ${change} requires content review without changing captured IDs`, async () => {
  const f = fixture(); await open(f, "bulk"); const latest = structuredClone(f.context.initial.catalog), groups = latest.libraries[0].groups;
  if (change === "title") groups[0].links[0].title = "Latest title";
  else if (change === "url") groups[0].links[0].url = "https://example.org/latest";
  else if (change === "path") groups[1].links.push(groups[0].links.pop());
  else groups[1].groups[0].links.push(groups[0].links.pop());
  await conflict(f, latest); await review(f);
  assert.equal(f.$("dialog-submit").disabled, true); await agree(f);
  if (change === "already-there") { assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1); }
  else { f.setResponse(null); await f.submit(); assert.deepEqual(f.actions[1].action.linkIds, ["saved"]); assert.equal(f.$("dialog").open, false); }
});

test("group: same-name ancestor identity changes are still acknowledged", async () => {
  const f = fixture(), initial = structuredClone(f.context.initial.catalog);
  initial.libraries[0].groups.push({ ...group("other-parent"), name: "Parent" }); seed(f, initial); await open(f, "group");
  const latest = structuredClone(initial); latest.libraries[0].groups[2].groups.push(latest.libraries[0].groups[1].groups.pop());
  await conflict(f, latest); await review(f); assert.equal(f.$("dialog-submit").disabled, true);
  await agree(f); f.setResponse(null); await f.submit(); assert.equal(f.$("dialog").open, false);
});

test("group: folds outside content do not require overwrite acknowledgement", async () => {
  const f = fixture(); await open(f, "group"); const latest = structuredClone(f.context.initial.catalog);
  latest.libraries[0].groups[1].groups[0].collapsed = false;
  await conflict(f, latest); await review(f);
  assert.equal(f.$("dialog-submit").disabled, false);
  assert.equal(f.$("dialog-body").querySelector(".move-review-ack").parentElement.hidden, true);
});

test("group: deleted source is unavailable even if the same ID exists in another library", async () => {
  const f = fixture(); await open(f, "group"); const latest = structuredClone(f.context.initial.catalog);
  latest.libraries[1].groups.push(latest.libraries[0].groups[1].groups.pop());
  await conflict(f, latest); await review(f); await f.submit();
  assert.equal(f.actions.length, 1); assert.equal(f.$("dialog-submit").disabled, true);
});

test("large move chooser indexes a catalog once instead of walking the whole tree per option", () => {
  const f = fixture(), initial = structuredClone(f.context.initial.catalog);
  for (let i = 0; i < 1000; i++) initial.libraries[0].groups.push(group(`many-${i}`));
  seed(f, initial); let visited = 0;
  f.context.flattenGroups = value => { const result = flattenGroups(value); visited += result.length; return result; };
  f.run('moveGroupDialog(library().groups[1].groups[0])');
  assert.ok(visited < 10030, `bounded traversal work for 1003 groups, observed ${visited}`);
  assert.equal(target(f).children.length, 1003);
});

test("bulk count reads destination once rather than once per group", async () => {
  const f = fixture(), initial = structuredClone(f.context.initial.catalog);
  for (let i = 0; i < 1000; i++) initial.libraries[0].groups.push(group(`many-${i}`));
  seed(f, initial); await open(f, "bulk");
  const control = target(f), getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value").get;
  let reads = 0; Object.defineProperty(control, "value", { get() { reads++; return getter.call(this); } });
  await control.emit("change"); assert.ok(reads < 10, `bounded destination reads, observed ${reads}`);
});

test("stale group menu opens a blocked dialog instead of throwing after source deletion", async () => {
  const f = fixture(); f.context.oldGroup = structuredClone(f.context.initial.catalog.libraries[0].groups[1].groups[0]);
  const initial = structuredClone(f.context.initial.catalog); initial.libraries[0].groups[1].groups = []; seed(f, initial);
  assert.doesNotThrow(() => f.run("moveGroupDialog(oldGroup)"));
  assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 0);
});
