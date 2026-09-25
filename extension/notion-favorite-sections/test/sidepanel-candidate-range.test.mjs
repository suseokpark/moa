import assert from "node:assert/strict";
import test from "node:test";
import { fixture, tab } from "../test-support/candidate-picker-fixture.mjs";
import { createCatalogService, FAVMOA_STORAGE_KEY } from "../src/favmoa-service.js";

const rows = (size, prefix = "Research") => Array.from({ length: size }, (_, i) => ({
  ...tab(`${prefix} ${i}`, `https://example.org/${prefix.toLowerCase()}/${i}`), folderPath: `Work / ${prefix}`
}));
const selectResults = f => f.$("dialog-body").querySelector(".candidate-select-results");

test("all matching tabs can be selected without loading more rows and are saved only on explicit submit", async () => {
  const input = rows(405), original = JSON.stringify(input), f = fixture(input);
  await f.open(); await f.search("Research");
  assert.equal(f.checks().length, 200);
  const shortcut = selectResults(f);
  assert.ok(shortcut, "an explicit all-results action, separate from visible select-all");
  assert.equal(shortcut.textContent, "검색 결과 전체 405개 선택");
  await f.clickText("검색 결과 전체");
  assert.equal(f.count(), "405개 선택 · 화면 밖 205개 포함");
  assert.equal(f.checks().length, 200);
  assert.equal(f.actions.length, 0);
  await f.target("destination"); await f.submit();
  assert.equal(f.actions.length, 1); assert.equal(f.actions[0].action.links.length, 405);
  assert.equal(f.actions[0].action.links.at(-1).url, input.at(-1).url);
  assert.equal(JSON.stringify(input), original);
});

test("all-results selection refuses a 1001-item union without partially selecting or dropping hidden choices", async () => {
  const f = fixture([...rows(1000), tab("Keep", "https://example.org/keep")]);
  await f.open(); await f.search("Keep"); await f.check("Keep"); await f.search("Research");
  await f.clickText("검색 결과 전체");
  assert.equal(f.count(), "1개 선택 · 화면 밖 1개 포함");
  assert.ok(f.checks().every(check => !check.checked));
  assert.match(f.$("dialog-error").textContent, /1,000개/u);
  assert.equal(f.actions.length, 0);
});

for (const bookmarks of [false, true]) {
  const source = bookmarks ? "bookmarks" : "tabs";
  test(`${source}: filtered range includes unrendered matches but preserves unrelated hidden selection`, async () => {
    const f = fixture([...rows(405), ...rows(205, "Travel")], { bookmarks });
    await f.open(); await f.search("Travel 204"); await f.check("Travel 204");
    await f.search(bookmarks ? "Work / Research" : "/research/");
    const shortcut = selectResults(f); shortcut.focus(); const check = f.checks()[0];
    await f.clickText("검색 결과 전체");
    assert.equal(f.count(), "406개 선택 · 화면 밖 206개 포함");
    assert.equal(f.document.activeElement, shortcut); assert.equal(f.checks()[0], check);
    assert.equal(f.filter().value, bookmarks ? "Work / Research" : "/research/");
    assert.equal(f.actions.length, 0); await f.submit();
    assert.equal(f.actions[0].action.links.length, 406);
    assert.equal(f.actions[0].action.links.filter(item => item.title.startsWith("Travel")).length, 1);
    assert.equal(f.actions[0].action.links.at(-1).title, "Travel 204");
  });

  test(`${source}: exact 1000-item union counts overlap only once and repeated range selection is additive`, async () => {
    const f = fixture([...rows(999), tab("Keep", "https://example.org/keep")], { bookmarks });
    await f.open(); await f.check("Research 0"); await f.search("Keep"); await f.check("Keep");
    await f.search("Research"); await f.clickText("검색 결과 전체"); await f.clickText("검색 결과 전체");
    assert.equal(f.count(), "1000개 선택 · 화면 밖 800개 포함");
    assert.equal(f.$("dialog-error").textContent, "");
    assert.equal(f.checks().length, 200); await f.submit();
    assert.equal(f.actions[0].action.links.length, 1000);
    assert.equal(new Set(f.actions[0].action.links.map(item => item.url)).size, 1000);
  });

  test(`${source}: excessive full range is not silently truncated and filtering makes a smaller range selectable`, async () => {
    const f = fixture([...rows(1001), ...rows(205, "Travel")], { bookmarks });
    await f.open(); await f.clickText("전체 1206개 선택");
    assert.equal(f.count(), "0개 선택"); assert.equal(f.$("dialog-submit").disabled, true);
    assert.match(f.$("dialog-error").textContent, /1,206개/u);
    await f.search("Travel"); await f.clickText("검색 결과 전체");
    assert.equal(f.count(), "205개 선택 · 화면 밖 5개 포함");
    assert.equal(f.$("dialog-error").textContent, ""); await f.submit();
    assert.equal(f.actions[0].action.links.length, 205);
    assert.ok(f.actions[0].action.links.every(item => item.title.startsWith("Travel")));
  });

  test(`${source}: visible-only deselection leaves unrendered choices and range selection restores just its scope`, async () => {
    const f = fixture(rows(405), { bookmarks }); await f.open(); await f.clickText("전체 405개 선택");
    await f.all().emit("change"); assert.equal(f.count(), "205개 선택 · 화면 밖 205개 포함");
    await f.clickText("전체 405개 선택"); assert.equal(f.count(), "405개 선택 · 화면 밖 205개 포함");
    await f.clickText("더 보기"); assert.equal(f.count(), "405개 선택 · 화면 밖 5개 포함");
    assert.equal(f.checks().length, 400); assert.ok(f.checks().every(check => check.checked));
    await f.clickText("더 보기"); assert.equal(f.count(), "405개 선택");
    assert.equal(selectResults(f).hidden, true);
    assert.equal(f.$("dialog-body").querySelector("#candidate-result-scope").hidden, true);
    assert.equal(f.actions.length, 0);
  });

  test(`${source}: clearing whole-result choices retains search and cancellation never persists selections`, async () => {
    const f = fixture(rows(405), { bookmarks }); await f.open(); await f.search("Research");
    await f.clickText("검색 결과 전체"); await f.clickText("선택 해제");
    assert.equal(f.count(), "0개 선택"); assert.equal(f.filter().value, "Research");
    assert.equal(f.document.activeElement, f.filter()); assert.equal(f.$("dialog-submit").disabled, true);
    await f.clickText("검색 결과 전체"); await f.$("dialog-cancel").emit("click"); await f.open();
    assert.equal(f.count(), "0개 선택"); assert.equal(f.actions.length, 0);
  });

  test(`${source}: range shortcut explains its boundary and stays hidden when every match is already displayed`, async () => {
    const f = fixture(rows(205), { bookmarks }); await f.open();
    const shortcut = selectResults(f), scope = f.$("dialog-body").querySelector("#candidate-result-scope");
    assert.equal(shortcut.type, "button"); assert.equal(shortcut.getAttribute("aria-describedby"), scope.id);
    assert.equal(shortcut.hidden, false); assert.equal(scope.hidden, false);
    assert.match(scope.textContent, /205개 중 200개 표시/u); assert.match(scope.textContent, /기존 선택을 유지/u);
    await f.search("Research 204"); assert.equal(shortcut.hidden, true); assert.equal(scope.hidden, true);
    assert.equal(f.checks().length, 1);
    await f.search("no match"); assert.equal(shortcut.hidden, true); assert.equal(shortcut.disabled, true);
    assert.equal(f.actions.length, 0);
  });

  test(`${source}: all-result import is one real service write and one Undo restores links and destination folds`, async () => {
    const f = fixture(rows(405), { bookmarks }), original = structuredClone(f.run("state.catalog")), writes = [];
    const values = { [FAVMOA_STORAGE_KEY]: { catalog: original, revision: 7 } };
    const sender = { id: "range-test", url: "chrome-extension://range-test/sidepanel/sidepanel.html" };
    const service = createCatalogService({ runtimeId: sender.id, storage: {
      async setAccessLevel() {},
      async get(keys) { return structuredClone(Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]]))); },
      async set(next) { writes.push(structuredClone(next)); Object.assign(values, structuredClone(next)); }
    } });
    f.context.realDispatch = (action, expectedRevision) => service.handle({ type: "FAVMOA_ACTION", action: structuredClone(action), expectedRevision }, sender);
    f.context.realUndo = expectedRevision => service.handle({ type: "FAVMOA_UNDO", expectedRevision }, sender);
    f.run("platform.dispatch = realDispatch; platform.undo = realUndo");
    await f.open(); await f.clickText("전체 405개 선택"); await f.target("destination");
    assert.equal(writes.length, 0); assert.deepEqual(structuredClone(f.run("state.catalog")), original);
    await f.submit(); assert.equal(writes.length, 1); assert.equal(f.run("state.revision"), 8);
    assert.equal(f.run("linksOf(library()).length"), 406);
    assert.equal(f.run('library().groups.find(group => group.id === "parent").collapsed'), false);
    await f.$("undo").emit("click"); assert.equal(writes.length, 2);
    assert.deepEqual(structuredClone(f.run("state.catalog")), original);
  });
}
