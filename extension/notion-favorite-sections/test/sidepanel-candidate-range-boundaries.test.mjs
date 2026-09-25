import assert from "node:assert/strict";
import test from "node:test";
import { deferred, fixture, flush, tab } from "../test-support/candidate-picker-fixture.mjs";

// Independent boundary checks run the shipped picker with synthetic browser
// sources and a real reducer. Native Chrome focus/layout are not asserted here.
const rows = (size = 250) => Array.from({ length: size }, (_, i) => ({
  ...tab(`Collection ${i}`, `https://example.org/collection/${i}`), folderPath: "Research / Collection"
}));
const shortcut = f => {
  const control = f.$("dialog-body").querySelector(".candidate-select-results");
  assert.ok(control, "an explicit all-results action exists");
  return control;
};
const chooseResults = async f => { await shortcut(f).emit("click"); await flush(); };
const response = (bookmarks, values) => ({ ok: true, ...(bookmarks ? { candidates: values } : { tabs: values }), excludedCount: 0 });
const review = f => f.$("dialog-body").querySelector(".candidate-review-button");

for (const bookmarks of [false, true]) {
  const kind = bookmarks ? "bookmarks" : "tabs";

  test(`${kind}: whole-result selection uses prepared candidates only and never mutates source metadata`, async () => {
    const values = rows();
    values.push(tab("Already saved", "https://example.com/saved"), { ...values[0], title: "Duplicate source" },
      tab("Unsupported", "javascript:void(0)"));
    if (!bookmarks) values.push({ ...tab("Private tab"), incognito: true });
    for (const value of values) Object.freeze(value);
    Object.freeze(values);
    const original = JSON.stringify(values), f = fixture(values, { bookmarks });
    await f.open();
    assert.equal(shortcut(f).textContent, "전체 250개 선택");
    await chooseResults(f);
    assert.equal(f.count(), "250개 선택 · 화면 밖 50개 포함");
    assert.equal(f.actions.length, 0, "selecting never dispatches a write");
    await f.submit();
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].action.links.length, 250);
    assert.ok(f.actions[0].action.links.every(link => Object.keys(link).sort().join(",") === "title,url"));
    assert.equal(JSON.stringify(values), original);
    assert.equal(f.opened.length, 0, "candidate selection does not navigate or close source tabs");
  });

  test(`${kind}: whole-result action stays inert through loading and read failure until explicit retry succeeds`, async () => {
    const values = rows(), f = fixture(values, { bookmarks }), pending = deferred();
    f.setCandidates(() => pending.promise);
    await f.open();
    assert.equal(shortcut(f).disabled, true);
    assert.equal(shortcut(f).hidden, true);
    await chooseResults(f);
    assert.equal(f.count(), "0개 선택");
    assert.equal(f.actions.length, 0);
    pending.resolve({ ok: false, error: "후보를 읽지 못했습니다." }); await flush();
    assert.equal(shortcut(f).disabled, true);
    await chooseResults(f);
    assert.equal(f.count(), "0개 선택");
    f.setCandidates(async () => response(bookmarks, values));
    await f.clickText("다시 불러오기");
    assert.equal(shortcut(f).disabled, false);
    assert.equal(shortcut(f).hidden, false);
    assert.equal(f.fetches(), 2);
    await chooseResults(f);
    assert.equal(f.count(), "250개 선택 · 화면 밖 50개 포함");
    assert.equal(f.actions.length, 0);
  });

  test(`${kind}: cancelling drops the range choice and detached old controls cannot change a replacement picker`, async () => {
    const f = fixture(rows(), { bookmarks });
    await f.open();
    const previous = shortcut(f);
    await chooseResults(f);
    await f.$("dialog-cancel").emit("click");
    assert.equal(f.$("dialog").open, false);
    await previous.emit("click"); await flush();
    assert.equal(f.$("dialog").open, false);
    assert.equal(f.actions.length, 0);
    await f.open();
    assert.equal(f.count(), "0개 선택", "cancelled choices do not persist across pickers");
    await f.check("Collection 0");
    const current = shortcut(f), first = f.checks()[0];
    await previous.emit("click"); await flush();
    assert.equal(shortcut(f), current);
    assert.equal(f.checks()[0], first);
    assert.equal(first.checked, true);
    assert.equal(f.count(), "1개 선택");
    assert.equal(f.$("dialog-submit").textContent, "선택한 1개 담기");
    assert.equal(f.actions.length, 0);
  });

  test(`${kind}: pending latest-review blocks range selection and reviewed saved exclusions update its entire range`, async () => {
    const values = rows(), f = fixture(values, { bookmarks }), pending = deferred();
    await f.open(); await f.check("Collection 0"); await f.target("destination");
    const latest = structuredClone(f.context.initial.catalog);
    latest.libraries[0].groups[0].links.push({ id: "remote-selected", title: values[0].title, url: values[0].url, icon: "", provider: "generic" });
    f.setCatalog(latest, 8);
    f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "다른 화면에서 변경되었습니다.", catalog: latest, revision: 8 }));
    await f.submit();
    assert.equal(f.$("dialog-submit").disabled, true);
    f.setLoadResponse(() => pending.promise);
    await review(f).emit("click"); await flush();
    assert.equal(shortcut(f).disabled, true);
    await chooseResults(f);
    assert.equal(f.count(), "1개 선택", "a synthetic click cannot bypass the active review gate");
    assert.equal(f.actions.length, 1);
    f.setCandidates(async () => response(bookmarks, [...values, tab("New source item")]));
    pending.resolve({ ok: true, catalog: latest, revision: 8 }); await flush();
    assert.equal(f.count(), "0개 선택", "the only selected link was already saved elsewhere");
    assert.equal(shortcut(f).textContent, "전체 249개 선택");
    assert.equal(shortcut(f).disabled, false);
    assert.equal(f.fetches(), 1, "review uses the original source snapshot");
    await chooseResults(f);
    assert.equal(f.count(), "249개 선택 · 화면 밖 49개 포함");
    assert.equal(f.actions.length, 1, "review and selecting remain read-only");
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2);
    assert.equal(f.actions[1].expectedRevision, 8);
    assert.equal(f.actions[1].action.links.length, 249);
    assert.ok(f.actions[1].action.links.every(link => link.url !== values[0].url && link.title !== "New source item"));
  });

  test(`${kind}: a pending save cannot change the captured selection through the range shortcut and failure permits explicit retry`, async () => {
    const f = fixture(rows(), { bookmarks }), pending = deferred();
    await f.open(); await f.check("Collection 0");
    f.setResponse(() => pending.promise);
    const saving = f.submit(); await flush();
    assert.equal(shortcut(f).disabled, true);
    await chooseResults(f);
    assert.equal(f.count(), "1개 선택");
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].action.links.length, 1);
    assert.equal(f.$("dialog-cancel").disabled, true);
    pending.resolve({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }); await saving;
    assert.equal(shortcut(f).disabled, false);
    assert.equal(f.count(), "1개 선택");
    assert.equal(f.$("dialog").open, true);
    await chooseResults(f);
    assert.equal(f.count(), "250개 선택 · 화면 밖 50개 포함");
    assert.equal(f.actions.length, 1);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2);
    assert.equal(f.actions[1].action.links.length, 250);
    assert.equal(f.$("dialog").open, false);
  });
}
