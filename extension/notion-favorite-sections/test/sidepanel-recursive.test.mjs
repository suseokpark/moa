import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { flattenGroups, identifyUrl } from "../src/link-library.js";
import { fixture as dialogFixture } from "../test-support/candidate-picker-fixture.mjs";

const source = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../sidepanel/sidepanel.html", import.meta.url), "utf8");
function shipped(name) {
  const functions = [...source.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gmu)];
  const index = functions.findIndex(match => match[1] === name);
  assert.ok(index >= 0, `Missing shipped function ${name}`);
  return source.slice(functions[index].index, functions[index + 1]?.index ?? source.length);
}
const link = (id, title) => ({ id, title, url: `https://example.com/${id}`, icon: "", provider: "generic" });
const group = (id, name, groups = [], links = []) => ({ id, name, groups, links, collapsed: true });
function fixture() {
  return { id: "library-test", name: "내 링크", groups: [
    group("work", "업무", [group("project", "프로젝트", [group("reference", "참고 자료", [], [link("deep", "경쟁사 문서")])], [link("spec", "기획 문서")])], [link("weekly", "주간회의")]),
    group("personal", "개인", [], [link("book", "읽을 책")])
  ] };
}
function projectionContext(pageKey = "") {
  const context = vm.createContext({ identifyUrl, flattenGroups, pageKey, suppressedFolds: new Set(), urlKeys: new Map() });
  vm.runInContext(["safeKey", "projectGroup", "linksOf", "isExpanded"].map(shipped).join("\n"), context);
  return context;
}

test("recursive search keeps the ancestor path but counts matching links only once", () => {
  const context = projectionContext();
  const lib = fixture();
  const before = structuredClone(lib);
  const view = context.projectGroup(lib.groups[0], "경쟁사");
  assert.equal(view.group.id, "work");
  assert.equal(view.count, 1);
  assert.equal(view.links.length, 0);
  assert.equal(view.children[0].group.id, "project");
  assert.equal(view.children[0].links.length, 0);
  assert.equal(view.children[0].children[0].links[0].id, "deep");
  assert.equal(context.projectGroup(lib.groups[1], "경쟁사"), null);
  assert.equal(context.linksOf(lib).length, 4);
  assert.deepEqual(lib, before, "search must not rewrite stored collapse state or data");
});

test("matching a group name includes that full subtree without unrelated parent links", () => {
  const context = projectionContext();
  const view = context.projectGroup(fixture().groups[0], "프로젝트");
  assert.equal(view.count, 2);
  assert.equal(view.links.length, 0);
  assert.equal(view.children[0].links[0].id, "spec");
  assert.equal(view.children[0].children[0].links[0].id, "deep");
});

test("current-page ancestry expands at every level unless explicitly collapsed by the user", () => {
  const context = projectionContext("https://example.com/deep");
  const lib = fixture();
  const view = context.projectGroup(lib.groups[0], "");
  for (const item of [view, view.children[0], view.children[0].children[0]]) {
    const key = `g:${lib.id}:${item.group.id}`;
    assert.equal(item.hasCurrent, true);
    assert.equal(context.isExpanded(key, item.group, item.hasCurrent), true);
    context.suppressedFolds.add(key);
    assert.equal(context.isExpanded(key, item.group, item.hasCurrent), false);
  }
  assert.equal(context.projectGroup(lib.groups[1], "").hasCurrent, false);
});

test("group move targets omit both the source and all descendants", () => {
  const f = dialogFixture(); f.run('moveGroupDialog(library().groups[1])');
  const targets = f.$("dialog-body").querySelector("select").children;
  assert.ok(targets.some(item => item.value === ""));
  assert.ok(targets.some(item => item.value === f.run("SYSTEM_GROUP_ID")));
  assert.ok(targets.every(item => !["parent", "destination"].includes(item.value)));
});

test("saved-page reveal opens the complete path, preserves unrelated folds, and focuses the link", () => {
  const lib = fixture();
  const path = [lib.groups[0], lib.groups[0].groups[0], lib.groups[0].groups[0].groups[0]];
  const search = { value: "다른 검색" };
  const calls = [];
  const context = vm.createContext({
    libraryId: "another-library", state: { catalog: { libraries: [lib] } }, currentPage: { url: "https://example.com/deep" },
    suppressedFolds: new Set([...path.map(item => `g:${lib.id}:${item.id}`), `g:${lib.id}:personal`]),
    $: () => search, findSavedPage: () => ({ library: lib, group: path.at(-1), path, link: link("deep", "경쟁사 문서") }),
    render: () => calls.push("render"), announce: message => calls.push(message),
    runAfterTreeRender: effect => effect(),
    document: { querySelectorAll: () => [{ dataset: { linkId: "deep" }, querySelector: () => ({ focus: () => calls.push("focus") }), scrollIntoView: () => calls.push("scroll") }] }
  });
  vm.runInContext(shipped("revealCurrentPage"), context);
  context.revealCurrentPage();
  assert.equal(context.libraryId, lib.id);
  assert.equal(search.value, "");
  assert.deepEqual([...context.suppressedFolds], [`g:${lib.id}:personal`]);
  assert.deepEqual(calls.slice(0, 3), ["render", "focus", "scroll"]);
});

test("new sidepanel controls and payloads no longer depend on a section layer", () => {
  assert.doesNotMatch(source, /\b(?:sectionId|targetSectionId|getSystemSectionId|moveSectionDialog)\b/u);
  assert.doesNotMatch(html, /섹션/u);
  assert.match(source, /parentGroupId:\s*group\.id/u);
  // Actual root/group payloads are covered by the move-dialog behavioral tests.
  assert.match(source, /targetParentGroupId:/u);
  assert.match(source, /menu\(`\$\{group\.name\}에 추가`, addActions, "plus",/u);
  assert.match(source, /그룹만 제거/u);
});

test("search-result disclosure is read-only and cannot silently mutate saved folds", () => {
  const item = group("work", "업무");
  let toggles = 0;
  const context = vm.createContext({
    button(_text, click) { return { click, dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, append() {} }; },
    node: () => ({ setAttribute() {} }), uiIcon: () => ({}), isExpanded: () => false,
    toggleFold: () => { toggles += 1; }
  });
  vm.runInContext(shipped("foldedHeader"), context);
  const searching = context.foldedHeader("업무", 1, "work", item, false, true, { type: "toggleGroup" });
  assert.equal(searching.expanded, true);
  assert.equal(searching.control.disabled, true);
  searching.control.click();
  assert.equal(toggles, 0);
  const browsing = context.foldedHeader("업무", 1, "work", item, false, false, { type: "toggleGroup" });
  assert.equal(browsing.control.disabled, false);
  browsing.control.click();
  assert.equal(toggles, 1);
});

test("dialog focus resolves a rerendered menu, then a surviving ancestor, then the toolbar", () => {
  const focused = [];
  const origin = { isConnected: false, focus: () => focused.push("old") };
  const menu = { dataset: { focusKey: "menu:lib:child" }, focus: () => focused.push("new-menu") };
  const parent = { dataset: { focusKey: "g:lib:parent" }, focus: () => focused.push("parent") };
  let controls = [parent, menu];
  const context = vm.createContext({
    dialogOrigin: origin, dialogReturnKeys: ["menu:lib:child", "g:lib:child", "g:lib:parent"],
    document: { querySelectorAll: () => controls }, $: () => ({ focus: () => focused.push("toolbar") })
  });
  vm.runInContext(shipped("restoreDialogFocus"), context);
  context.restoreDialogFocus();
  controls = [parent]; context.restoreDialogFocus();
  parent.disabled = true; context.restoreDialogFocus();
  controls = []; context.restoreDialogFocus();
  origin.isConnected = true; context.restoreDialogFocus();
  origin.disabled = true; context.restoreDialogFocus();
  assert.deepEqual(focused, ["new-menu", "parent", "toolbar", "toolbar", "old", "toolbar"]);
});

test("nonmodal tree rerenders preserve a keyed control without stealing dialog focus", () => {
  let focused = 0;
  const dialog = { open: false };
  const control = { dataset: { focusKey: "menu:lib:group" }, focus: () => { focused += 1; } };
  const context = vm.createContext({ document: { querySelectorAll: () => [control] }, $: () => dialog });
  vm.runInContext(shipped("restoreRenderedFocus"), context);
  context.restoreRenderedFocus("menu:lib:group");
  assert.equal(focused, 1);
  dialog.open = true; context.restoreRenderedFocus("menu:lib:group");
  dialog.open = false; control.disabled = true; context.restoreRenderedFocus("menu:lib:group");
  context.restoreRenderedFocus(null);
  assert.equal(focused, 1);
  assert.match(shipped("render"), /const focusKey = !\$\("dialog"\)\.open/u);
  assert.match(shipped("render"), /restoreRenderedFocus\(focusKey\)/u);
});
