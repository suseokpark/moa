import assert from "node:assert/strict";
import test from "node:test";
import { legacyFixture } from "../test-support/legacy-dialog-fixture.mjs";
import { deferred, flush } from "../test-support/candidate-picker-fixture.mjs";

// Shipped sidepanel handlers and the real service with isolated synthetic storage.
// These assertions cover behavior, not native browser rendering.
const reviewButton = f => f.$("dialog-body").querySelector(".legacy-review-button");
const ack = f => f.$("dialog-body").querySelector(".legacy-review-ack");
const note = f => f.$("dialog-body").querySelector(".legacy-review-note");
const reviews = f => f.requests.filter(item => item.type === "read").length;
const snapshot = f => f.send({ type: "FAVMOA_GET" });
async function review(f) { await reviewButton(f).emit("click"); await flush(); }
async function agree(f, checked = true) { ack(f).checked = checked; await ack(f).emit("change"); }
async function conflicted() {
  const f = await legacyFixture(); await f.openLegacy();
  const latest = structuredClone(f.original); latest.libraries[0].name = "Latest destination";
  f.external(latest, 8); await f.submit();
  assert.equal(f.edits().length, 1); assert.equal(f.run("state.revision"), 8);
  assert.equal(f.$("dialog-submit").disabled, true);
  return f;
}

test("legacy review: read failures remain blocked and sanitize errors until a separate successful review", async () => {
  const f = await conflicted(), before = f.current();
  for (const failure of [async () => { throw new Error("synthetic private read detail"); }, async () => ({ ok: false, error: "synthetic private read detail" })]) {
    f.setRead(failure); await review(f);
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, true);
    assert.equal(reviewButton(f).disabled, false); assert.equal(Boolean(ack(f).checked), false);
    assert.match(note(f).textContent, /확인하지 못했습니다/u);
    assert.doesNotMatch(f.$("dialog-body").textContent + f.$("dialog-error").textContent, /synthetic private read detail/u);
    assert.ok(f.document.activeElement === reviewButton(f));
    await agree(f); await f.submit(); assert.equal(f.edits().length, 1);
    assert.deepEqual(f.current(), before); assert.equal(f.writes.length, 0);
  }
  f.setRead(null); await review(f); assert.equal(Boolean(ack(f).checked), false);
  await agree(f); await f.submit();
  assert.deepEqual(f.edits().map(item => item.expectedRevision), [7, 8]);
  assert.equal(f.writes.length, 1);
});

for (const invalid of ["old", "negative", "fractional", "unsafe", "no-revision", "no-catalog", "bad-catalog", "null"]) {
  test(`legacy review: ${invalid} destination response cannot roll back state or permit import`, async () => {
    const f = await conflicted(), before = f.current();
    let result = await snapshot(f);
    if (invalid === "old") result.revision = 7;
    if (invalid === "negative") result.revision = -1;
    if (invalid === "fractional") result.revision = 8.5;
    if (invalid === "unsafe") result.revision = Number.MAX_SAFE_INTEGER + 1;
    if (invalid === "no-revision") delete result.revision;
    if (invalid === "no-catalog") delete result.catalog;
    if (invalid === "bad-catalog") result.catalog = {};
    if (invalid === "null") result = null;
    f.setRead(async () => result); await review(f);
    assert.equal(f.run("state.revision"), 8); assert.equal(f.$("dialog-submit").disabled, true);
    assert.equal(Boolean(ack(f).checked), false); assert.ok(f.document.activeElement === reviewButton(f));
    await agree(f); await f.submit(); assert.equal(f.edits().length, 1);
    assert.equal(f.writes.length, 0); assert.equal(f.reads.includes(null), false);
    assert.deepEqual(f.current(), before);
  });
}

test("legacy review: pending read blocks duplicate reads and import while cancellation remains usable", async () => {
  const f = await conflicted(), pending = deferred(), result = await snapshot(f), before = reviews(f);
  f.setRead(() => pending.promise); await review(f);
  assert.equal(reviews(f), before + 1); assert.equal(reviewButton(f).disabled, true);
  assert.equal(ack(f).disabled, true); assert.equal(f.$("dialog-submit").disabled, true);
  assert.equal(f.$("dialog-close").disabled, false); assert.equal(f.$("dialog-cancel").disabled, false);
  assert.equal(note(f).getAttribute("aria-busy"), "true");
  await review(f); await f.submit(); assert.equal(reviews(f), before + 1); assert.equal(f.edits().length, 1);
  pending.resolve(result); await flush();
  assert.equal(reviewButton(f).disabled, false); assert.equal(ack(f).disabled, false);
  assert.equal(f.$("dialog-submit").disabled, true); assert.equal(note(f).getAttribute("aria-busy"), "false");
  assert.ok(f.document.activeElement === ack(f));
  assert.equal(f.writes.length, 0); assert.equal(f.reads.includes(null), false);
  await agree(f); assert.equal(f.$("dialog-submit").disabled, false);
});

test("legacy review: cancellation discards a late response and preserves latest stored destination", async () => {
  const f = await conflicted(), pending = deferred(), result = await snapshot(f), before = f.current();
  f.setRead(() => pending.promise); await review(f); await f.$("dialog-cancel").emit("click");
  result.revision = 9; result.catalog.libraries[0].name = "Late destination";
  pending.resolve(result); await flush();
  assert.equal(f.$("dialog").open, false); assert.equal(f.run("state.revision"), 8);
  assert.equal(f.run("library().name"), "Latest destination");
  assert.equal(f.edits().length, 1); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.current(), before);
});

test("legacy review: a late response cannot alter a replacement dialog", async () => {
  const f = await conflicted(), pending = deferred(), result = await snapshot(f);
  f.setRead(() => pending.promise); await review(f); await f.$("dialog-close").emit("click");
  await f.$("add-group").emit("click"); await flush();
  const title = f.$("dialog-title").textContent, body = f.$("dialog-body").children[0];
  result.revision = 9; pending.resolve(result); await flush();
  assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-title").textContent, title);
  assert.ok(f.$("dialog-body").children[0] === body); assert.equal(f.$("dialog-submit").disabled, false);
  assert.equal(f.run("state.revision"), 8); assert.equal(f.edits().length, 1); assert.equal(f.writes.length, 0);
});

test("legacy review: an independently newer destination defeats an older in-flight response", async () => {
  const f = await conflicted(), pending = deferred(), result = await snapshot(f);
  f.setRead(() => pending.promise); await review(f);
  result.revision = 9;
  f.external(f.original, 10); f.context.background = await snapshot(f); f.run("adopt(background)");
  pending.resolve(result); await flush();
  assert.equal(f.run("state.revision"), 10); assert.equal(f.$("dialog-submit").disabled, true);
  await agree(f); await f.submit(); assert.equal(f.edits().length, 1); assert.equal(f.writes.length, 0);
  f.setRead(null); await review(f); assert.equal(Boolean(ack(f).checked), false);
  await agree(f); await f.submit(); assert.equal(f.edits()[1].expectedRevision, 10);
  assert.equal(f.writes.length, 1); assert.equal(f.$("dialog").open, false);
});

test("legacy review: every renewed conflict requires another destination review and acknowledgement", async () => {
  const f = await conflicted(); await review(f); await agree(f);
  f.external(f.original, 9); await f.submit();
  assert.deepEqual(f.edits().map(item => item.expectedRevision), [7, 8]);
  assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
  await agree(f); await f.submit(); assert.equal(f.edits().length, 2);
  assert.equal(f.writes.length, 0); assert.equal(f.reads.includes(null), false);
  await review(f); assert.equal(Boolean(ack(f).checked), false);
  await f.submit(); assert.equal(f.edits().length, 2);
  await agree(f); await f.submit();
  assert.deepEqual(f.edits().map(item => item.expectedRevision), [7, 8, 9]);
  assert.equal(f.$("dialog").open, false); assert.equal(f.writes.length, 1);
});

test("legacy review: rereading unchanged data revokes acknowledgement and unchecking blocks direct submit", async () => {
  const f = await conflicted(); await review(f); await agree(f);
  assert.equal(f.$("dialog-submit").disabled, false);
  await review(f); assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
  await f.submit(); assert.equal(f.edits().length, 1);
  await agree(f); await agree(f, false); await f.submit();
  assert.equal(f.edits().length, 1); assert.equal(f.writes.length, 0); assert.equal(f.reads.includes(null), false);
});

test("legacy review: failed rereading invalidates an earlier successful acknowledgement", async () => {
  const f = await conflicted(); await review(f); await agree(f);
  f.setRead(async () => ({ ok: false, error: "Synthetic unavailable read" })); await review(f);
  assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
  await agree(f); await f.submit(); assert.equal(f.edits().length, 1); assert.equal(f.writes.length, 0);
  f.setRead(null); await review(f); assert.equal(Boolean(ack(f).checked), false);
  await agree(f); await f.submit(); assert.equal(f.writes.length, 1);
});

for (const reviewed of [false, true]) {
  test(`legacy review: ${reviewed ? "reviewed" : "initial"} storage failure preserves original data for an explicit same-revision retry`, async () => {
    const f = reviewed ? await conflicted() : await legacyFixture();
    if (reviewed) { await review(f); await agree(f); } else await f.openLegacy();
    const before = structuredClone(f.values), readsBefore = reviews(f), save = f.storage.set;
    f.storage.set = async () => { throw new Error("Synthetic quota error"); };
    await f.submit();
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, false);
    assert.equal(Boolean(ack(f).checked), reviewed); assert.equal(reviews(f), readsBefore);
    assert.match(f.$("dialog-error").textContent, /저장하지 못했습니다/u);
    assert.equal(f.writes.length, 0); assert.deepEqual(f.values, before);
    f.storage.set = save; await f.submit();
    assert.deepEqual(f.edits().map(item => item.expectedRevision), reviewed ? [7, 8, 8] : [7, 7]);
    assert.equal(f.writes.length, 1); assert.equal(f.$("dialog").open, false);
    assert.deepEqual(f.current().catalog.libraries.slice(0, before["favmoa:catalog:v1"].catalog.libraries.length), before["favmoa:catalog:v1"].catalog.libraries);
  });
}

test("legacy review: pending execution prevents duplicate writes and destination reviews", async () => {
  const f = await conflicted(); await review(f); await agree(f);
  const before = reviews(f), pending = deferred(), values = structuredClone(f.values);
  f.setWrite(() => pending.promise);
  const submission = f.submit(); await flush();
  assert.equal(f.edits().length, 2); assert.equal(f.$("dialog-submit").disabled, true);
  await f.submit(); await review(f); assert.equal(f.edits().length, 2); assert.equal(reviews(f), before);
  pending.resolve({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }); await submission;
  assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.values, values);
});
