import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createCatalog, validateCatalog, flattenGroups } from "../src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_RESTORE_POINT_KEY } from "../src/favmoa-service.js";
import { fixture as sidepanelFixture } from "../test-support/candidate-picker-fixture.mjs";

const source = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../sidepanel/sidepanel.html", import.meta.url), "utf8");

// Run the shipped functions without booting a browser, extension or real store.
// Boundaries are top-level declarations, so these tests never duplicate their logic.
function functionSource(name) {
  const declarations = [...source.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gmu)];
  const index = declarations.findIndex(match => match[1] === name);
  assert.ok(index >= 0, `Missing sidepanel function: ${name}`);
  return source.slice(declarations[index].index, declarations[index + 1]?.index ?? source.length);
}

function catalog(name) {
  const value = createCatalog();
  value.libraries[0].name = name;
  return value;
}

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.textContent = ""; this.value = ""; this.open = false; this.attributes = {}; this.dataset = {}; }
  append(...children) { this.children.push(...children); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
}

function textOf(element) { return [element.textContent, ...element.children.map(textOf)].join(" "); }

function dialogFixture({ hasRestorePoint = false } = {}) {
  const elements = [], actions = [], messages = [];
  const current = catalog("현재 목록");
  const stored = { [FAVMOA_STORAGE_KEY]: { revision: 8, catalog: current } };
  if (hasRestorePoint) stored[FAVMOA_RESTORE_POINT_KEY] = { catalog: catalog("이전 안전 사본") };
  const service = createCatalogService({
    runtimeId: "contract-test",
    storage: {
      setAccessLevel: async () => undefined,
      get: async keys => Object.fromEntries(keys.filter(key => key in stored).map(key => [key, structuredClone(stored[key])])),
      set: async values => Object.assign(stored, structuredClone(values))
    }
  });
  const context = vm.createContext({
    state: { ok: true, revision: 8, catalog: current, canUndo: false, hasRestorePoint },
    libraryId: "library-personal", validateCatalog, flattenGroups,
    document: { createElement(tag) { const element = new Element(tag); elements.push(element); return element; } },
    render() {}, exportBackup() {}, announce: message => messages.push(message),
    $: () => ({ textContent: "" }),
    showDialog(title, submitText, populate, submit) {
      context.dialog = { title, submitText, body: new Element("body"), submit };
      populate(context.dialog.body);
    },
    destinationFields() {
      const group = new Element("select");
      group.value = current.libraries[0].groups[0].id;
      group.selectedOptions = [{ textContent: "미분류 그룹" }];
      return { group };
    },
    dispatch(action, revision, message) { actions.push({ action: structuredClone(action), revision, message }); return true; },
    platform: {
      importBackup: (value, revision) => service.handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: value, expectedRevision: revision }, {
        id: "contract-test", url: "chrome-extension://contract-test/sidepanel/sidepanel.html"
      })
    }
  });
  vm.runInContext(["node", "button", "field", "library", "linksOf", "allLinkCount", "adopt", "requireResult", "backupPayload", "restoreDialog"].map(functionSource).join("\n"), context);
  return { context, elements, actions, messages, stored };
}

test("late mutation responses cannot replace newer rendered state or exported backup data", () => {
  const current = { ok: true, revision: 8, catalog: catalog("최신 목록"), canUndo: true, hasRestorePoint: true };
  let renders = 0;
  const context = vm.createContext({ state: current, libraryId: "library-personal", render: () => { renders += 1; } });
  vm.runInContext(["library", "adopt", "backupPayload"].map(functionSource).join("\n"), context);
  context.adopt({ ok: true, revision: 7, catalog: catalog("늦게 도착한 목록"), canUndo: false, hasRestorePoint: false });
  assert.equal(context.state, current);
  assert.equal(context.state.revision, 8);
  assert.equal(context.state.hasRestorePoint, true);
  assert.equal(context.state.canUndo, true);
  assert.equal(context.backupPayload().catalog, current.catalog);
  assert.equal(renders, 0);
});

test("initial, equal and newer revisions still refresh valid state and recovery controls", () => {
  const context = vm.createContext({ state: null, libraryId: "", render() {} });
  vm.runInContext(["library", "adopt"].map(functionSource).join("\n"), context);
  context.adopt({ revision: 0, catalog: catalog("처음"), canUndo: false, hasRestorePoint: false });
  assert.equal(context.libraryId, "library-personal");
  context.adopt({ revision: 1, catalog: catalog("최신"), canUndo: true, hasRestorePoint: true });
  assert.equal(context.state.revision, 1);
  assert.equal(context.state.hasRestorePoint, true);
  context.adopt({ revision: 1, catalog: catalog("최신"), canUndo: false, hasRestorePoint: false });
  assert.equal(context.state.canUndo, false);
  assert.equal(context.state.hasRestorePoint, false);
});

test("importing an identical backup announces no change and preserves existing checkpoint availability", async () => {
  for (const hasRestorePoint of [false, true]) {
    const { context, messages, stored } = dialogFixture({ hasRestorePoint });
    const before = structuredClone(stored);
    context.restoreDialog(context.state.catalog, "same.json");
    if (hasRestorePoint) assert.match(textOf(context.dialog.body), /같은 목록이면 기존 사본을 유지/u);
    assert.equal(await context.dialog.submit(), true);
    assert.match(messages.at(-1), /현재 목록과 같아 변경하지 않았습니다/u);
    assert.doesNotMatch(messages.at(-1), /목록을 바꿨습니다/u);
    assert.equal(context.state.hasRestorePoint, hasRestorePoint);
    assert.deepEqual(stored, before);
  }
});

test("a changed backup updates the UI and exposes the created restore checkpoint", async () => {
  const { context, messages } = dialogFixture();
  context.restoreDialog(catalog("가져올 목록"), "changed.json");
  assert.match(textOf(context.dialog.body), /현재 목록/u);
  assert.match(textOf(context.dialog.body), /가져올 목록/u);
  await context.dialog.submit();
  assert.equal(context.state.catalog.libraries[0].name, "가져올 목록");
  assert.equal(context.state.revision, 9);
  assert.equal(context.state.hasRestorePoint, true);
  assert.match(messages.at(-1), /복원 전 목록 복구/u);
});

test("manual entry accepts a bare domain, optional title and chosen destination through the shipped dialog", async () => {
  const f = sidepanelFixture();
  f.run("linkDialog()");
  const [url, title] = f.$("dialog-body").querySelectorAll("input");
  assert.equal(url.type, "text");
  assert.equal(url.required, true);
  assert.equal(url.inputMode, "url");
  assert.equal(title.required, false);
  assert.equal(f.$("dialog-body").querySelector("details").open, false);
  url.value = " example.com/docs "; title.value = "";
  await f.submit();
  assert.equal(f.$("dialog").open, false);
  assert.equal(f.actions.length, 1);
  assert.deepEqual(f.actions[0].action, {
    type: "addLink", libraryId: "library-personal",
    groupId: f.run("state.catalog.libraries[0].groups[0].id"),
    link: { title: "example.com", url: "https://example.com/docs" }
  });
  assert.equal(f.actions[0].expectedRevision, 7);
  const saved = f.run("linksOf(library()).find(link => link.url === 'https://example.com/docs')");
  assert.equal(saved.title, "example.com");
});

test("editing uses the same URL preparation while unsafe input never dispatches", async () => {
  const f = sidepanelFixture();
  f.run("linkDialog(linksOf(library()).find(link => link.id === 'saved'))");
  const [url, title] = f.$("dialog-body").querySelectorAll("input");
  url.value = "javascript:alert(1)";
  await f.submit();
  assert.match(f.$("dialog-error").textContent, /웹 주소/u);
  assert.equal(f.$("dialog").open, true);
  assert.equal(f.actions.length, 0);
  url.value = "example.com/new"; title.value = "";
  await f.submit();
  assert.deepEqual(f.actions[0].action, { type: "updateLink", libraryId: "library-personal", linkId: "saved", title: "example.com", url: "https://example.com/new" });
  assert.match(f.$("status").textContent, /수정했습니다/u);
  assert.equal(f.$("dialog").open, false);
  assert.equal(f.run("linksOf(library()).find(link => link.id === 'saved').url"), "https://example.com/new");
});

test("every literal sidepanel control reference resolves to one HTML element", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML IDs must be unique");
  const references = [...source.matchAll(/\$\("([^"]+)"\)/gu)].map(match => match[1]);
  assert.deepEqual([...new Set(references.filter(id => !ids.includes(id)))], []);
});
