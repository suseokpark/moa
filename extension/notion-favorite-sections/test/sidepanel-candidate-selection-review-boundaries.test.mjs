import assert from "node:assert/strict";
import test from "node:test";
import { deferred, fixture, flush, tab } from "../test-support/candidate-picker-fixture.mjs";

// Shipped picker handlers, synthetic sources/storage and the real reducer only.
// Native browser focus, layout and source permission behavior are not asserted.
const rows = size => Array.from({ length: size }, (_, i) => ({
  ...tab(`Collection ${i}`, `https://example.org/collection/${i}`), folderPath: "Research / Collection"
}));
const bodyControl = (f, name) => f.$("dialog-body").querySelector(`.candidate-${name}`);
const toggle = f => {
  const control = bodyControl(f, "selection-review");
  assert.ok(control, "selected-only review has an explicit toggle");
  assert.equal(control.textContent, "선택한 항목만 보기");
  return control;
};
const switchView = async f => { await toggle(f).emit("click"); await flush(); };
const selectResults = async f => { await bodyControl(f, "select-results").emit("click"); await flush(); };
const response = (bookmarks, values) => ({ ok: true, ...(bookmarks ? { candidates: values } : { tabs: values }), excludedCount: 0 });
const latestWithSaved = (f, value) => {
  const latest = structuredClone(f.context.initial.catalog);
  latest.libraries[0].groups[0].links.push({ id: "saved-elsewhere", title: value.title, url: value.url, icon: "", provider: "generic" });
  return latest;
};
async function conflict(f, latest) {
  f.setCatalog(latest, 8);
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "목록이 바뀌었습니다.", catalog: latest, revision: 8 }));
  await f.submit();
}

for (const bookmarks of [false, true]) {
  const kind = bookmarks ? "bookmarks" : "tabs";

  test(`${kind}: 201 selected items ignore an empty search result and paginate without expanding its selection`, async () => {
    const f = fixture(rows(201), { bookmarks });
    await f.open(); await selectResults(f); await f.search("no-match-selected-review");
    assert.equal(f.checks().length, 0);
    assert.equal(f.count(), "201개 선택 · 화면 밖 201개 포함");
    await switchView(f);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "true");
    assert.equal(f.filter().value, "no-match-selected-review");
    assert.equal(f.filter().disabled, true);
    assert.equal(f.checks().length, 200);
    assert.ok(f.checks().every(check => check.checked));
    assert.equal(f.all().parentElement.hidden, true);
    assert.equal(bodyControl(f, "select-results").hidden, true);
    assert.equal(f.count(), "201개 선택 · 화면 밖 1개 포함");
    const more = f.$("dialog-body").querySelectorAll("button").find(control => control.textContent.startsWith("더 보기"));
    more.focus(); await f.clickText("더 보기");
    assert.equal(f.checks().length, 201);
    assert.equal(f.count(), "201개 선택");
    assert.equal(more.hidden, true);
    assert.equal(f.document.activeElement === f.checks()[200], true, "the hidden final-page trigger transfers focus to its newly revealed row");
    await f.check("Collection 200");
    assert.equal(f.checks().length, 200);
    assert.equal(f.document.activeElement, f.checks().at(-1), "removing the last rendered row focuses the preceding one");
    assert.equal(f.document.activeElement.getAttribute("aria-label"), "Collection 199 선택");
    await switchView(f);
    assert.equal(f.filter().value, "no-match-selected-review");
    assert.equal(f.filter().disabled, false);
    assert.equal(f.checks().length, 0);
    assert.equal(f.count(), "200개 선택 · 화면 밖 200개 포함");
    assert.equal(f.actions.length, 0);
    assert.equal(f.fetches(), 1);
  });

  test(`${kind}: review pagination never overwrites the prior normal limit or raises the 1000-link limit`, async () => {
    const f = fixture([...rows(1000), tab("Overflow", "https://example.net/overflow")], { bookmarks });
    await f.open(); await f.search("  COLLECTION  "); await f.clickText("더 보기"); await selectResults(f);
    assert.equal(f.checks().length, 400);
    assert.equal(f.count(), "1000개 선택 · 화면 밖 600개 포함");
    await switchView(f);
    assert.equal(f.checks().length, 200);
    await f.clickText("더 보기"); await f.clickText("더 보기");
    assert.equal(f.checks().length, 600);
    await switchView(f);
    assert.equal(f.filter().value, "  COLLECTION  ", "preserve exact raw search input");
    assert.equal(f.checks().length, 400);
    await switchView(f);
    assert.equal(f.checks().length, 200, "a new review visit starts with its own first page");
    await switchView(f); await f.search("Overflow"); await f.check("Overflow");
    assert.equal(f.checks()[0].checked, false);
    assert.match(f.$("dialog-error").textContent, /1,000/u);
    assert.equal(f.count(), "1000개 선택 · 화면 밖 1000개 포함");
    await switchView(f); await f.check("Collection 0");
    assert.equal(f.document.activeElement, f.checks()[0]);
    assert.equal(f.document.activeElement.getAttribute("aria-label"), "Collection 1 선택");
    await switchView(f); await f.check("Overflow");
    assert.equal(f.count(), "1000개 선택 · 화면 밖 999개 포함");
    await switchView(f); await f.submit();
    assert.equal(f.actions.length, 1);
    const links = f.actions[0].action.links;
    assert.equal(links.length, 1000);
    assert.ok(links.some(link => link.title === "Overflow"));
    assert.ok(!links.some(link => link.title === "Collection 0"));
    assert.equal(f.fetches(), 1);
  });

  test(`${kind}: normal pagination keeps focus on the first newly revealed row, including the final partial page`, async () => {
    const f = fixture(rows(401), { bookmarks }); await f.open();
    const more = f.$("dialog-body").querySelectorAll("button").find(control => control.textContent.startsWith("더 보기"));
    more.focus(); await f.clickText("더 보기");
    assert.equal(f.checks().length, 400);
    assert.equal(more.hidden, false);
    assert.equal(f.document.activeElement === f.checks()[200], true);
    more.focus(); await f.clickText("더 보기");
    assert.equal(f.checks().length, 401);
    assert.equal(more.hidden, true);
    assert.equal(f.document.activeElement === f.checks()[400], true);
    assert.equal(f.checks()[400].checked, false);
    assert.equal(f.count(), "0개 선택");
    assert.equal(f.actions.length, 0);
    assert.equal(f.fetches(), 1);
  });

  test(`${kind}: selected review stays inert while source loading or failed and becomes available only after selecting a loaded row`, async () => {
    const values = rows(201), f = fixture(values, { bookmarks }), pending = deferred();
    f.setCandidates(() => pending.promise);
    await f.open();
    assert.equal(toggle(f).disabled, true);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "false");
    await switchView(f);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "false");
    pending.resolve({ ok: false, error: "후보를 읽지 못했습니다." }); await flush();
    assert.equal(toggle(f).disabled, true);
    await switchView(f);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "false");
    f.setCandidates(async () => response(bookmarks, values));
    await f.clickText("다시 불러오기");
    assert.equal(toggle(f).disabled, true, "loaded but empty selection does not enter review");
    await switchView(f);
    assert.equal(f.checks().length, 200);
    await f.check("Collection 0");
    assert.equal(toggle(f).disabled, false);
    await switchView(f);
    assert.equal(f.checks().length, 1);
    assert.equal(f.actions.length, 0);
    assert.equal(f.fetches(), 2);
  });

  test(`${kind}: a save in flight blocks review switching and failed save preserves review, draft and captured selection`, async () => {
    const f = fixture(undefined, { bookmarks }), pending = deferred();
    await f.open(); await f.check("Alpha"); await f.check("Beta"); await f.search("Gamma");
    await f.target("destination"); await f.clickText("새 그룹에 담기");
    const name = bodyControl(f, "new-group-name"), parent = bodyControl(f, "new-group-parent");
    name.value = "Review draft"; await name.emit("input");
    parent.value = "group:parent"; await parent.emit("change");
    await switchView(f);
    f.setResponse(() => pending.promise);
    const saving = f.submit(); await flush();
    assert.equal(toggle(f).disabled, true);
    await switchView(f); await f.submit();
    assert.equal(toggle(f).getAttribute("aria-pressed"), "true");
    assert.equal(f.checks().length, 2);
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].action.links.length, 2);
    pending.resolve({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }); await saving;
    assert.equal(toggle(f).disabled, false);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "true");
    assert.equal(f.filter().disabled, true);
    assert.equal(name.value, "Review draft");
    assert.equal(parent.value, "group:parent");
    assert.equal(bodyControl(f, "target-group").value, "destination");
    await switchView(f);
    assert.equal(f.filter().value, "Gamma");
    assert.equal(f.filter().disabled, false);
    assert.equal(f.count(), "2개 선택 · 화면 밖 2개 포함");
    assert.equal(name.value, "Review draft");
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2);
    assert.equal(f.actions[1].action.type, "addLinksToNewGroup");
    assert.equal(f.actions[1].action.name, "Review draft");
    assert.equal(f.actions[1].action.parentGroupId, "parent");
    assert.equal(f.actions[1].action.links.length, 2);
  });

  test(`${kind}: latest conflict review may remove every selected item without trapping the empty selected view`, async () => {
    const values = rows(201), f = fixture(values, { bookmarks }), pending = deferred();
    await f.open(); await f.check("Collection 0"); await f.search("Collection"); await switchView(f);
    const latest = latestWithSaved(f, values[0]);
    await conflict(f, latest);
    f.setLoadResponse(() => pending.promise);
    await bodyControl(f, "review-button").emit("click"); await flush();
    assert.equal(toggle(f).disabled, true);
    await switchView(f);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "true");
    assert.equal(f.count(), "1개 선택");
    f.setCandidates(async () => response(bookmarks, [...values, tab("New source item")]));
    pending.resolve({ ok: true, catalog: latest, revision: 8 }); await flush();
    assert.equal(f.count(), "0개 선택");
    assert.equal(f.checks().length, 0);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "true");
    assert.equal(toggle(f).disabled, false, "zero-selection review retains its escape control");
    assert.equal(f.filter().disabled, true);
    assert.equal(f.$("dialog-submit").disabled, true);
    assert.equal(f.fetches(), 1, "latest review must not read browser sources again");
    assert.equal(f.loads(), 1);
    await switchView(f);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "false");
    assert.equal(toggle(f).disabled, true);
    assert.equal(f.filter().value, "Collection");
    assert.equal(f.filter().disabled, false);
    assert.equal(f.checks().length, 200);
    assert.ok(!f.checks().some(check => check.getAttribute("aria-label") === "Collection 0 선택"));
    assert.equal(f.actions.length, 1, "view switching and latest review never save by themselves");
  });

  test(`${kind}: detached review toggles and a cancelled pending review cannot replace a newer selection view`, async () => {
    const f = fixture(undefined, { bookmarks }), pending = deferred();
    await f.open(); await f.check("Alpha"); await switchView(f);
    const oldToggle = toggle(f), latest = structuredClone(f.context.initial.catalog);
    await conflict(f, latest); f.setLoadResponse(() => pending.promise);
    await bodyControl(f, "review-button").emit("click"); await flush();
    await f.$("dialog-cancel").emit("click");
    await oldToggle.emit("click"); await flush();
    assert.equal(f.$("dialog").open, false);
    await f.open(); await f.check("Gamma"); await f.search("Beta"); await switchView(f);
    const currentToggle = toggle(f), currentCheck = f.checks()[0];
    const late = structuredClone(latest); late.libraries[0].name = "Stale title";
    pending.resolve({ ok: true, catalog: late, revision: 9 }); await flush();
    await oldToggle.emit("click"); await flush();
    assert.equal(toggle(f), currentToggle);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "true");
    assert.equal(f.checks()[0], currentCheck);
    assert.equal(currentCheck.getAttribute("aria-label"), "Gamma 선택");
    assert.equal(currentCheck.checked, true);
    assert.equal(f.filter().value, "Beta");
    assert.equal(f.filter().disabled, true);
    assert.equal(f.count(), "1개 선택");
    assert.equal(f.run("state.revision"), 8);
    assert.notEqual(f.run("state.catalog.libraries[0].name"), "Stale title");
    assert.equal(f.actions.length, 1);
    assert.equal(f.fetches(), 2);
  });
}
