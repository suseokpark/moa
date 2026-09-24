import assert from "node:assert/strict";
import test from "node:test";
import { backupFixture } from "../test-support/backup-dialog-fixture.mjs";
import { flush } from "../test-support/candidate-picker-fixture.mjs";
import { FAVMOA_RESTORE_POINT_KEY } from "../src/favmoa-service.js";

const reviewButton = f => f.$("dialog-body").querySelector(".backup-review-button");
const acknowledgement = f => f.$("dialog-body").querySelector(".backup-review-ack");
async function review(f) { assert.ok(reviewButton(f)); await reviewButton(f).emit("click"); await flush(); }
async function agree(f) { assert.ok(acknowledgement(f)); acknowledgement(f).checked = true; await acknowledgement(f).emit("change"); }

test("JSON conflict blocks repeat writes, reviews latest impact, then requires a separate acknowledged import", async () => {
  const f = await backupFixture(); await f.openBackup();
  const latest = structuredClone(f.original); latest.libraries[0].name = "Latest current library";
  f.external(latest); await f.submit();
  assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.edits().length, 1);
  await review(f); assert.equal(f.edits().length, 1); assert.equal(f.writes.length, 0);
  assert.match(f.$("dialog-body").textContent, /Latest current library/u);
  await f.submit(); assert.equal(f.edits().length, 1);
  await agree(f); await f.submit();
  assert.equal(f.edits()[1].expectedRevision, 8); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.current().catalog, f.target); assert.equal(f.$("dialog").open, false);
});

test("previous-backup recovery previews the actual checkpoint before any acknowledged write", async () => {
  const f = await backupFixture(); await f.openBackup("previous");
  assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.edits().length, 0);
  await review(f); assert.equal(f.writes.length, 0);
  assert.match(f.$("dialog-body").textContent, /Backup library/u);
  assert.match(f.$("dialog-body").textContent, /사용 완료/u);
  await f.submit(); assert.equal(f.edits().length, 0);
  await agree(f); await f.submit(); assert.equal(f.edits()[0].expectedRevision, 7);
  assert.deepEqual(f.current().catalog, f.target); assert.equal(f.writes.length, 1);
  assert.equal(f.$("dialog").open, false);
});

for (const kind of ["file", "previous"]) test(`${kind}: changed checkpoint and current contents are re-reviewed, not silently restored`, async () => {
  const f = await backupFixture(); await f.openBackup(kind);
  if (kind === "previous") { await review(f); await agree(f); }
  const current = structuredClone(f.original); current.libraries[0].name = "New current";
  current.libraries[0].groups[1].groups[0].links.push({ id: "new", title: "New nested page", url: "https://example.org/new", icon: "", provider: "generic" });
  const checkpoint = structuredClone(f.target); checkpoint.libraries[0].name = "New checkpoint";
  f.external(current, 8, checkpoint); await f.submit();
  assert.equal(f.writes.length, 0); assert.equal(f.$("dialog-submit").disabled, true);
  await review(f);
  const contents = f.$("dialog-body").textContent;
  assert.match(contents, /New current/u); assert.match(contents, /New nested page/u);
  assert.match(contents, /Parent › Destination/u); assert.match(contents, /New checkpoint/u);
  if (kind === "file") assert.match(contents, /교체되어 사라질 기존 안전 사본/u);
  await agree(f); await f.submit();
  assert.deepEqual(f.current().catalog, kind === "file" ? f.target : checkpoint);
  assert.deepEqual(f.values[FAVMOA_RESTORE_POINT_KEY], kind === "file" ? { catalog: current } : null);
});

for (const unavailable of [null, { invalid: true }]) test(`previous: ${unavailable ? "corrupt" : "consumed"} checkpoint is unavailable and never replaced by current or file data`, async () => {
  const f = await backupFixture(); await f.openBackup("previous"); await review(f); await agree(f);
  f.external(f.original, 8, unavailable); await f.submit(); await review(f);
  assert.equal(f.$("dialog-submit").disabled, true); assert.equal(acknowledgement(f).parentElement.hidden, true);
  assert.match(f.$("dialog-body").textContent, /안전 사본이 없거나 읽을 수/u);
  assert.equal(f.document.activeElement, reviewButton(f));
  await agree(f); await f.submit(); assert.equal(f.edits().length, 1); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.current().catalog, f.original);
});

test("file: missing checkpoint does not block import and creates a checkpoint from reviewed current contents", async () => {
  const f = await backupFixture(); await f.openBackup(); f.external(f.original, 8, null);
  await f.submit(); await review(f); assert.match(f.$("dialog-body").textContent, /안전 사본으로 보관/u);
  await agree(f); await f.submit(); assert.deepEqual(f.values[FAVMOA_RESTORE_POINT_KEY], { catalog: f.original });
});

test("file: the selected file stays fixed after preview even if its caller object changes", async () => {
  const f = await backupFixture(); const expected = structuredClone(f.target); await f.openBackup();
  f.target.libraries[0].name = "Caller changed after file read";
  f.external(f.original); await f.submit(); await review(f); await agree(f); await f.submit();
  assert.deepEqual(f.current().catalog, expected);
});

test("file: identical reviewed contents perform no writes and preserve the existing checkpoint", async () => {
  const f = await backupFixture(); await f.openBackup(); f.external(f.target, 8, f.original);
  await f.submit(); await review(f); assert.match(f.$("dialog-body").textContent, /기존 안전 사본도 그대로 유지/u);
  assert.doesNotMatch(f.$("dialog-body").textContent, /교체되어 사라질/u);
  await agree(f); await f.submit(); assert.equal(f.writes.length, 0);
  assert.match(f.$("status").textContent, /현재 목록과 같아 변경하지 않았/u);
  assert.deepEqual(f.values[FAVMOA_RESTORE_POINT_KEY], { catalog: f.original });
});

for (const kind of ["file", "previous"]) test(`${kind}: cancel after preview preserves all storage and the search context`, async () => {
  const f = await backupFixture(); const before = structuredClone(f.values); f.$("search").value = "keep search";
  await f.openBackup(kind); await review(f); await f.$("dialog-cancel").emit("click");
  assert.deepEqual(f.values, before); assert.equal(f.writes.length, 0); assert.equal(f.edits().length, 0);
  assert.equal(f.$("search").value, "keep search");
});

test("backup details render untrusted file names and titles as plain text", async () => {
  const f = await backupFixture(); f.target.libraries[0].name = "<img src=x onerror=alert(1)>";
  await f.openBackup(); assert.match(f.$("dialog-body").textContent, /<img src=x/u);
  assert.equal(f.$("dialog-body").querySelectorAll("img").length, 0);
  for (const details of f.$("dialog-body").querySelectorAll("details")) assert.equal(details.open, false);
});
