import assert from "node:assert/strict";
import test from "node:test";
import { deferred, fixture, flush } from "../test-support/candidate-picker-fixture.mjs";

// Real shipped menu entry points and reducers with synthetic data only. These
// checks do not claim native browser rendering or user-storage verification.
const latest = f => structuredClone(f.context.initial.catalog);
const reviewButton = f => f.$("dialog-body").querySelector(".destructive-review-button");
const note = f => f.$("dialog-body").querySelector(".destructive-review-note");
const ack = f => f.$("dialog-body").querySelector(".destructive-review-ack");
const visible = control => {
  for (let node = control; node; node = node.parentElement) if (node.hidden) return false;
  return Boolean(control);
};
async function open(f, kind) {
  const control = kind === "resetLibrary" ? f.$("reset-library") : f.document.querySelectorAll("button")
    .find(item => item.textContent === (kind === "removeLink" ? "팹모아에서 제거" : "그룹만 제거"));
  assert.ok(control, `existing ${kind} menu entry`);
  await control.emit("click"); await flush();
  assert.equal(f.$("dialog").open, true);
}

for (const kind of ["removeLink", "removeGroup", "resetLibrary"]) {
  test(`${kind} confirmation: failed reads are sanitized and never unlock destructive execution`, async () => {
    const f = fixture(); await open(f, kind); await conflict(f);
    for (const readFailure of [async () => { throw new Error("private failure detail"); }, async () => ({ ok: false, error: "private failure detail" })]) {
      f.setLoadResponse(readFailure); await review(f);
      assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, true);
      assert.equal(reviewButton(f).disabled, false); assert.equal(Boolean(ack(f).checked), false);
      assert.match(note(f).textContent, /확인하지 못했습니다/u);
      assert.doesNotMatch(f.$("dialog-body").textContent + f.$("dialog-error").textContent, /private failure detail/u);
      assert.ok(f.document.activeElement === reviewButton(f), "failed read returns focus to review");
      await f.submit(); assert.equal(f.actions.length, 1);
    }
    f.setLoadResponse(null); await review(f);
    assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.actions.length, 1);
    assert.equal(visible(ack(f)), true); assert.equal(f.loads(), 3);
    await acknowledge(f); f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
  });

  test(`${kind} confirmation: stale or malformed reads cannot unlock execution or roll back state`, async () => {
    for (const invalid of ["old", "negative", "fractional", "unsafe", "missing-revision", "missing-catalog", "bad-catalog"]) {
      const f = fixture(); await open(f, kind); await conflict(f);
      const result = { ok: true, catalog: latest(f), revision: 8 };
      if (invalid === "old") result.revision = 7;
      if (invalid === "negative") result.revision = -1;
      if (invalid === "fractional") result.revision = 8.5;
      if (invalid === "unsafe") result.revision = Number.MAX_SAFE_INTEGER + 1;
      if (invalid === "missing-revision") delete result.revision;
      if (invalid === "missing-catalog") delete result.catalog;
      if (invalid === "bad-catalog") result.catalog = { libraries: [] };
      f.setLoadResponse(async () => result); await review(f);
      assert.equal(f.$("dialog-submit").disabled, true, invalid);
      assert.equal(f.run("state.revision"), 8, invalid);
      await acknowledge(f); await f.submit(); assert.equal(f.actions.length, 1, invalid);
      assert.equal(f.$("dialog-submit").disabled, true, `${invalid}: acknowledgement cannot bypass failed read`);
    }
  });

  test(`${kind} confirmation: pending review rejects duplicate reads and submits but leaves cancellation usable`, async () => {
    const f = fixture(), pending = deferred(); await open(f, kind); await conflict(f);
    f.setLoadResponse(() => pending.promise); await review(f);
    assert.equal(f.loads(), 1); assert.equal(reviewButton(f).disabled, true);
    assert.equal(ack(f).disabled, true); assert.equal(f.$("dialog-submit").disabled, true);
    assert.equal(f.$("dialog-close").disabled, false); assert.equal(f.$("dialog-cancel").disabled, false);
    await review(f); await f.submit(); assert.equal(f.loads(), 1); assert.equal(f.actions.length, 1);
    pending.resolve({ ok: true, catalog: latest(f), revision: 8 }); await flush();
    assert.equal(reviewButton(f).disabled, false); assert.equal(ack(f).disabled, false);
    assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.actions.length, 1);
    assert.ok(f.document.activeElement === ack(f), "review completion focuses the separate acknowledgement");
    await acknowledge(f); assert.equal(f.$("dialog-submit").disabled, false);
  });

  test(`${kind} confirmation: cancelling a pending review discards its later response`, async () => {
    const f = fixture(), pending = deferred(); await open(f, kind); await conflict(f);
    f.setLoadResponse(() => pending.promise); await review(f); await f.$("dialog-cancel").emit("click");
    assert.equal(f.$("dialog").open, false);
    const changed = latest(f); changed.libraries[0].name = "Late response";
    pending.resolve({ ok: true, catalog: changed, revision: 9 }); await flush();
    assert.equal(f.$("dialog").open, false); assert.equal(f.run("state.revision"), 8);
    assert.notEqual(f.run("library().name"), "Late response"); assert.equal(f.actions.length, 1);
  });

  test(`${kind} confirmation: late review cannot affect a replacement dialog`, async () => {
    const f = fixture(), pending = deferred(); await open(f, kind); await conflict(f);
    f.setLoadResponse(() => pending.promise); await review(f); await f.$("dialog-close").emit("click");
    await f.$("add-group").emit("click"); await flush();
    const body = f.$("dialog-body").children[0], title = f.$("dialog-title").textContent;
    pending.resolve({ ok: true, catalog: latest(f), revision: 9 }); await flush();
    assert.equal(f.$("dialog-title").textContent, title);
    assert.ok(f.$("dialog-body").children[0] === body, "replacement body remains intact");
    assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.run("state.revision"), 8);
    assert.equal(f.actions.length, 1); assert.equal(f.$("dialog").open, true);
  });

  test(`${kind} confirmation: background updates defeat older in-flight reviews`, async () => {
    const f = fixture(), pending = deferred(); await open(f, kind); await conflict(f);
    f.setLoadResponse(() => pending.promise); await review(f);
    f.context.newer = { catalog: latest(f), revision: 10 }; f.run("adopt(newer)");
    pending.resolve({ ok: true, catalog: latest(f), revision: 9 }); await flush();
    assert.equal(f.run("state.revision"), 10); assert.equal(f.$("dialog-submit").disabled, true);
    await acknowledge(f); await f.submit(); assert.equal(f.actions.length, 1);
    f.setLoadResponse(async () => ({ ok: true, catalog: latest(f), revision: 10 })); await review(f);
    assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
    assert.equal(f.actions.length, 1); await acknowledge(f);
    f.setCatalog(latest(f), 10); f.setResponse(null); await f.submit();
    assert.equal(f.actions[1].expectedRevision, 10);
  });

  test(`${kind} confirmation: every renewed conflict requires another read and fresh impact acknowledgement`, async () => {
    const f = fixture(); await open(f, kind); await conflict(f); await review(f); await acknowledge(f);
    await conflict(f, latest(f), 9);
    assert.deepEqual(f.actions.map(value => value.expectedRevision), [7, 8]);
    assert.equal(f.$("dialog-submit").disabled, true); assert.equal(Boolean(ack(f).checked), false);
    await acknowledge(f); await f.submit(); assert.equal(f.actions.length, 2, "acknowledgement cannot skip the new read");
    await review(f); assert.equal(f.loads(), 2); assert.equal(f.actions.length, 2);
    assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); assert.equal(f.actions.length, 2);
    await acknowledge(f); f.setResponse(null); await f.submit();
    assert.deepEqual(f.actions.map(value => value.expectedRevision), [7, 8, 9]);
    assert.equal(f.$("dialog").open, false);
  });

  test(`${kind} confirmation: rereading revokes acknowledgement even if reviewed content is identical`, async () => {
    const f = fixture(); await open(f, kind); await conflict(f); await review(f); await acknowledge(f);
    assert.equal(f.$("dialog-submit").disabled, false);
    await review(f); assert.equal(f.loads(), 2); assert.equal(f.actions.length, 1);
    assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); assert.equal(f.actions.length, 1);
    await acknowledge(f, true); await acknowledge(f, false); await f.submit();
    assert.equal(f.actions.length, 1, "unchecking impact acknowledgement blocks direct submission");
  });

  test(`${kind} confirmation: ordinary failure after reviewed acknowledgement preserves a safe explicit retry`, async () => {
    const f = fixture(); await open(f, kind); await conflict(f); await review(f); await acknowledge(f);
    f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }));
    await f.submit();
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, false);
    assert.equal(Boolean(ack(f).checked), true); assert.equal(f.loads(), 1);
    f.setResponse(null); await f.submit();
    assert.deepEqual(f.actions.map(value => value.expectedRevision), [7, 8, 8]);
    assert.equal(f.$("dialog").open, false);
  });

  test(`${kind} confirmation: unavailable original library keeps keyboard focus on review, not hidden acknowledgement`, async () => {
    const f = fixture(); await open(f, kind); const deleted = latest(f); deleted.libraries.shift();
    await conflict(f, deleted); await review(f);
    assert.equal(visible(ack(f)), false); assert.equal(f.$("dialog-submit").disabled, true);
    assert.ok(f.document.activeElement === reviewButton(f), "unavailable target retains a visible focus control");
    await acknowledge(f); await f.submit(); assert.equal(f.actions.length, 1);
  });
}
async function conflict(f, catalog = latest(f), revision = 8) {
  f.setCatalog(catalog, revision);
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "다른 창에서 목록이 변경되었습니다.", catalog, revision }));
  await f.submit();
}
async function review(f) {
  assert.ok(reviewButton(f), "explicit destructive review action exists");
  await reviewButton(f).emit("click"); await flush();
}
async function acknowledge(f, checked = true) {
  assert.ok(ack(f), "separate impact acknowledgement exists");
  ack(f).checked = checked; await ack(f).emit("change");
}

for (const kind of ["removeLink", "removeGroup", "resetLibrary"]) {
  test(`${kind} confirmation: ordinary save failure permits a same-revision explicit retry`, async () => {
    const f = fixture(); await open(f, kind);
    f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }));
    await f.submit();
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, false);
    assert.equal(visible(reviewButton(f)), false); assert.equal(f.loads(), 0);
    assert.equal(f.$("dialog-error").textContent, "저장하지 못했습니다.");
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].action.type, kind);
    assert.equal(f.actions[1].expectedRevision, 7); assert.equal(f.actions[1].action.libraryId, "library-personal");
    assert.equal(f.$("dialog").open, false);
  });
}
