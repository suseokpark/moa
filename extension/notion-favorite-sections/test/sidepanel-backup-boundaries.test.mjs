import assert from "node:assert/strict";
import test from "node:test";
import { backupFixture } from "../test-support/backup-dialog-fixture.mjs";
import { deferred, flush } from "../test-support/candidate-picker-fixture.mjs";

// Full shipped dialog handlers and real catalog service with synthetic state.
// This covers asynchronous behavior, not native browser rendering or real data.
const reviewButton = f => f.$("dialog-body").querySelector(".backup-review-button");
const ack = f => f.$("dialog-body").querySelector(".backup-review-ack");
const note = f => f.$("dialog-body").querySelector(".backup-review-note");
const previews = f => f.requests.filter(item => item.type === "preview").length;
const snapshot = f => f.send({ type: "FAVMOA_PREVIEW_BACKUP" });
async function review(f) { await reviewButton(f).emit("click"); await flush(); }
async function agree(f, value = true) { ack(f).checked = value; await ack(f).emit("change"); }
async function conflicted(kind) {
  const f = await backupFixture(); await f.openBackup(kind);
  if (kind === "previous") { await review(f); await agree(f); }
  const latest = structuredClone(f.original); latest.libraries[0].name = "Latest library";
  f.external(latest, 8); await f.submit();
  assert.equal(f.edits().length, 1);
  assert.equal(f.run("state.revision"), 8);
  assert.equal(f.$("dialog-submit").disabled, true);
  return f;
}

for (const kind of ["file", "previous"]) {
  test(`${kind} backup: failed previews stay blocked and sanitize errors before a later successful review`, async () => {
    const f = await conflicted(kind);
    for (const failure of [async () => { throw new Error("synthetic private read detail"); }, async () => ({ ok: false, error: "synthetic private read detail" })]) {
      f.setRead(failure); await review(f);
      assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, true);
      assert.equal(reviewButton(f).disabled, false); assert.equal(Boolean(ack(f).checked), false);
      assert.match(note(f).textContent, /확인하지 못했습니다/u);
      assert.doesNotMatch(f.$("dialog-body").textContent + f.$("dialog-error").textContent, /synthetic private read detail/u);
      assert.ok(f.document.activeElement === reviewButton(f));
      await agree(f); await f.submit(); assert.equal(f.edits().length, 1);
    }
    f.setRead(null); await review(f); assert.equal(Boolean(ack(f).checked), false);
    await agree(f); await f.submit(); assert.equal(f.edits().length, 2);
    assert.equal(f.edits()[1].expectedRevision, 8); assert.equal(f.writes.length, 1);
  });

  test(`${kind} backup: stale and malformed preview responses cannot roll back state or permit execution`, async () => {
    for (const invalid of ["old", "negative", "fractional", "unsafe", "no-revision", "no-current", "bad-current", "bad-restore", "missing-restore", "wrong-availability", "missing-availability"]) {
      const f = await conflicted(kind), result = await snapshot(f);
      if (invalid === "old") result.revision = 7;
      if (invalid === "negative") result.revision = -1;
      if (invalid === "fractional") result.revision = 8.5;
      if (invalid === "unsafe") result.revision = Number.MAX_SAFE_INTEGER + 1;
      if (invalid === "no-revision") delete result.revision;
      if (invalid === "no-current") delete result.catalog;
      if (invalid === "bad-current") result.catalog = {};
      if (invalid === "bad-restore") result.restoreCatalog = {};
      if (invalid === "missing-restore") delete result.restoreCatalog;
      if (invalid === "wrong-availability") result.hasRestorePoint = false;
      if (invalid === "missing-availability") delete result.hasRestorePoint;
      f.setRead(async () => result); await review(f);
      assert.equal(f.run("state.revision"), 8, invalid);
      assert.equal(f.$("dialog-submit").disabled, true, invalid);
      await agree(f); await f.submit(); assert.equal(f.edits().length, 1, invalid);
      assert.equal(f.writes.length, 0, invalid);
    }
  });

  test(`${kind} backup: pending preview rejects duplicate reads and writes while cancellation remains usable`, async () => {
    const f = await conflicted(kind), pending = deferred(), before = previews(f);
    const result = await snapshot(f);
    f.setRead(() => pending.promise); await review(f);
    assert.equal(previews(f), before + 1); assert.equal(reviewButton(f).disabled, true);
    assert.equal(ack(f).disabled, true); assert.equal(f.$("dialog-submit").disabled, true);
    assert.equal(f.$("dialog-close").disabled, false); assert.equal(f.$("dialog-cancel").disabled, false);
    await review(f); await f.submit(); assert.equal(previews(f), before + 1); assert.equal(f.edits().length, 1);
    pending.resolve(result); await flush();
    assert.equal(reviewButton(f).disabled, false); assert.equal(ack(f).disabled, false);
    assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.writes.length, 0);
    assert.ok(f.document.activeElement === ack(f));
    await agree(f); assert.equal(f.$("dialog-submit").disabled, false);
  });

  test(`${kind} backup: cancelling a pending preview discards the late result`, async () => {
    const f = await conflicted(kind), pending = deferred(), result = await snapshot(f);
    f.setRead(() => pending.promise); await review(f); await f.$("dialog-cancel").emit("click");
    result.revision = 9; result.catalog.libraries[0].name = "Late response";
    pending.resolve(result); await flush();
    assert.equal(f.$("dialog").open, false); assert.equal(f.run("state.revision"), 8);
    assert.equal(f.run("library().name"), "Latest library"); assert.equal(f.edits().length, 1);
    assert.equal(f.writes.length, 0);
  });

  test(`${kind} backup: a pending preview cannot mutate a replacement dialog`, async () => {
    const f = await conflicted(kind), pending = deferred(), result = await snapshot(f);
    f.setRead(() => pending.promise); await review(f); await f.$("dialog-close").emit("click");
    await f.$("add-group").emit("click"); await flush();
    const title = f.$("dialog-title").textContent, body = f.$("dialog-body").children[0];
    result.revision = 9; pending.resolve(result); await flush();
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-title").textContent, title);
    assert.ok(f.$("dialog-body").children[0] === body); assert.equal(f.$("dialog-submit").disabled, false);
    assert.equal(f.run("state.revision"), 8); assert.equal(f.edits().length, 1);
    assert.equal(f.writes.length, 0);
  });

  test(`${kind} backup: a background newer revision defeats an older in-flight preview`, async () => {
    const f = await conflicted(kind), pending = deferred(), result = await snapshot(f);
    f.setRead(() => pending.promise); await review(f);
    result.revision = 9;
    f.external(f.original, 10); f.context.background = await snapshot(f); f.run("adopt(background)");
    pending.resolve(result); await flush();
    assert.equal(f.run("state.revision"), 10); assert.equal(f.$("dialog-submit").disabled, true);
    await agree(f); await f.submit(); assert.equal(f.edits().length, 1);
    f.setRead(null); await review(f); assert.equal(Boolean(ack(f).checked), false);
    await agree(f); await f.submit(); assert.equal(f.edits()[1].expectedRevision, 10);
    assert.equal(f.writes.length, 1);
  });

  test(`${kind} backup: every renewed conflict requires a new preview and new acknowledgement`, async () => {
    const f = await conflicted(kind); await review(f); await agree(f);
    f.external(f.original, 9); await f.submit();
    assert.deepEqual(f.edits().map(item => item.expectedRevision), [7, 8]);
    assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
    await agree(f); await f.submit(); assert.equal(f.edits().length, 2);
    await review(f); assert.equal(Boolean(ack(f).checked), false);
    await f.submit(); assert.equal(f.edits().length, 2);
    await agree(f); await f.submit();
    assert.deepEqual(f.edits().map(item => item.expectedRevision), [7, 8, 9]);
    assert.equal(f.$("dialog").open, false); assert.equal(f.writes.length, 1);
  });

  test(`${kind} backup: rereading identical data revokes acknowledgement and unchecking blocks direct submit`, async () => {
    const f = await conflicted(kind); await review(f); await agree(f);
    assert.equal(f.$("dialog-submit").disabled, false);
    await review(f); assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); assert.equal(f.edits().length, 1);
    await agree(f); await agree(f, false); await f.submit();
    assert.equal(f.edits().length, 1); assert.equal(f.writes.length, 0);
  });

  test(`${kind} backup: ordinary save failure preserves reviewed data for an explicit same-revision retry`, async () => {
    const f = await conflicted(kind); await review(f); await agree(f);
    const before = previews(f);
    f.setWrite(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." })); await f.submit();
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, false);
    assert.equal(Boolean(ack(f).checked), true); assert.equal(previews(f), before);
    assert.equal(f.$("dialog-error").textContent, "저장하지 못했습니다."); assert.equal(f.writes.length, 0);
    f.setWrite(null); await f.submit();
    assert.deepEqual(f.edits().map(item => item.expectedRevision), [7, 8, 8]);
    assert.equal(f.writes.length, 1); assert.equal(f.$("dialog").open, false);
  });

  test(`${kind} backup: in-flight execution prevents duplicate writes and reviews`, async () => {
    const f = await conflicted(kind); await review(f); await agree(f);
    const before = previews(f), pending = deferred();
    f.setWrite(() => pending.promise);
    const submission = f.submit(); await flush();
    assert.equal(f.edits().length, 2); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); await review(f); assert.equal(f.edits().length, 2); assert.equal(previews(f), before);
    pending.resolve({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }); await submission;
    assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.writes.length, 0);
  });

  test(`${kind} backup: a failed repeat preview invalidates an earlier successful acknowledgement`, async () => {
    const f = await conflicted(kind); await review(f); await agree(f);
    f.setRead(async () => ({ ok: false, error: "synthetic unavailable read" })); await review(f);
    assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
    await agree(f); await f.submit(); assert.equal(f.edits().length, 1);
    assert.equal(f.writes.length, 0);
    f.setRead(null); await review(f); assert.equal(Boolean(ack(f).checked), false);
    await agree(f); await f.submit(); assert.equal(f.writes.length, 1);
  });
}

test("file backup: ordinary initial save failure keeps the fixed file available for explicit retry", async () => {
  const f = await backupFixture(); await f.openBackup("file");
  f.setWrite(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }));
  await f.submit();
  assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, false);
  assert.equal(previews(f), 0); assert.equal(f.writes.length, 0);
  f.setWrite(null); await f.submit();
  assert.deepEqual(f.edits().map(item => item.expectedRevision), [7, 7]);
  assert.deepEqual(f.edits().map(item => item.catalog), [f.target, f.target]);
  assert.equal(f.writes.length, 1); assert.equal(f.$("dialog").open, false);
});

test("previous backup: a consumed checkpoint response requires a new review and cannot retain old acknowledgement", async () => {
  const f = await backupFixture(); await f.openBackup("previous"); await review(f); await agree(f);
  f.setWrite(async () => ({ ok: false, code: "NO_RESTORE_POINT", error: "복구할 안전 사본이 없습니다." }));
  await f.submit();
  assert.equal(f.$("dialog-submit").disabled, true); assert.equal(Boolean(ack(f).checked), false);
  await agree(f); await f.submit(); assert.equal(f.edits().length, 1);
  f.external(f.original, 8, null); f.setWrite(null); await review(f);
  assert.equal(ack(f).parentElement.hidden, true); assert.equal(f.$("dialog-submit").disabled, true);
  assert.ok(f.document.activeElement === reviewButton(f));
  await agree(f); await f.submit(); assert.equal(f.edits().length, 1); assert.equal(f.writes.length, 0);
});
