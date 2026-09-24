import assert from "node:assert/strict";
import test from "node:test";
import { deferred, fixture, flush } from "../test-support/candidate-picker-fixture.mjs";

// Real shipped move handlers and reducers, synthetic DOM/storage only. These
// checks do not imply native rendering or actual extension-runtime validation.
const latest = f => structuredClone(f.context.initial.catalog);
const target = f => f.$("dialog-body").querySelector("select");
const reviewButton = f => f.$("dialog-body").querySelector(".move-review-button");
const note = f => f.$("dialog-body").querySelector(".move-review-note");
const ack = f => f.$("dialog-body").querySelector(".move-review-ack");
const visible = control => {
  for (let node = control; node; node = node.parentElement) if (node.hidden) return false;
  return Boolean(control);
};
async function open(f, kind) {
  f.run(kind === "group" ? 'moveGroupDialog(library().groups[1].groups[0])'
    : 'linkSelection.start(libraryId, ["saved"]); linkSelection.toggle("saved"); bulkMoveDialog()');
  target(f).value = kind === "group" ? "" : "destination";
  await target(f).emit("change");
}
async function conflict(f, catalog = latest(f), revision = 8) {
  f.setCatalog(catalog, revision);
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "목록이 바뀌었습니다.", catalog, revision }));
  await f.submit();
}
async function review(f) {
  assert.ok(reviewButton(f), "explicit review action exists");
  await reviewButton(f).emit("click"); await flush();
}

for (const kind of ["group", "bulk"]) {
  test(`${kind} move review: ordinary save failure keeps destination and permits same-revision retry`, async () => {
    const f = fixture(); await open(f, kind); const chosen = target(f).value;
    f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }));
    await f.submit();
    assert.equal(f.$("dialog").open, true); assert.equal(target(f).value, chosen);
    assert.equal(f.$("dialog-submit").disabled, false); assert.equal(visible(reviewButton(f)), false);
    assert.equal(f.$("dialog-error").textContent, "저장하지 못했습니다.");
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 7);
    assert.equal(f.loads(), 0); assert.equal(f.$("dialog").open, false);
  });

  test(`${kind} move review: failed reads preserve destination and keep movement blocked until successful review`, async () => {
    const f = fixture(); await open(f, kind); const chosen = target(f).value; await conflict(f);
    for (const readFailure of [async () => { throw new Error("private failure detail"); }, async () => ({ ok: false, error: "private failure detail" })]) {
      f.setLoadResponse(readFailure); await review(f);
      assert.equal(f.$("dialog").open, true); assert.equal(target(f).value, chosen);
      assert.equal(f.$("dialog-submit").disabled, true); assert.equal(reviewButton(f).disabled, false);
      assert.match(note(f).textContent, /확인하지 못했습니다/u); assert.doesNotMatch(note(f).textContent, /private failure/u);
      assert.ok(f.document.activeElement === reviewButton(f), "failed read returns focus to review");
      await f.submit(); assert.equal(f.actions.length, 1);
    }
    f.setLoadResponse(null); await review(f); assert.equal(f.$("dialog-submit").disabled, false);
    assert.equal(target(f).value, chosen); assert.equal(f.actions.length, 1);
    f.setResponse(null); await f.submit(); assert.equal(f.actions[1].expectedRevision, 8);
  });

  test(`${kind} move review: invalid or stale snapshots cannot unlock a fresh-revision move`, async () => {
    for (const invalid of ["old", "negative", "fractional", "unsafe", "missing-revision", "missing-catalog", "bad-catalog"]) {
      const f = fixture(); await open(f, kind); const chosen = target(f).value; await conflict(f);
      const result = { ok: true, catalog: latest(f), revision: 8 };
      if (invalid === "old") result.revision = 7;
      if (invalid === "negative") result.revision = -1;
      if (invalid === "fractional") result.revision = 8.5;
      if (invalid === "unsafe") result.revision = Number.MAX_SAFE_INTEGER + 1;
      if (invalid === "missing-revision") delete result.revision;
      if (invalid === "missing-catalog") delete result.catalog;
      if (invalid === "bad-catalog") result.catalog = { libraries: [] };
      f.setLoadResponse(async () => result); await review(f);
      assert.equal(target(f).value, chosen, invalid); assert.equal(f.$("dialog-submit").disabled, true, invalid);
      assert.equal(f.run("state.revision"), 8, invalid); await f.submit(); assert.equal(f.actions.length, 1, invalid);
    }
  });

  test(`${kind} move review: pending read blocks destination changes, duplicate reads and saves but permits cancel`, async () => {
    const f = fixture(), pending = deferred(); await open(f, kind); await conflict(f);
    const chosen = target(f).value; f.setLoadResponse(() => pending.promise);
    await review(f);
    assert.equal(f.loads(), 1); assert.equal(target(f).disabled, true);
    assert.equal(reviewButton(f).disabled, true); assert.equal(f.$("dialog-submit").disabled, true);
    assert.equal(f.$("dialog-close").disabled, false); assert.equal(f.$("dialog-cancel").disabled, false);
    await review(f); await f.submit(); assert.equal(f.loads(), 1); assert.equal(f.actions.length, 1);
    pending.resolve({ ok: true, catalog: latest(f), revision: 8 }); await flush();
    assert.equal(target(f).value, chosen); assert.equal(target(f).disabled, false);
    assert.equal(reviewButton(f).disabled, false); assert.equal(f.$("dialog-submit").disabled, false);
  });

  test(`${kind} move review: cancelling ignores the late response without changing current data`, async () => {
    const f = fixture(), pending = deferred(); await open(f, kind); await conflict(f);
    f.setLoadResponse(() => pending.promise); await review(f); await f.$("dialog-cancel").emit("click");
    assert.equal(f.$("dialog").open, false);
    const changed = latest(f); changed.libraries[0].name = "Late response";
    pending.resolve({ ok: true, catalog: changed, revision: 9 }); await flush();
    assert.equal(f.$("dialog").open, false); assert.equal(f.run("state.revision"), 8);
    assert.notEqual(f.run("library().name"), "Late response"); assert.equal(f.actions.length, 1);
  });

  test(`${kind} move review: late response cannot change a replacement dialog or its controls`, async () => {
    const f = fixture(), pending = deferred(); await open(f, kind); await conflict(f);
    f.setLoadResponse(() => pending.promise); await review(f); await f.$("dialog-cancel").emit("click");
    f.run('nameDialog("Replacement", { type: "addGroup" })');
    const body = f.$("dialog-body").children[0];
    pending.resolve({ ok: true, catalog: latest(f), revision: 9 }); await flush();
    assert.equal(f.$("dialog-title").textContent, "Replacement");
    assert.ok(f.$("dialog-body").children[0] === body, "replacement contents remain unchanged");
    assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.run("state.revision"), 8);
    assert.equal(f.actions.length, 1);
  });

  test(`${kind} move review: an in-flight result older than a background update cannot unlock movement`, async () => {
    const f = fixture(), pending = deferred(); await open(f, kind); await conflict(f);
    f.setLoadResponse(() => pending.promise); await review(f);
    f.context.newer = { catalog: latest(f), revision: 10 }; f.run("adopt(newer)");
    pending.resolve({ ok: true, catalog: latest(f), revision: 9 }); await flush();
    assert.equal(f.run("state.revision"), 10); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); assert.equal(f.actions.length, 1);
    f.setLoadResponse(async () => ({ ok: true, catalog: latest(f), revision: 10 })); await review(f);
    assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.actions.length, 1);
  });

  test(`${kind} move review: another conflict after review requires a fresh read before retry`, async () => {
    const f = fixture(); await open(f, kind); await conflict(f); await review(f);
    await conflict(f, latest(f), 9);
    assert.deepEqual(f.actions.map(value => value.expectedRevision), [7, 8]);
    assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 2);
    await review(f); assert.equal(f.actions.length, 2); assert.equal(f.loads(), 2);
    f.setResponse(null); await f.submit();
    assert.deepEqual(f.actions.map(value => value.expectedRevision), [7, 8, 9]);
    assert.equal(f.$("dialog").open, false);
  });

  test(`${kind} move review: another conflict revokes the previous acknowledgement`, async () => {
    const f = fixture(); await open(f, kind); const changed = latest(f);
    if (kind === "group") changed.libraries[0].groups[1].groups[0].name = "Remote group";
    else changed.libraries[0].groups[0].links[0].title = "Remote link";
    await conflict(f, changed); await review(f);
    assert.equal(visible(ack(f)), true); assert.equal(f.$("dialog-submit").disabled, true);
    ack(f).checked = true; await ack(f).emit("change"); assert.equal(f.$("dialog-submit").disabled, false);
    await conflict(f, changed, 9);
    assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); assert.equal(f.actions.length, 2);
    await review(f);
    assert.equal(visible(ack(f)), true); assert.equal(Boolean(ack(f).checked), false);
    assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 2);
    ack(f).checked = true; await ack(f).emit("change"); f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 3); assert.equal(f.actions[2].expectedRevision, 9);
  });
}
