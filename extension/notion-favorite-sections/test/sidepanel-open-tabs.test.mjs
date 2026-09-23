import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_GROUP_ID } from "../src/link-library.js";
import { defaults, deferred, fixture, flush, tab } from "../test-support/candidate-picker-fixture.mjs";

test("open tabs dialog opens immediately in a disabled loading state and never preselects tabs", async () => {
  const f = fixture(), pending = deferred(); f.setCandidates(() => pending.promise);
  await f.open();
  assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-title").textContent, "열린 탭 담기");
  assert.match(f.$("dialog-body").textContent, /열린 탭을 확인/u);
  assert.equal(f.filter().disabled, true); assert.equal(f.all().disabled, true); assert.equal(f.$("dialog-submit").disabled, true);
  pending.resolve({ ok: true, tabs: defaults, excludedCount: 0 }); await flush();
  assert.equal(f.checks().length, 3); assert.ok(f.checks().every(check => !check.checked));
  assert.equal(f.count(), "0개 선택"); assert.equal(f.$("dialog-submit").disabled, true);
  assert.equal(f.actions.length, 0);
});

test("candidate summary explains saved, duplicate and excluded tabs without exposing unsupported addresses", async () => {
  const f = fixture();
  f.setCandidates(async () => ({ ok: true, demo: true, excludedCount: 2, tabs: [
    tab("Saved copy", "https://example.com/saved"), ...defaults, tab("Duplicate", defaults[0].url), tab("Unsafe", "javascript:alert(1)")
  ] }));
  await f.open();
  const text = f.$("dialog-body").textContent;
  assert.match(text, /예시 탭/u); assert.match(text, /새 링크 3개/u); assert.match(text, /이미 저장 1개/u);
  assert.match(text, /중복 탭 1개/u); assert.match(text, /3개 제외/u); assert.doesNotMatch(text, /javascript:|Unsafe/u);
  assert.equal(f.checks().length, 3);
});

test("cancelled loading response cannot replace a newer non-tab dialog or write data", async () => {
  const f = fixture(), pending = deferred(); f.setCandidates(() => pending.promise);
  await f.open(); await f.$("dialog-cancel").emit("click");
  await f.$("add-group").emit("click"); const body = f.$("dialog-body").children[0];
  pending.resolve({ ok: true, tabs: defaults, excludedCount: 0 }); await flush();
  assert.equal(f.$("dialog-title").textContent, "그룹 만들기"); assert.equal(f.$("dialog-body").children[0], body);
  assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.actions.length, 0);
});

test("an older tab request cannot overwrite a newly opened tab picker", async () => {
  const f = fixture(), older = deferred(), newer = deferred(); let request = 0;
  f.setCandidates(() => ++request === 1 ? older.promise : newer.promise);
  await f.open(); await f.$("dialog-cancel").emit("click"); await f.open();
  newer.resolve({ ok: true, tabs: [tab("Newer")], excludedCount: 0 }); await flush();
  await f.check("Newer"); older.resolve({ ok: true, tabs: [tab("Older")], excludedCount: 0 }); await flush();
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].getAttribute("aria-label"), "Newer 선택");
  assert.equal(f.checks()[0].checked, true); assert.equal(f.count(), "1개 선택");
});

test("structured and thrown tab-read failures remain in the dialog with a working explicit retry", async () => {
  for (const throws of [false, true]) {
    const f = fixture(); f.setCandidates(async () => { if (throws) throw new Error("private failure details"); return { ok: false, error: "탭을 불러오지 못했습니다." }; });
    await f.open();
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, true);
    assert.doesNotMatch(f.$("dialog-body").textContent, /private failure/u);
    assert.ok(f.$("dialog-body").querySelectorAll("button").some(item => item.textContent === "다시 불러오기" && !item.hidden));
    f.setCandidates(async () => ({ ok: true, tabs: defaults, excludedCount: 0 })); await f.clickText("다시 불러오기");
    assert.equal(f.fetches(), 2); assert.equal(f.checks().length, 3); assert.equal(f.count(), "0개 선택");
  }
});

test("native named checkboxes preserve focus and never trigger page navigation", async () => {
  const f = fixture(); await f.open();
  const input = f.checks()[0]; input.focus(); await f.check("Alpha");
  assert.equal(f.checks()[0], input); assert.equal(f.document.activeElement, input);
  assert.equal(input.type, "checkbox"); assert.equal(input.parentElement.tagName, "LABEL");
  assert.equal(input.listeners.has("keydown"), false); assert.equal(f.opened.length, 0);
  assert.equal(f.count(), "1개 선택"); assert.equal(f.all().indeterminate, true);
  assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.$("dialog-body").querySelector("a"), null);
});

test("filtering preserves hidden selections and visible select-all affects only the shown choices", async () => {
  const f = fixture(); await f.open(); await f.check("Alpha"); await f.search("Beta");
  assert.equal(f.count(), "1개 선택 · 화면 밖 1개 포함");
  await f.all().emit("change"); assert.equal(f.count(), "2개 선택 · 화면 밖 1개 포함");
  await f.all().emit("change"); assert.equal(f.count(), "1개 선택 · 화면 밖 1개 포함");
  await f.search("No matching tab"); assert.equal(f.all().disabled, true); assert.equal(f.$("dialog-submit").disabled, false);
  await f.search(""); assert.equal(f.checks()[0].checked, true); assert.equal(f.checks()[1].checked, false);
  await f.$("dialog-cancel").emit("click"); assert.equal(f.actions.length, 0); assert.equal(f.$("dialog").open, false);
});

test("clear selection removes hidden open-tab choices while retaining the current search", async () => {
  const f = fixture(); await f.open(); await f.check("Alpha"); await f.check("Beta"); await f.search("Beta");
  assert.equal(f.count(), "2개 선택 · 화면 밖 1개 포함"); await f.clickText("선택 해제");
  assert.equal(f.filter().value, "Beta"); assert.equal(f.count(), "0개 선택");
  assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.$("dialog").open, true);
  await f.search(""); assert.ok(f.checks().every(item => !item.checked)); assert.equal(f.actions.length, 0);
});

test("large tab lists show 200 at a time and visible selection does not implicitly select unloaded rows", async () => {
  const f = fixture(Array.from({ length: 205 }, (_, i) => tab(`Tab ${i}`, `https://example.org/tab/${i}`)));
  await f.open(); assert.equal(f.checks().length, 200); await f.all().emit("change");
  assert.equal(f.count(), "200개 선택"); await f.clickText("더 보기");
  assert.equal(f.checks().length, 205); assert.equal(f.checks().filter(item => item.checked).length, 200);
  assert.equal(f.all().indeterminate, true); assert.equal(f.checks()[204].checked, false);
  await f.check("Tab 204"); await f.search("Tab 204");
  assert.equal(f.checks().length, 1); assert.equal(f.checks()[0].checked, true);
  assert.equal(f.count(), "201개 선택 · 화면 밖 200개 포함");
});

test("selection enforces the 1000 limit for checkboxes and select-all without losing existing choices", async () => {
  const f = fixture(Array.from({ length: 1001 }, (_, i) => tab(`Tab ${i}`, `https://example.org/tab/${i}`)));
  await f.open();
  for (let page = 0; page < 4; page += 1) await f.clickText("더 보기");
  assert.equal(f.checks().length, 1000); await f.all().emit("change"); assert.equal(f.count(), "1000개 선택");
  await f.clickText("더 보기"); await f.check("Tab 1000");
  assert.equal(f.checks()[1000].checked, false); assert.equal(f.count(), "1000개 선택");
  assert.match(f.$("dialog-error").textContent, /1,000개/u);
  await f.all().emit("change"); assert.equal(f.count(), "1000개 선택");
  assert.equal(f.checks().filter(item => item.checked).length, 1000);
});

test("selected tabs save once in candidate order, reveal the destination and reset outer selection/search", async () => {
  const f = fixture();
  await f.$("select-mode").emit("click");
  f.run('linkSelection.toggle("saved");'); f.$("search").value = "outer search";
  await f.open(); await f.check("Beta"); await f.check("Alpha"); await f.search("Beta"); await f.target("destination");
  await f.submit();
  assert.equal(f.actions.length, 1);
  assert.deepEqual(f.actions[0], { expectedRevision: 7, action: {
    type: "addLinks", libraryId: "library-personal", groupId: "destination", links: [defaults[0], defaults[1]], revealTarget: true
  } });
  assert.equal(f.$("dialog").open, false); assert.equal(f.$("search").value, "");
  assert.equal(f.run("linkSelection.isActive()"), false); assert.equal(f.run("linkSelection.count()"), 0);
  assert.equal(f.document.activeElement.dataset.focusKey, "g:library-personal:destination");
  assert.equal(f.run('library().groups.find(group => group.id === "parent").collapsed'), false);
  assert.equal(f.$("undo").disabled, false);
});

test("save uses the library and revision captured before asynchronous tab loading", async () => {
  const f = fixture(), pending = deferred(); f.setCandidates(() => pending.promise);
  await f.open();
  f.run('state.revision = 8; libraryId = "other-library"; render();');
  pending.resolve({ ok: true, tabs: defaults, excludedCount: 0 }); await flush();
  await f.check("Alpha"); await f.submit();
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0].expectedRevision, 7);
  assert.equal(f.actions[0].action.libraryId, "library-personal");
  assert.equal(f.actions[0].action.groupId, SYSTEM_GROUP_ID);
});

test("successful save focuses its destination after a deferred render even when the modal has already closed", async () => {
  const f = fixture(); await f.open(); await f.check("Alpha"); await f.target("destination");
  f.setInteraction(true); await f.submit();
  assert.equal(f.$("dialog").open, false); assert.equal(f.run("deferredRender"), true);
  assert.notEqual(f.document.activeElement?.dataset.focusKey, "g:library-personal:destination");
  f.setInteraction(false); f.run("flushPendingUI()");
  assert.equal(f.run("deferredRender"), false);
  assert.equal(f.document.activeElement.dataset.focusKey, "g:library-personal:destination");
  assert.equal(f.document.activeElement.scrolled, true);
});

test("failed save retains checkbox DOM, filter, destination and selection for retry", async () => {
  const f = fixture(); await f.open(); await f.check("Alpha"); await f.search("Alpha"); await f.target("destination");
  const input = f.checks()[0]; input.focus();
  f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }));
  await f.submit();
  assert.equal(f.$("dialog").open, true); assert.equal(f.checks()[0], input); assert.equal(input.checked, true);
  assert.equal(f.filter().value, "Alpha"); assert.equal(f.$("dialog-body").querySelector("select").value, "destination");
  assert.equal(f.document.activeElement, input); assert.match(f.$("dialog-error").textContent, /저장하지 못/u);
  assert.equal(f.$("dialog-submit").disabled, false);
  f.setResponse(null); await f.submit(); assert.equal(f.actions.length, 2); assert.equal(f.$("dialog").open, false);
});

test("conflicting save adopts newer catalog but preserves the user's candidate selection without partial insertion", async () => {
  const f = fixture(); await f.open(); await f.check("Alpha"); await f.target("destination");
  const fresh = structuredClone(f.context.initial.catalog); fresh.libraries[0].name = "Changed elsewhere";
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "다른 창에서 목록이 변경되었습니다.", revision: 8, catalog: fresh }));
  await f.submit();
  assert.equal(f.$("dialog").open, true); assert.equal(f.checks()[0].checked, true); assert.equal(f.count(), "1개 선택");
  assert.equal(f.run("state.revision"), 8); assert.equal(f.run("linksOf(library()).length"), 1);
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0].expectedRevision, 7);
  assert.match(f.$("dialog-error").textContent, /다른 창/u);
});

test("pending submission disables controls, ignores duplicate submits and does not close before result", async () => {
  const f = fixture(), pending = deferred(); await f.open(); await f.check("Alpha"); f.setResponse(() => pending.promise);
  const submitting = f.submit(); await flush();
  assert.equal(f.actions.length, 1); assert.equal(f.checks()[0].disabled, true); assert.equal(f.$("dialog-cancel").disabled, true);
  await f.submit(); await f.$("dialog-cancel").emit("click");
  assert.equal(f.actions.length, 1); assert.equal(f.$("dialog").open, true);
  pending.resolve({ ok: false, code: "SAVE_FAILED", error: "다시 시도해 주세요." }); await submitting;
  assert.equal(f.checks()[0].disabled, false); assert.equal(f.checks()[0].checked, true); assert.equal(f.$("dialog").open, true);
});

test("an empty supported candidate list and no selection cannot save even through synthetic submit", async () => {
  const f = fixture([tab("Already saved", "https://example.com/saved")]); await f.open();
  assert.equal(f.checks().length, 0); assert.equal(f.all().disabled, true);
  assert.equal(f.$("dialog-body").querySelector("select").disabled, true); assert.equal(f.$("dialog-submit").disabled, true);
  assert.match(f.$("dialog-body").textContent, /새로 담을 탭이 없습니다/u);
  await f.submit(); assert.equal(f.actions.length, 0); assert.equal(f.$("dialog").open, true);
});
