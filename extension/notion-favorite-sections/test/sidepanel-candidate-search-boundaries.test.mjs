import assert from "node:assert/strict";
import test from "node:test";
import { deferred, fixture, flush, tab } from "../test-support/candidate-picker-fixture.mjs";

// Independent composition checks use shipped picker handlers, candidate
// preparation and reducers with synthetic sources. No native Chrome data/UI.
const rows = size => Array.from({ length: size }, (_, i) => ({
  ...tab(`Design Guide ${i}`, `https://example.org/reference/${i}`), folderPath: "Research / Library"
}));
const control = (f, name) => f.$("dialog-body").querySelector(`.candidate-new-group-${name}`);
const shortcut = f => f.$("dialog-body").querySelector(".candidate-select-results");
const query = bookmarks => bookmarks ? "LiBRARY REFERENCE design" : "REFERENCE design";
const chooseResults = async f => { await shortcut(f).emit("click"); await flush(); };
async function draft(f) {
  await f.clickText("새 그룹에 담기");
  control(f, "name").value = "Research reading"; await control(f, "name").emit("input");
  control(f, "parent").value = "group:destination"; await control(f, "parent").emit("change");
}

for (const bookmarks of [false, true]) {
  const kind = bookmarks ? "bookmark" : "tab";

  test(`${kind} multiword result selection includes unrendered matches without borrowing terms from other candidates`, async () => {
    const values = [...rows(205), tab("Keep", "https://example.org/keep"),
      { ...tab("Design only", "https://example.org/elsewhere"), folderPath: "Library" },
      { ...tab("Unrelated", "https://example.org/reference/other"), folderPath: "Library" }];
    if (bookmarks) values.push({ ...tab("Design without folder", "https://example.org/reference/no-folder"), folderPath: "Elsewhere" });
    const f = fixture(values, { bookmarks }); await f.open();
    await f.search("Keep"); await f.check("Keep"); await draft(f);
    await f.search(query(bookmarks));
    assert.equal(f.checks().length, 200);
    assert.equal(shortcut(f).textContent, "검색 결과 전체 205개 선택");
    await chooseResults(f);
    assert.equal(f.count(), "206개 선택 · 화면 밖 6개 포함");
    assert.equal(control(f, "name").value, "Research reading");
    assert.equal(control(f, "parent").value, "group:destination");
    assert.equal(f.filter().value, query(bookmarks));
    assert.equal(f.actions.length, 0);
    await f.submit();
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].action.type, "addLinksToNewGroup");
    assert.equal(f.actions[0].action.parentGroupId, "destination");
    assert.equal(f.actions[0].action.links.length, 206);
    assert.ok(f.actions[0].action.links.every(item => item.title === "Keep" || /^Design Guide \d+$/u.test(item.title)));
  });

  test(`${kind} reordered multiword ranges permit an exact 1000 selection union and count overlap only once`, async () => {
    const f = fixture([...rows(999), tab("Keep", "https://example.org/keep")], { bookmarks });
    await f.open(); await f.check("Design Guide 0");
    await f.search("Keep"); await f.check("Keep"); await f.target("destination");
    await f.search(query(bookmarks)); await chooseResults(f);
    await f.search(query(bookmarks).split(" ").reverse().join("  ")); await chooseResults(f);
    assert.equal(shortcut(f).textContent, "검색 결과 전체 999개 선택");
    assert.equal(f.count(), "1000개 선택 · 화면 밖 800개 포함");
    assert.equal(f.$("dialog-error").textContent, "");
    assert.equal(f.$("dialog-body").querySelector(".candidate-target-group").value, "destination");
    assert.equal(f.actions.length, 0);
    await f.submit();
    assert.equal(f.actions[0].action.groupId, "destination");
    assert.equal(f.actions[0].action.links.length, 1000);
    assert.equal(new Set(f.actions[0].action.links.map(item => item.url)).size, 1000);
  });

  test(`${kind} multiword selection rejects a 1001 union atomically and an added term safely narrows the range`, async () => {
    const values = rows(1000).map((item, i) => ({ ...item, title: `${item.title} ${i < 205 ? "Focus" : "Other"}` }));
    const f = fixture([...values, tab("Keep", "https://example.org/keep")], { bookmarks });
    await f.open(); await f.search("Keep"); await f.check("Keep"); await draft(f);
    await f.search(query(bookmarks)); await chooseResults(f);
    assert.equal(shortcut(f).textContent, "검색 결과 전체 1000개 선택");
    assert.equal(f.count(), "1개 선택 · 화면 밖 1개 포함");
    assert.ok(f.checks().every(check => !check.checked));
    assert.match(f.$("dialog-error").textContent, /1,001개/u);
    assert.equal(f.actions.length, 0);
    await f.search(`FOCUS ${query(bookmarks)}`);
    assert.equal(shortcut(f).textContent, "검색 결과 전체 205개 선택");
    await chooseResults(f);
    assert.equal(f.count(), "206개 선택 · 화면 밖 6개 포함");
    assert.equal(f.$("dialog-error").textContent, "");
    assert.equal(control(f, "name").value, "Research reading");
    assert.equal(control(f, "parent").value, "group:destination");
    await f.submit();
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].action.links.length, 206);
    assert.ok(f.actions[0].action.links.every(item => item.title === "Keep" || item.title.endsWith(" Focus")));
  });

  test(`${kind} conflict review retains the raw multiword query, hidden choice and new-group draft while recomputing matches`, async () => {
    const values = [...rows(250), tab("Keep", "https://example.org/keep")];
    const f = fixture(values, { bookmarks }), pending = deferred(); await f.open();
    await f.check("Design Guide 0"); await f.search("Keep"); await f.check("Keep"); await draft(f);
    const rawQuery = ` \t${query(bookmarks)}  \n`;
    await f.search(rawQuery);
    const latest = structuredClone(f.run("state.catalog"));
    latest.libraries[0].groups[0].links.push({ id: "saved-elsewhere", title: values[0].title, url: values[0].url, icon: "", provider: "generic" });
    latest.libraries[0].groups[1].groups[0].name = "Reviewed destination";
    f.setCatalog(latest, 8);
    f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "목록이 바뀌었습니다.", catalog: latest, revision: 8 }));
    await f.submit();
    assert.equal(f.$("dialog-submit").disabled, true);
    f.setLoadResponse(() => pending.promise);
    await f.$("dialog-body").querySelector(".candidate-review-button").emit("click"); await flush();
    assert.equal(f.filter().disabled, true); assert.equal(shortcut(f).disabled, true);
    await chooseResults(f);
    assert.equal(f.count(), "2개 선택 · 화면 밖 1개 포함");
    assert.equal(f.actions.length, 1, "pending review never retries the write");
    const newSourceItem = { ...tab("Design late addition", "https://example.org/reference/late"), folderPath: "Library" };
    f.setCandidates(async () => ({ ok: true, ...(bookmarks ? { candidates: [...values, newSourceItem] } : { tabs: [...values, newSourceItem] }), excludedCount: 0 }));
    pending.resolve({ ok: true, catalog: latest, revision: 8 }); await flush();
    assert.equal(f.filter().value, rawQuery);
    assert.equal(f.count(), "1개 선택 · 화면 밖 1개 포함");
    assert.equal(control(f, "fields").hidden, false);
    assert.equal(control(f, "name").value, "Research reading");
    assert.equal(control(f, "parent").value, "group:destination");
    assert.match(control(f, "preview").textContent, /Parent › Reviewed destination › Research reading/u);
    assert.equal(shortcut(f).textContent, "검색 결과 전체 249개 선택");
    assert.equal(f.fetches(), 1, "review does not re-read browser source data");
    assert.equal(f.actions.length, 1);
    await chooseResults(f);
    assert.equal(f.count(), "250개 선택 · 화면 밖 50개 포함");
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
    assert.equal(f.actions[1].action.type, "addLinksToNewGroup");
    assert.equal(f.actions[1].action.parentGroupId, "destination");
    assert.equal(f.actions[1].action.links.length, 250);
    assert.ok(f.actions[1].action.links.some(item => item.title === "Keep"));
    assert.ok(f.actions[1].action.links.every(item => item.url !== values[0].url && item.url !== newSourceItem.url));
  });
}
