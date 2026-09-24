import assert from "node:assert/strict";
import test from "node:test";
import { legacyFixture, workspaceKey, metadataKey } from "../test-support/legacy-dialog-fixture.mjs";
import { flush } from "../test-support/candidate-picker-fixture.mjs";
import { FAVMOA_LEGACY_BACKUP_KEY, FAVMOA_UNDO_KEY, FAVMOA_RESTORE_POINT_KEY } from "../src/favmoa-service.js";
import { flattenGroups } from "../src/link-library.js";

const reviewButton = f => f.$("dialog-body").querySelector(".legacy-review-button");
const acknowledgement = f => f.$("dialog-body").querySelector(".legacy-review-ack");
async function review(f) { assert.ok(reviewButton(f)); await reviewButton(f).emit("click"); await flush(); }
async function agree(f) { assert.ok(acknowledgement(f)); acknowledgement(f).checked = true; await acknowledgement(f).emit("change"); }

test("legacy conflict blocks repeat writes and requires destination review plus acknowledgement before importing", async () => {
  const f = await legacyFixture(); await f.openLegacy();
  const latest = structuredClone(f.original); latest.libraries[0].name = "Latest destination";
  f.external(latest); await f.submit(); assert.equal(f.run("state.revision"), 8);
  assert.match(f.$("dialog-error").textContent, /다른 창/u);
  assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.edits().length, 1);
  await review(f); assert.equal(f.writes.length, 0); assert.equal(f.reads.includes(null), false);
  assert.match(f.$("dialog-body").textContent, /Latest destination/u);
  await f.submit(); assert.equal(f.edits().length, 1);
  await agree(f); await f.submit();
  assert.deepEqual(f.edits().map(item => item.expectedRevision), [7, 8]);
  assert.equal(f.writes.length, 1); assert.equal(f.$("dialog").open, false);
  assert.equal(f.current().catalog.libraries.length, 3);
  assert.deepEqual(f.current().catalog.libraries.slice(0, 2), latest.libraries);
});

test("destination review never freezes or reads originals; execution imports the then-current metadata", async () => {
  const f = await legacyFixture(); await f.openLegacy(); await review(f);
  assert.equal(f.reads.includes(null), false); assert.equal(f.writes.length, 0);
  const text = f.$("dialog-body").textContent;
  assert.match(text, /원본 목록은 가져오기 실행 시 읽/u);
  assert.match(text, /미리보기가 아닙니다/u);
  assert.match(text, /이전 기록이 남은 워크스페이스/u);
  f.values[metadataKey][0].title = "Changed after review";
  await agree(f); await f.submit();
  const imported = f.current().catalog.libraries.at(-1);
  assert.equal(flattenGroups(imported).flatMap(row => row.group.links)[0].title, "Changed after review");
  assert.equal(f.reads.filter(keys => keys === null).length, 1);
});

test("another window's import is reviewed as migration history and cannot be duplicated or synchronized", async () => {
  const f = await legacyFixture(); await f.openLegacy();
  const other = await f.send({ type: "FAVMOA_IMPORT_LEGACY", expectedRevision: 7 }); assert.equal(other.ok, true);
  const expected = structuredClone(f.current()); const undo = structuredClone(f.values[FAVMOA_UNDO_KEY]);
  f.values[metadataKey][0].title = "Later source change is not sync";
  await f.submit(); await review(f); assert.match(f.$("dialog-body").textContent, /이전 기록 1개/u);
  await agree(f); await f.submit();
  assert.deepEqual(f.current(), expected); assert.equal(f.writes.length, 1);
  assert.deepEqual(f.values[FAVMOA_UNDO_KEY], undo);
  assert.match(f.$("status").textContent, /중복 복사하지 않습니다/u);
  assert.equal(f.$("status").dataset.error, "false");
});

test("successful import preserves originals and existing libraries, snapshots only legacy keys, and keeps restore point", async () => {
  const f = await legacyFixture(); const originalSource = structuredClone({ [workspaceKey]: f.values[workspaceKey], [metadataKey]: f.values[metadataKey] });
  const checkpoint = { catalog: structuredClone(f.original) }; f.values[FAVMOA_RESTORE_POINT_KEY] = checkpoint;
  await f.openLegacy(); await f.submit();
  assert.deepEqual(f.current().catalog.libraries.slice(0, 2), f.original.libraries);
  assert.deepEqual(f.values[FAVMOA_LEGACY_BACKUP_KEY], originalSource);
  for (const [key, value] of Object.entries(originalSource)) assert.deepEqual(f.values[key], value);
  assert.equal(f.values["unrelated-setting"], "not copied");
  assert.deepEqual(f.values[FAVMOA_RESTORE_POINT_KEY], checkpoint);
  const undo = await f.send({ type: "FAVMOA_UNDO", expectedRevision: 8 });
  assert.deepEqual(undo.catalog, f.original); assert.deepEqual(f.values[workspaceKey], originalSource[workspaceKey]);
});

test("mixed valid and invalid originals show actual import counts and attention without exposing source warning text", async () => {
  const f = await legacyFixture(); f.values["nfs:workspace:synthetic-private-name"] = { malformed: true };
  await f.openLegacy(); await f.submit();
  assert.match(f.$("status").textContent, /1개 보관함 · 1개 링크/u);
  assert.match(f.$("status").textContent, /확인.*1개/u);
  assert.equal(f.$("status").dataset.error, "true");
  assert.doesNotMatch(f.$("status").textContent, /synthetic-private-name/u);
  assert.deepEqual(f.values["nfs:workspace:synthetic-private-name"], { malformed: true });
});

test("source read failure preserves everything and a separate retry performs one successful import", async () => {
  const f = await legacyFixture(), before = structuredClone(f.values), get = f.storage.get;
  f.storage.get = async keys => { if (keys === null) throw new Error("private source failure"); return get(keys); };
  await f.openLegacy(); await f.submit(); assert.equal(f.$("dialog").open, true);
  assert.match(f.$("dialog-error").textContent, /이전 목록을 읽지 못/u);
  assert.doesNotMatch(f.$("dialog-error").textContent, /private source failure/u);
  assert.deepEqual(f.values, before); assert.equal(f.writes.length, 0);
  f.storage.get = get; await f.submit(); assert.equal(f.writes.length, 1); assert.equal(f.$("dialog").open, false);
});

test("original removed after destination review yields no import and preserves current catalog", async () => {
  const f = await legacyFixture(); await f.openLegacy(); await review(f);
  delete f.values[workspaceKey]; delete f.values[metadataKey];
  await agree(f); await f.submit(); assert.equal(f.writes.length, 0);
  assert.deepEqual(f.current().catalog, f.original);
  assert.match(f.$("status").textContent, /새 Moa 목록이 없습니다/u);
});

test("review after the former active library disappears remains a catalog-wide import, not a silent destination substitute", async () => {
  const f = await legacyFixture(); await f.openLegacy(); const latest = structuredClone(f.original); latest.libraries.shift();
  f.external(latest); await f.submit(); await review(f);
  assert.match(f.$("dialog-body").textContent, /보관함 1개/u);
  await agree(f); await f.submit();
  assert.deepEqual(f.current().catalog.libraries[0], latest.libraries[0]);
  assert.equal(f.current().catalog.libraries.length, 2);
  assert.deepEqual(Object.keys(f.edits()[1]).sort(), ["expectedRevision", "type"]);
});

test("cancelling after review preserves current and legacy data plus search context", async () => {
  const f = await legacyFixture(), before = structuredClone(f.values); f.$("search").value = "keep context";
  await f.openLegacy(); await review(f); await f.$("dialog-cancel").emit("click");
  assert.deepEqual(f.values, before); assert.equal(f.writes.length, 0); assert.equal(f.reads.includes(null), false);
  assert.equal(f.$("search").value, "keep context");
});

test("destination names are text and long lists are initially collapsed", async () => {
  const f = await legacyFixture(), latest = structuredClone(f.original); latest.libraries[0].name = "<img src=x onerror=alert(1)>";
  await f.openLegacy(); f.external(latest); await f.submit(); await review(f);
  assert.match(f.$("dialog-body").textContent, /<img src=x/u); assert.equal(f.$("dialog-body").querySelectorAll("img").length, 0);
  assert.equal(f.$("dialog-body").querySelector("details").open, false);
});

test("invalid-only legacy input reports attention rather than incorrectly claiming there is no new list", async () => {
  const f = await legacyFixture(); f.values[workspaceKey] = { malformed: true };
  const before = structuredClone(f.values); await f.openLegacy(); await f.submit();
  assert.match(f.$("status").textContent, /확인.*1개/u);
  assert.doesNotMatch(f.$("status").textContent, /새 Moa 목록이 없습니다/u);
  assert.match(f.$("status").textContent, /원본.*유지/u);
  assert.equal(f.$("status").dataset.error, "true");
  assert.deepEqual(f.values, before); assert.equal(f.writes.length, 0);
});
