import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_GROUP_ID } from "../src/link-library.js";
import { deferred, fixture, flush, tab } from "../test-support/candidate-picker-fixture.mjs";

// Real shipped picker handlers plus the real reducer, isolated synthetic DOM and
// storage. These contracts do not claim native browser or permission-prompt QA.
const items = [tab("Alpha"), tab("Beta"), tab("Gamma")];
const clone = value => structuredClone(value);
const reviewButton = f => f.$("dialog-body").querySelector(".candidate-review-button");
const targetGroup = f => f.$("dialog-body").querySelector(".candidate-target-group");
const freshCatalog = f => clone(f.context.initial.catalog);
const isVisible = control => {
  if (!control) return false;
  for (let element = control; element; element = element.parentElement) if (element.hidden) return false;
  return true;
};
async function conflict(f, catalog = freshCatalog(f), revision = 8) {
  f.setCatalog(catalog, revision);
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "다른 창에서 목록이 변경되었습니다.", catalog, revision }));
  await f.submit();
}
async function review(f) {
  const control = reviewButton(f);
  assert.ok(control, "explicit review control is offered");
  assert.equal(isVisible(control), true);
  assert.match(control.textContent, /선택 유지하고 최신 목록 검토/u);
  await control.emit("click"); await flush();
}

for (const bookmarks of [false, true]) {
  const kind = bookmarks ? "bookmarks" : "tabs";
  const setup = () => fixture(items, { bookmarks });

  test(`${kind}: conflict blocks regular and synthetic save until explicit review`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha"); await f.target("destination");
    await conflict(f);
    assert.equal(f.$("dialog").open, true);
    assert.equal(f.$("dialog-submit").disabled, true, "stale revision cannot be resubmitted");
    assert.equal(f.checks()[0].checked, true);
    assert.equal(f.actions.length, 1); assert.equal(f.loads(), 0);
    await f.search("Beta"); await f.check("Beta");
    assert.equal(f.$("dialog-submit").disabled, true, "changing choices cannot clear the conflict guard");
    await f.submit();
    assert.equal(f.actions.length, 1, "direct form submit cannot bypass conflict guard");
    assert.equal(f.$("dialog-submit").disabled, true);
    assert.ok(reviewButton(f));
  });

  test(`${kind}: explicit review retains filter, selection and group identity without fetching source candidates or saving`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha"); await f.check("Beta");
    await f.search("alpha"); await f.target("destination");
    const latest = freshCatalog(f); latest.libraries[0].groups[1].name = "Renamed parent";
    latest.libraries[0].groups[1].groups[0].name = "Renamed destination";
    await conflict(f, latest); await review(f);
    assert.equal(f.loads(), 1); assert.equal(f.fetches(), 1); assert.equal(f.actions.length, 1);
    assert.equal(f.filter().value, "alpha"); assert.equal(f.count(), "2개 선택 · 화면 밖 1개 포함");
    assert.equal(f.checks()[0].checked, true); assert.equal(targetGroup(f).value, "destination");
    assert.match(targetGroup(f).selectedOptions[0].textContent, /Renamed parent.*Renamed destination/u);
    assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.$("dialog").open, true);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
    assert.equal(f.actions[1].action.groupId, "destination");
    assert.equal(f.actions[1].action.libraryId, "library-personal");
    assert.deepEqual(f.actions[1].action.links.map(link => link.title), ["Alpha", "Beta"]);
    assert.equal(f.$("dialog").open, false);
  });

  test(`${kind}: deleted target group requires a new explicit group choice before saving`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha"); await f.target("destination");
    const latest = freshCatalog(f); latest.libraries[0].groups[1].groups = [];
    await conflict(f, latest); await review(f);
    assert.equal(targetGroup(f).value, "", "removed group must not silently fall back to the first group");
    assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.count(), "1개 선택");
    await f.submit(); assert.equal(f.actions.length, 1);
    await f.target(SYSTEM_GROUP_ID); assert.equal(f.$("dialog-submit").disabled, false);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.actions[1].action.groupId, SYSTEM_GROUP_ID);
  });

  test(`${kind}: deleted library requires explicit library and group choices, never the background fallback`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha");
    const latest = freshCatalog(f); latest.libraries.shift();
    await conflict(f, latest); await review(f);
    const chooseLibrary = f.$("dialog-body").querySelector(".candidate-review-library");
    assert.ok(chooseLibrary); assert.equal(chooseLibrary.value, "");
    assert.match(chooseLibrary.parentElement.textContent, /저장할 보관함/u);
    assert.equal(targetGroup(f).value, ""); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); assert.equal(f.actions.length, 1);
    chooseLibrary.value = "other-library"; await chooseLibrary.emit("change");
    assert.equal(targetGroup(f).value, "", "same system group ID in another library is not implicit consent");
    assert.equal(f.count(), "1개 선택"); assert.equal(f.$("dialog-submit").disabled, true);
    await f.target(SYSTEM_GROUP_ID); f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
    assert.equal(f.actions[1].action.libraryId, "other-library");
    assert.equal(f.actions[1].action.groupId, SYSTEM_GROUP_ID);
    assert.equal(f.run("libraryId"), "other-library");
  });

  test(`${kind}: review removes already-saved selections but never automatically selects remaining or newly opened candidates`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha"); await f.check("Beta"); await f.search("alpha");
    const latest = freshCatalog(f);
    latest.libraries[0].groups[0].links.push({ id: "remote-alpha", title: "Already Alpha", url: items[0].url, icon: "", provider: "generic" });
    f.setCandidates(async () => ({ ok: true, tabs: [...items, tab("New")], candidates: [...items, tab("New")] }));
    await conflict(f, latest); await review(f);
    assert.equal(f.fetches(), 1); assert.equal(f.filter().value, "alpha");
    assert.equal(f.count(), "1개 선택 · 화면 밖 1개 포함"); assert.equal(f.checks().length, 0);
    await f.search("");
    assert.deepEqual(f.checks().map(input => input.getAttribute("aria-label")), ["Beta 선택", "Gamma 선택"]);
    assert.equal(f.checks()[0].checked, true); assert.equal(f.checks()[1].checked, false);
    f.setResponse(null); await f.submit();
    assert.deepEqual(f.actions[1].action.links.map(link => link.title), ["Beta"]);
  });

  test(`${kind}: choosing a replacement library rechecks duplicates in that library without selecting anything new`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha"); await f.check("Beta");
    const latest = freshCatalog(f); latest.libraries.shift();
    latest.libraries[0].groups[0].links.push({ id: "other-alpha", title: "Alpha", url: items[0].url, icon: "", provider: "generic" });
    await conflict(f, latest); await review(f);
    const chooseLibrary = f.$("dialog-body").querySelector(".candidate-review-library");
    chooseLibrary.value = "other-library"; await chooseLibrary.emit("change");
    assert.equal(f.count(), "1개 선택"); assert.equal(targetGroup(f).value, "");
    assert.deepEqual(f.checks().map(input => input.getAttribute("aria-label")), ["Beta 선택", "Gamma 선택"]);
    assert.equal(f.checks()[0].checked, true); assert.equal(f.checks()[1].checked, false);
    await f.target(SYSTEM_GROUP_ID); f.setResponse(null); await f.submit();
    assert.deepEqual(f.actions[1].action.links.map(link => link.title), ["Beta"]);
    assert.equal(f.actions[1].action.libraryId, "other-library"); assert.equal(f.fetches(), 1);
  });

  test(`${kind}: source item excluded as saved returns after deletion but is never selected automatically`, async () => {
    const f = fixture([...items, tab("Previously saved", "https://example.com/saved")], { bookmarks });
    await f.open(); assert.equal(f.checks().length, 3); await f.check("Alpha");
    const latest = freshCatalog(f); latest.libraries[0].groups[0].links = [];
    await conflict(f, latest); await review(f);
    assert.equal(f.checks().length, 4); assert.equal(f.count(), "1개 선택");
    assert.equal(f.checks()[0].checked, true);
    const returned = f.checks().find(input => input.getAttribute("aria-label") === "Previously saved 선택");
    assert.ok(returned); assert.equal(returned.checked, false);
    assert.equal(f.loads(), 1); assert.equal(f.fetches(), 1); assert.equal(f.actions.length, 1);
    f.setResponse(null); await f.submit();
    assert.deepEqual(f.actions[1].action.links.map(link => link.title), ["Alpha"]);
  });

  test(`${kind}: review note reports the exact selected-only exclusion count and remaining choices`, async () => {
    for (const savedCount of [0, 1, 2, 3]) {
      const f = setup(); await f.open(); for (const item of items) await f.check(item.title);
      const latest = freshCatalog(f);
      latest.libraries[0].groups[0].links.push(...items.slice(0, savedCount).map((item, index) => ({
        id: `remote-${index}`, title: item.title, url: item.url, icon: "", provider: "generic"
      })));
      await conflict(f, latest); await review(f);
      const note = f.$("dialog-body").querySelector('.candidate-review [role="status"]');
      assert.ok(note);
      assert.ok(note.textContent.includes(`이미 저장된 선택 ${savedCount}개 제외 · ${3 - savedCount}개 유지.`));
      assert.equal(f.count(), `${3 - savedCount}개 선택`);
      assert.equal(f.actions.length, 1); assert.equal(f.$("dialog-submit").disabled, savedCount === 3);
    }
  });

  test(`${kind}: changed filter and destination survive SAVE_FAILED after review and retry uses reviewed revision`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha"); await f.check("Beta"); await f.target("destination");
    await conflict(f); await review(f); await f.search("Alpha"); await f.target("parent");
    const checkbox = f.checks()[0];
    f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }));
    await f.submit();
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, false);
    assert.equal(f.checks()[0], checkbox); assert.equal(checkbox.checked, true);
    assert.equal(f.filter().value, "Alpha"); assert.equal(targetGroup(f).value, "parent");
    assert.equal(f.count(), "2개 선택 · 화면 밖 1개 포함"); assert.equal(f.loads(), 1);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 3); assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.actions[2].expectedRevision, 8);
    assert.equal(f.actions[2].action.groupId, "parent");
    assert.deepEqual(f.actions[2].action.links.map(link => link.title), ["Alpha", "Beta"]);
    assert.equal(f.$("dialog").open, false); assert.equal(f.loads(), 1); assert.equal(f.fetches(), 1);
  });

  test(`${kind}: saving into a replacement library different from fallback reveals that explicit library`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha");
    const latest = freshCatalog(f); latest.libraries.shift();
    latest.libraries.push({ id: "chosen-library", name: "Explicit destination", groups: [
      { id: SYSTEM_GROUP_ID, name: "Chosen group", links: [], groups: [], collapsed: true }
    ] });
    await conflict(f, latest); assert.equal(f.run("libraryId"), "other-library"); await review(f);
    const chooseLibrary = f.$("dialog-body").querySelector(".candidate-review-library");
    chooseLibrary.value = "chosen-library"; await chooseLibrary.emit("change");
    assert.equal(f.run("libraryId"), "other-library", "review must not navigate the background tree before saving");
    await f.target(SYSTEM_GROUP_ID); f.setResponse(null); await f.submit();
    assert.equal(f.actions[1].action.libraryId, "chosen-library"); assert.equal(f.run("libraryId"), "chosen-library");
    assert.equal(f.$("library-picker").value, "chosen-library");
    assert.equal(f.document.activeElement.dataset.focusKey, `g:chosen-library:${SYSTEM_GROUP_ID}`);
  });

  test(`${kind}: if every selected item was saved elsewhere, review leaves an empty selection and cannot dispatch`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha");
    const latest = freshCatalog(f);
    latest.libraries[0].groups[1].groups[0].links.push({ id: "remote-alpha", title: "Alpha", url: items[0].url, icon: "", provider: "generic" });
    await conflict(f, latest); await review(f);
    assert.equal(f.count(), "0개 선택"); assert.equal(f.$("dialog-submit").disabled, true);
    assert.ok(f.checks().every(input => !input.checked)); await f.submit();
    assert.equal(f.actions.length, 1); assert.equal(f.$("dialog").open, true);
  });

  test(`${kind}: a second conflict after review blocks saving again until another explicit read`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha"); await conflict(f); await review(f);
    const latest = freshCatalog(f); latest.libraries[0].name = "Another update";
    f.setCatalog(latest, 9);
    f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "다른 창에서 목록이 변경되었습니다.", revision: 9, catalog: latest }));
    await f.submit(); assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
    assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 2);
    await review(f); assert.equal(f.loads(), 2); assert.equal(f.fetches(), 1);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 3); assert.equal(f.actions[2].expectedRevision, 9);
  });

  test(`${kind}: failed review reads preserve choices and require retry without leaking raw diagnostics`, async () => {
    for (const throws of [false, true]) {
      const f = setup(); await f.open(); await f.check("Alpha"); await f.search("alpha"); await f.target("destination");
      await conflict(f);
      f.setLoadResponse(async () => {
        if (throws) throw new Error("private browser storage diagnostics");
        return { ok: false, code: "LOAD_FAILED", error: "private browser storage diagnostics" };
      });
      await review(f);
      assert.equal(f.filter().value, "alpha"); assert.equal(f.count(), "1개 선택");
      assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.checks()[0].checked, true);
      assert.doesNotMatch(f.$("dialog-body").textContent + f.$("dialog-error").textContent, /private browser storage/u);
      await f.submit(); assert.equal(f.actions.length, 1);
      f.setLoadResponse(null); await review(f);
      assert.equal(f.loads(), 2); assert.equal(f.$("dialog-submit").disabled, false);
      assert.equal(targetGroup(f).value, "destination"); assert.equal(f.fetches(), 1);
    }
  });

  test(`${kind}: pending review blocks duplicate reads and saves while cancellation remains available`, async () => {
    const f = setup(), pending = deferred(); await f.open(); await f.check("Alpha"); await conflict(f);
    f.setLoadResponse(() => pending.promise);
    await reviewButton(f).emit("click"); await flush();
    assert.equal(f.loads(), 1); assert.equal(f.$("dialog-submit").disabled, true);
    await reviewButton(f).emit("click"); await flush(); await f.submit();
    assert.equal(f.loads(), 1); assert.equal(f.actions.length, 1);
    assert.equal(f.$("dialog-cancel").disabled, false);
    await f.$("dialog-cancel").emit("click"); assert.equal(f.$("dialog").open, false);
    pending.resolve({ ok: true, catalog: freshCatalog(f), revision: 8 }); await flush();
    assert.equal(f.$("dialog").open, false); assert.equal(f.actions.length, 1);
  });

  test(`${kind}: cancelled review response cannot overwrite a different dialog`, async () => {
    const f = setup(), pending = deferred(); await f.open(); await f.check("Alpha"); await conflict(f);
    f.setLoadResponse(() => pending.promise);
    await reviewButton(f).emit("click"); await flush();
    await f.$("dialog-cancel").emit("click"); await f.$("add-group").emit("click");
    const body = f.$("dialog-body").children[0], error = f.$("dialog-error").textContent;
    const latest = freshCatalog(f); latest.libraries[0].name = "Do not apply stale read";
    pending.resolve({ ok: true, catalog: latest, revision: 9 }); await flush();
    assert.equal(f.$("dialog-title").textContent, "그룹 만들기");
    assert.equal(f.$("dialog-body").children[0], body); assert.equal(f.$("dialog-error").textContent, error);
    assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.run("state.revision"), 8);
    assert.equal(f.actions.length, 1);
  });

  test(`${kind}: late older picker review does not alter a newer candidate dialog or its choices`, async () => {
    const f = setup(), pending = deferred(); await f.open(); await f.check("Alpha"); await conflict(f);
    f.setLoadResponse(() => pending.promise); await reviewButton(f).emit("click"); await flush();
    await f.$("dialog-cancel").emit("click"); await f.open(); await f.check("Gamma");
    const chosen = f.checks()[2]; pending.resolve({ ok: true, catalog: freshCatalog(f), revision: 9 }); await flush();
    assert.equal(f.checks()[2], chosen); assert.equal(chosen.checked, true); assert.equal(f.count(), "1개 선택");
    assert.equal(f.loads(), 1); assert.equal(f.fetches(), 2); assert.equal(f.run("state.revision"), 8);
    assert.equal(f.actions.length, 1);
  });

  test(`${kind}: review refuses a revision older than current state, including one that becomes stale during the read`, async () => {
    for (const stateAdvancesDuringRead of [false, true]) {
      const f = setup(), pending = deferred(); await f.open(); await f.check("Alpha"); await conflict(f);
      f.setLoadResponse(() => pending.promise); await reviewButton(f).emit("click"); await flush();
      if (stateAdvancesDuringRead) f.run("state.revision = 10;");
      pending.resolve({ ok: true, catalog: freshCatalog(f), revision: stateAdvancesDuringRead ? 9 : 7 }); await flush();
      assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.count(), "1개 선택");
      await f.submit(); assert.equal(f.actions.length, 1);
      assert.equal(f.run("state.revision"), stateAdvancesDuringRead ? 10 : 8);
    }
  });

  test(`${kind}: malformed review snapshots cannot clear the conflict gate or overwrite the adopted catalog`, async () => {
    for (const malformed of [
      { ok: true, revision: 8 },
      { ok: true, revision: 8, catalog: { libraries: [] } },
      { ok: true, revision: "8", catalog: null }
    ]) {
      const f = setup(); await f.open(); await f.check("Alpha"); await conflict(f);
      const adopted = clone(f.run("state.catalog"));
      f.setLoadResponse(async () => malformed); await review(f);
      assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.count(), "1개 선택");
      assert.deepEqual(clone(f.run("state.catalog")), adopted);
      assert.equal(f.run("state.revision"), 8); await f.submit(); assert.equal(f.actions.length, 1);
      f.setLoadResponse(null); await review(f); assert.equal(f.$("dialog-submit").disabled, false);
    }
  });

  test(`${kind}: SAVE_FAILED keeps ordinary explicit retry without requiring conflict review`, async () => {
    const f = setup(); await f.open(); await f.check("Alpha"); await f.search("alpha"); await f.target("destination");
    f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }));
    await f.submit(); assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.loads(), 0);
    assert.equal(f.filter().value, "alpha"); assert.equal(targetGroup(f).value, "destination");
    assert.equal(isVisible(reviewButton(f)), false);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 7);
    assert.equal(f.$("dialog").open, false); assert.equal(f.loads(), 0);
  });
}
