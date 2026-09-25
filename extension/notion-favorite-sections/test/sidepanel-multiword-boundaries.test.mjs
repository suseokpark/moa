import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../test-support/candidate-picker-fixture.mjs";

// Real shipped search/render/selection handlers with synthetic catalog and DOM.
// These checks do not establish native browser layout, keyboard or storage behavior.
const link = (id, title, url = `https://example.org/${id}`) => ({ id, title, url, icon: "", provider: "generic" });
const group = (id, name, links = [], groups = [], collapsed = true) => ({ id, name, links, groups, collapsed });
function setup(groups) {
  const f = fixture();
  f.context.testGroups = groups;
  f.run("state.catalog.libraries[0].groups = testGroups; render();");
  return f;
}
async function search(f, value) {
  f.$("search").value = value;
  await f.$("search").emit("input");
}
const rows = f => f.$("tree").querySelectorAll("[data-link-id]");
const ids = f => rows(f).map(row => row.dataset.linkId);
const groupIds = f => f.$("tree").querySelectorAll("[data-group-id]").map(row => row.dataset.groupId);

test("all search terms must belong to the same link and cannot accumulate across its neighbors", async () => {
  const f = setup([group("root", "Reference", [link("alpha", "Alpine"), link("beta", "Sunset"), link("both", "Sunset Alpine")])]);
  await search(f, "alpine sunset");
  assert.deepEqual(ids(f), ["both"]);
  assert.equal(f.$("link-count").textContent, "검색 결과 1개 / 전체 3개");
});

test("matching one group never removes a required term from a sibling branch", async () => {
  const f = setup([group("root", "Reference", [], [
    group("alpine", "Alpine", [link("one", "Map")]),
    group("sunset", "Sunset", [link("two", "Map")])
  ])]);
  await search(f, "alpine sunset");
  assert.deepEqual(ids(f), []);
  assert.deepEqual(groupIds(f), []);
  assert.match(f.$("tree").textContent, /일치하는 링크가 없어요/u);
});

test("cousin branches keep independent group-path matches", async () => {
  const f = setup([group("root", "Archive", [], [
    group("west", "Alpine", [], [group("west-child", "Notes", [link("one", "Map")])]),
    group("east", "Notes", [], [group("east-child", "Sunset", [link("two", "Map")])]),
    group("full", "Alpine", [], [group("full-child", "Sunset", [link("both", "Map")])])
  ])]);
  await search(f, "sunset alpine");
  assert.deepEqual(ids(f), ["both"]);
  assert.deepEqual(groupIds(f), ["root", "full", "full-child"]);
});

test("terms satisfied along a group path include its subtree but not unrelated ancestor links", async () => {
  const f = setup([group("root", "Alpine", [link("outside", "Map")], [
    group("child", "Sunset", [link("inside", "Guide")], [group("deep", "Later", [link("deep-link", "Checklist")])]),
    group("sibling", "Archive", [link("sibling-link", "Map")])
  ])]);
  await search(f, "sunset alpine");
  assert.deepEqual(ids(f), ["inside", "deep-link"]);
  assert.deepEqual(groupIds(f), ["root", "child", "deep"]);
  assert.equal(f.$("link-count").textContent, "검색 결과 2개 / 전체 4개");
});

test("literal regex characters are searched as text, not operators", async () => {
  const f = setup([group("root", "Reference", [
    link("literal", "[x] a+b .*"), link("regex-shaped", "x aaab anything"), link("partial", "[x] a+b")
  ])]);
  await search(f, ".* [x] a+b");
  assert.deepEqual(ids(f), ["literal"]);
});

test("a vertical bar remains a required literal term rather than an OR operator", async () => {
  const f = setup([group("root", "Reference", [
    link("literal", "Alpine | Sunset"), link("words", "Alpine Sunset"), link("one", "Alpine")
  ])]);
  await search(f, "alpine | sunset");
  assert.deepEqual(ids(f), ["literal"]);
});

test("encoded URL text is not decoded before matching", async () => {
  const f = setup([group("root", "Reference", [link("encoded", "Guide", "https://example.org/path%2Fsunset")])]);
  await search(f, "guide /sunset");
  assert.deepEqual(ids(f), []);
  await search(f, "guide %2FSUNSET");
  assert.deepEqual(ids(f), ["encoded"]);
});

test("an empty group matching the whole path remains visible with zero links", async () => {
  const f = setup([group("root", "Alpine", [], [group("empty", "Sunset")])]);
  await search(f, "sunset alpine");
  assert.deepEqual(groupIds(f), ["root", "empty"]);
  assert.deepEqual(ids(f), []);
  assert.equal(f.$("link-count").textContent, "검색 결과 0개 / 전체 0개");
  assert.match(f.$("tree").textContent, /링크나 하위 그룹을 추가해 보세요/u);
  assert.doesNotMatch(f.$("tree").textContent, /일치하는 링크가 없어요/u);
});

test("selection across multiword searches preserves hidden selections without opening links", async () => {
  const f = setup([group("root", "Reference", [
    link("first", "Alpine Sunrise"), link("second", "Sunset Alpine"), link("other", "City Walk")
  ], [], false)]);
  await f.$("select-mode").emit("click");
  const first = rows(f).find(row => row.dataset.linkId === "first").querySelector("input");
  first.checked = true; await first.emit("change");
  await search(f, "alpine sunset");
  assert.deepEqual(ids(f), ["second"]);
  assert.equal(f.$("selection-count").textContent, "1개 선택 · 화면 밖 1개 포함");
  await f.$("select-visible").emit("change");
  assert.equal(f.$("selection-count").textContent, "2개 선택 · 화면 밖 1개 포함");
  assert.equal(rows(f)[0].querySelector("input").checked, true);
  assert.equal(f.$("select-visible").checked, true);
  await search(f, "no missing result");
  assert.equal(f.$("selection-count").textContent, "2개 선택 · 화면 밖 2개 포함");
  assert.equal(f.$("select-visible").disabled, true);
  await search(f, "");
  assert.deepEqual(rows(f).filter(row => row.querySelector("input").checked).map(row => row.dataset.linkId), ["first", "second"]);
  assert.equal(f.opened.length, 0);
  assert.equal(f.actions.length, 0);
});

test("clearing a multiword query restores stored folding without data or Undo changes", async () => {
  const f = setup([group("root", "Alpine", [], [group("child", "Sunset", [link("match", "Guide")])])]);
  f.run("state.canUndo = true; render();");
  const before = f.run("JSON.stringify(state)");
  await search(f, "sunset alpine");
  assert.deepEqual(ids(f), ["match"]);
  for (const fold of f.$("tree").querySelectorAll(".fold")) assert.equal(fold.disabled, true);
  await search(f, " \t\n ");
  assert.deepEqual(ids(f), []);
  assert.deepEqual(groupIds(f), ["root"]);
  const fold = f.$("tree").querySelector(".fold");
  assert.equal(fold.disabled, false);
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  assert.equal(f.$("clear-search").hidden, true);
  assert.equal(f.$("undo").disabled, false);
  assert.equal(f.run("JSON.stringify(state)"), before);
  assert.equal(f.actions.length, 0);
});

test("a currently open but nonmatching link does not leak into multiword results", async () => {
  const f = setup([group("root", "Reference", [
    link("current", "Alpine Notes"), link("match", "Alpine Sunset")
  ])]);
  f.run('pageKey = "https://example.org/current"; render();');
  assert.deepEqual(ids(f), ["current", "match"]);
  await search(f, "sunset alpine");
  assert.deepEqual(ids(f), ["match"]);
  assert.equal(f.$("tree").querySelector(".current"), null);
  assert.equal(f.$("link-count").textContent, "검색 결과 1개 / 전체 2개");
  await search(f, "");
  assert.deepEqual(ids(f), ["current", "match"]);
  assert.equal(f.$("tree").querySelector(".current").dataset.linkId, "current");
  assert.equal(f.actions.length, 0);
});

test("tab candidate filtering now shares the main tree's order-independent search contract", async () => {
  const f = fixture([{ title: "Alpine Sunset", url: "https://example.org/guide" }]);
  await f.open();
  await f.search("sunset alpine");
  assert.equal(f.checks().length, 1);
  await f.search("alpine sunset");
  assert.equal(f.checks().length, 1);
  assert.equal(f.checks()[0].getAttribute("aria-label"), "Alpine Sunset 선택");
  assert.equal(f.actions.length, 0);
});
