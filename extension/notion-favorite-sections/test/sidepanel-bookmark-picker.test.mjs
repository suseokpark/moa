import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_GROUP_ID } from "../src/link-library.js";
import { deferred, fixture, flush, tab } from "../test-support/candidate-picker-fixture.mjs";

// The real picker functions and reducer run against a synthetic DOM. Optional
// Chrome permission prompts and native layout need separate browser verification.
const bookmark = (title, folderPath = "Research / General", url) => ({ ...tab(title, url), folderPath });
const bookmarks = [bookmark("Alpha", "Research / Design"), bookmark("Beta", "Work / Plans"), bookmark("Gamma", "Research / Design")];
const setup = (items = bookmarks) => fixture(items, { bookmarks: true });
const loaded = candidates => ({ ok: true, candidates });

test("bookmark entry starts the permission-dependent read in the same event and shows a disabled loading dialog", async () => {
  const f = setup(), pending = deferred(); f.setCandidates(() => pending.promise);
  const opening = f.$("import-bookmarks").emit("click");
  assert.equal(f.fetches(), 1, "permission request must not be deferred beyond the click stack");
  assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-title").textContent, "북마크 선택 가져오기");
  assert.equal(f.filter().disabled, true); assert.equal(f.all().disabled, true); assert.equal(f.$("dialog-submit").disabled, true);
  assert.match(f.$("dialog-body").textContent, /북마크/u);
  pending.resolve(loaded(bookmarks)); await opening; await flush();
  assert.equal(f.checks().length, 3); assert.ok(f.checks().every(item => !item.checked));
  assert.equal(f.count(), "0개 선택"); assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.actions.length, 0);
});

test("bookmark choices exclude saved, duplicate and unsafe URLs and show both their URL and folder path", async () => {
  const f = setup([bookmark("Saved", "Private", "https://example.com/saved"), ...bookmarks,
    bookmark("Duplicate", "Other folder", bookmarks[0].url), bookmark("Unsafe", "Other folder", "javascript:alert(1)")]);
  await f.open();
  assert.equal(f.checks().length, 3); assert.match(f.$("dialog-body").textContent, /이미 저장 1개/u);
  assert.doesNotMatch(f.$("dialog-body").textContent, /javascript:|Unsafe|Duplicate/u);
  const row = f.checks()[0].parentElement;
  assert.match(row.textContent, /https:\/\/example\.org\/alpha/u); assert.match(row.textContent, /Research \/ Design/u);
  assert.equal(row.tagName, "LABEL"); assert.equal(f.$("dialog-body").querySelector("a"), null);
});

test("loaded bookmark choices focus search when the native dialog focus remains on close", async () => {
  const f = setup(), pending = deferred(); f.setCandidates(() => pending.promise); await f.open();
  // A native dialog initially focuses its enabled close button while search is
  // disabled. Set that browser-owned condition explicitly in the synthetic DOM.
  f.$("dialog-close").focus(); pending.resolve(loaded(bookmarks)); await flush();
  assert.equal(f.document.activeElement, f.filter()); assert.equal(f.filter().disabled, false);
});

test("bookmark load does not steal focus from a control the user chose while waiting", async () => {
  const f = setup(), pending = deferred(); f.setCandidates(() => pending.promise); await f.open();
  f.$("dialog-cancel").focus(); pending.resolve(loaded(bookmarks)); await flush();
  assert.equal(f.document.activeElement, f.$("dialog-cancel"));
});

test("denied permission and thrown bookmark reads provide explicit retry without persisting or leaking raw errors", async () => {
  for (const thrown of [false, true]) {
    const f = setup(); f.setCandidates(async () => {
      if (thrown) throw new Error("private browser diagnostics");
      return { ok: false, code: "PERMISSION_DENIED", error: "북마크 접근을 허용하지 않았습니다." };
    });
    await f.open();
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, true);
    assert.equal(f.actions.length, 0); assert.doesNotMatch(f.$("dialog-body").textContent, /private browser/u);
    f.setCandidates(async () => loaded(bookmarks)); await f.clickText("다시 불러오기");
    assert.equal(f.fetches(), 2); assert.equal(f.checks().length, 3); assert.equal(f.count(), "0개 선택");
  }
});

test("closing a loading bookmark picker prevents its later response from replacing another form", async () => {
  const f = setup(), pending = deferred(); f.setCandidates(() => pending.promise);
  await f.open(); await f.$("dialog-cancel").emit("click"); await f.$("add-group").emit("click");
  const form = f.$("dialog-body").children[0];
  pending.resolve(loaded(bookmarks)); await flush();
  assert.equal(f.$("dialog-title").textContent, "그룹 만들기"); assert.equal(f.$("dialog-body").children[0], form);
  assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.actions.length, 0);
});

test("an older bookmark request cannot replace a newer picker or its selected choices", async () => {
  const f = setup(), older = deferred(), newer = deferred(); let reads = 0;
  f.setCandidates(() => ++reads === 1 ? older.promise : newer.promise);
  await f.open(); await f.$("dialog-cancel").emit("click"); await f.open();
  newer.resolve(loaded([bookmark("Newer")])); await flush(); await f.check("Newer");
  older.resolve(loaded([bookmark("Older")])); await flush();
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].getAttribute("aria-label"), "Newer 선택");
  assert.equal(f.checks()[0].checked, true); assert.equal(f.count(), "1개 선택");
});

test("bookmark save captures library and revision before asynchronous permission and bookmark loading", async () => {
  const f = setup(), pending = deferred(); f.setCandidates(() => pending.promise);
  await f.open(); f.run('state.revision = 8; libraryId = "other-library"; render();');
  pending.resolve(loaded(bookmarks)); await flush(); await f.check("Alpha"); await f.submit();
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0].expectedRevision, 7);
  assert.equal(f.actions[0].action.libraryId, "library-personal"); assert.equal(f.actions[0].action.groupId, SYSTEM_GROUP_ID);
});

test("bookmark folder search preserves hidden choices and visible select-all selects only matching rows", async () => {
  const f = setup(); await f.open(); await f.check("Beta"); await f.search("Research / Design");
  assert.equal(f.checks().length, 2); assert.equal(f.count(), "1개 선택 · 화면 밖 1개 포함");
  assert.match(f.$("dialog-body").querySelector(".tab-selection-controls").textContent, /보이는 북마크 모두 선택/u);
  await f.all().emit("change"); assert.equal(f.count(), "3개 선택 · 화면 밖 1개 포함");
  await f.all().emit("change"); assert.equal(f.count(), "1개 선택 · 화면 밖 1개 포함");
  await f.search("https://example.org/beta"); assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].checked, true);
  await f.search("unmatched query"); assert.equal(f.all().disabled, true); assert.equal(f.$("dialog-submit").disabled, false);
});

test("clear selection removes visible and hidden bookmark choices without clearing the filter or closing the dialog", async () => {
  const f = setup(); await f.open(); await f.check("Alpha"); await f.check("Beta"); await f.search("Work / Plans");
  assert.equal(f.count(), "2개 선택 · 화면 밖 1개 포함"); await f.clickText("선택 해제");
  assert.equal(f.filter().value, "Work / Plans"); assert.equal(f.count(), "0개 선택");
  assert.ok(f.checks().every(item => !item.checked)); assert.equal(f.$("dialog-submit").disabled, true);
  assert.equal(f.$("dialog").open, true); assert.equal(f.actions.length, 0);
  assert.equal(f.document.activeElement, f.filter());
  await f.search(""); assert.ok(f.checks().every(item => !item.checked));
});

test("bookmark pagination exposes more than 300 rows and does not select undisplayed rows", async () => {
  const f = setup(Array.from({ length: 405 }, (_, i) => bookmark(`Bookmark ${i}`, "Large / Collection", `https://example.org/bookmark/${i}`)));
  await f.open(); assert.equal(f.checks().length, 200); await f.all().emit("change");
  await f.clickText("더 보기"); assert.equal(f.checks().length, 400); assert.equal(f.count(), "200개 선택");
  assert.equal(f.checks().filter(item => item.checked).length, 200); assert.equal(f.all().indeterminate, true);
  await f.clickText("더 보기"); assert.equal(f.checks().length, 405); await f.check("Bookmark 404");
  await f.search("Bookmark 404"); assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].checked, true);
  assert.equal(f.count(), "201개 선택 · 화면 밖 200개 포함");
});

test("bookmark picker limits both checkbox and select-all paths to 1000 while clear selection recovers without losing search", async () => {
  const f = setup(Array.from({ length: 1001 }, (_, i) => bookmark(`Bookmark ${i}`, "Many", `https://example.org/bookmark/${i}`)));
  await f.open(); for (let page = 0; page < 4; page += 1) await f.clickText("더 보기");
  await f.all().emit("change"); assert.equal(f.count(), "1000개 선택");
  await f.clickText("더 보기"); await f.check("Bookmark 1000");
  assert.equal(f.checks()[1000].checked, false); assert.match(f.$("dialog-error").textContent, /1,000개/u);
  await f.all().emit("change"); assert.equal(f.count(), "1000개 선택");
  await f.search("Bookmark 1000"); await f.clickText("선택 해제");
  assert.equal(f.filter().value, "Bookmark 1000"); assert.equal(f.$("dialog-error").textContent, "");
  await f.check("Bookmark 1000"); assert.equal(f.count(), "1개 선택");
});

test("bookmark labels clean controls and long names before a selected-only atomic save with destination reveal", async () => {
  const messyTitle = `\u0000Long\n${"x".repeat(400)}`;
  const f = setup([bookmark(messyTitle, "Long titles", "https://example.org/long-title"), bookmarks[1]]); await f.$("select-mode").emit("click");
  f.run('linkSelection.toggle("saved");'); f.$("search").value = "outer filter"; await f.open();
  const cleanedTitle = f.checks()[0].getAttribute("aria-label").replace(/ 선택$/u, "");
  assert.equal(cleanedTitle.length, 300); assert.doesNotMatch(cleanedTitle, /[\u0000-\u001f]/u);
  await f.check("Beta"); await f.check(cleanedTitle); await f.search("Work / Plans"); await f.target("destination"); await f.submit();
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0].expectedRevision, 7);
  const action = f.actions[0].action;
  assert.equal(action.type, "addLinks"); assert.equal(action.revealTarget, true); assert.equal(action.groupId, "destination");
  assert.equal(action.links[0].title, cleanedTitle); assert.equal(action.links[1].title, "Beta");
  assert.ok(action.links.every(link => Object.keys(link).sort().join(",") === "title,url"));
  assert.equal(f.$("dialog").open, false); assert.equal(f.$("search").value, "");
  assert.equal(f.run("linkSelection.isActive()"), false); assert.equal(f.$("undo").disabled, false);
  assert.equal(f.document.activeElement.dataset.focusKey, "g:library-personal:destination");
  assert.equal(f.run('library().groups.find(group => group.id === "parent").collapsed'), false);
});

test("failed bookmark save keeps the selected checkbox DOM, search and target for explicit retry", async () => {
  const f = setup(); await f.open(); await f.check("Alpha"); await f.search("Research / Design"); await f.target("destination");
  const check = f.checks()[0]; check.focus(); f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }));
  await f.submit(); assert.equal(f.$("dialog").open, true); assert.equal(f.checks()[0], check); assert.equal(check.checked, true);
  assert.equal(f.filter().value, "Research / Design"); assert.equal(f.$("dialog-body").querySelector("select").value, "destination");
  assert.equal(f.document.activeElement, check); assert.equal(f.$("dialog-submit").disabled, false);
  f.setResponse(null); await f.submit(); assert.equal(f.actions.length, 2); assert.equal(f.$("dialog").open, false);
});

test("bookmark save conflict adopts newer catalog but keeps choices and never partly inserts selected links", async () => {
  const f = setup(); await f.open(); await f.check("Alpha"); await f.target("destination");
  const fresh = structuredClone(f.context.initial.catalog); fresh.libraries[0].name = "Other window update";
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "다른 창에서 목록이 변경되었습니다.", revision: 8, catalog: fresh }));
  await f.submit(); assert.equal(f.$("dialog").open, true); assert.equal(f.checks()[0].checked, true);
  assert.equal(f.run("state.revision"), 8); assert.equal(f.run("linksOf(library()).length"), 1);
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0].expectedRevision, 7); assert.match(f.$("dialog-error").textContent, /다른 창/u);
});

test("pending bookmark save blocks repeated submit and cancellation until completion", async () => {
  const f = setup(), pending = deferred(); await f.open(); await f.check("Alpha"); f.setResponse(() => pending.promise);
  const saving = f.submit(); await flush();
  assert.equal(f.actions.length, 1); assert.equal(f.checks()[0].disabled, true); assert.equal(f.$("dialog-cancel").disabled, true);
  await f.submit(); await f.$("dialog-cancel").emit("click"); assert.equal(f.actions.length, 1); assert.equal(f.$("dialog").open, true);
  pending.resolve({ ok: false, code: "SAVE_FAILED", error: "다시 시도해 주세요." }); await saving;
  assert.equal(f.checks()[0].disabled, false); assert.equal(f.checks()[0].checked, true);
});

test("empty bookmark candidates keep save disabled and a synthetic submit cannot write", async () => {
  const f = setup([bookmark("Saved copy", "Saved", "https://example.com/saved")]); await f.open();
  assert.equal(f.checks().length, 0); assert.equal(f.all().disabled, true); assert.equal(f.$("dialog-submit").disabled, true);
  assert.equal(f.$("dialog-body").querySelector("select").disabled, true);
  await f.submit(); assert.equal(f.actions.length, 0); assert.equal(f.$("dialog").open, true);
});
