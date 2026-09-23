import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { applyCatalogAction, createCatalog, flattenGroups, identifyUrl, MAX_GROUP_DEPTH, SYSTEM_GROUP_ID } from "../src/link-library.js";
import { createLinkSelection } from "../src/link-selection.js";
import { findSavedPage } from "../src/link-navigation.js";

// Run the shipped render/dialog/event handlers with the real selection and
// catalog modules. This synthetic DOM does not prove native layout, checkbox
// keyboard defaults, or Chrome storage; those require separate browser checks.
const source = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
const dataKey = value => value.replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
function matches(element, selector) {
  const base = selector.split("[")[0], attribute = selector.includes("[") ? selector.slice(selector.indexOf("[")) : "";
  if (base && base !== "*" && (base.startsWith(".") ? !element.classList.contains(base.slice(1))
    : base.startsWith("#") ? element.id !== base.slice(1) : element.tagName !== base.toUpperCase())) return false;
  if (!attribute) return true;
  const [, name, value] = attribute.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/u) || [];
  const actual = name?.startsWith("data-") ? element.dataset[dataKey(name.slice(5))]
    : name === "open" ? (element.open ? "" : undefined) : element.getAttribute(name);
  return actual !== undefined && actual !== null && (value === undefined || actual === value);
}
class Element {
  constructor(tag, documentRef) {
    this.tagName = tag.toUpperCase(); this.documentRef = documentRef;
    this.children = []; this.parentElement = null; this.dataset = {}; this.attributes = {};
    this.listeners = new Map(); this.className = ""; this.ownText = ""; this.rawValue = "";
    this.disabled = false; this.open = false; this.isConnected = true; this.replacements = 0;
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = {
      contains: name => this.className.split(/\s+/u).includes(name),
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/u).filter(Boolean));
        if (force ?? !names.has(name)) names.add(name); else names.delete(name);
        this.className = [...names].join(" ");
      },
      add: name => this.classList.toggle(name, true)
    };
  }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value); }
  get value() { return this.tagName === "SELECT" ? (this.selectedOptions[0]?.value || "") : this.rawValue; }
  set value(value) {
    this.rawValue = value;
    if (this.tagName === "SELECT") for (const item of this.children) item.selected = item.value === value;
  }
  get selectedOptions() { return this.children.filter(item => item.selected).slice(0, 1).length
    ? this.children.filter(item => item.selected).slice(0, 1) : this.children.slice(0, 1); }
  append(...children) {
    for (const child of children) {
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
      child.parentElement = this; child.isConnected = this.isConnected; this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) for (const item of [child, ...descendants(child)]) item.isConnected = false;
    this.children = []; this.ownText = ""; this.replacements += 1; this.append(...children);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name === "href" ? this.href : this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  async emit(name, values = {}) {
    const event = { button: 0, target: this, currentTarget: this, preventDefault() {}, ...values };
    await Promise.all((this.listeners.get(name) || []).map(callback => callback(event)));
  }
  querySelectorAll(selector) {
    const choices = selector.split(",").map(item => item.trim());
    return descendants(this).filter(element => choices.some(choice => {
      const parts = choice.split(/\s+/u); const leaf = parts.pop();
      if (!matches(element, leaf)) return false;
      let parent = element.parentElement;
      while (parts.length && parent) { if (matches(parent, parts.at(-1))) parts.pop(); parent = parent.parentElement; }
      return !parts.length;
    }));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let value = this; value; value = value.parentElement) if (matches(value, selector)) return value; return null; }
  contains(other) { return this === other || descendants(this).includes(other); }
  focus() { if (!this.disabled) this.documentRef.activeElement = this; }
  scrollIntoView() { this.scrolled = true; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const link = (id, title) => ({ id, title, url: `https://example.com/${id}`, icon: "", provider: "generic" });
const group = (id, links = [], groups = [], collapsed = false) => ({ id, name: id, links, groups, collapsed });
function fixture() {
  const elements = new Map(), actions = [], opened = [], sources = [];
  const document = {
    activeElement: null,
    createElement: tag => new Element(tag, document),
    querySelectorAll: selector => document.body.querySelectorAll(selector),
    addEventListener: (...args) => document.body.addEventListener(...args),
    getElementById(id) {
      if (!elements.has(id)) {
        const element = document.createElement(id === "dialog" ? "dialog" : id === "library-picker" ? "select" : "div");
        element.id = id; elements.set(id, element); document.body.append(element);
      }
      return elements.get(id);
    }
  };
  document.body = document.createElement("body");
  const $ = id => document.getElementById(id);
  $("dialog").append($("dialog-form"));
  $("dialog-form").append($("dialog-close"), $("dialog-body"), $("dialog-error"), $("dialog-cancel"), $("dialog-submit"));
  for (const id of ["dialog-close", "dialog-cancel", "dialog-submit", "select-mode", "move-selected"]) $(id).tagName = "BUTTON";
  $("select-visible").tagName = "INPUT"; $("select-visible").type = "checkbox";
  let catalog = createCatalog(), revision = 7, response = null;
  catalog.libraries[0].groups.push(group("work", [link("alpha", "Alpha"), link("beta", "Beta")], [group("nested", [link("hidden", "Hidden")], [], true)]), group("destination"));
  catalog.libraries.push({ id: "other-library", name: "Other library", groups: [group(SYSTEM_GROUP_ID, [link("other", "Other")])] });
  const context = vm.createContext({
    document, window: { addEventListener() {} }, identifyUrl, findSavedPage, createLinkSelection,
    flattenGroups, MAX_GROUP_DEPTH, SYSTEM_GROUP_ID,
    createInteractionGuard: () => ({ isActive: () => false }),
    createTreeDrag: () => ({ bindSource: (element, metadata) => sources.push({ element, metadata }), bindTarget() {}, reset() { sources.length = 0; }, isDragging: () => false }),
    createPlatform: () => ({
      mode: "demo", getCurrentPage: async () => null, getOpenTabs: async () => [],
      openLink: async (...args) => { opened.push(args); return { ok: true }; },
      dispatch: async (action, expectedRevision) => {
        actions.push({ action: structuredClone(action), expectedRevision });
        if (response) return response(action, expectedRevision);
        catalog = applyCatalogAction(catalog, structuredClone(action)); revision += 1;
        return { ok: true, catalog, revision, canUndo: true };
      }
    })
  });
  const boundary = source.indexOf("platform.subscribe(event =>");
  assert.ok(boundary > 0, "review fixture bootstrap boundary after script changes");
  vm.runInContext(source.slice(0, boundary).replace(/^import .+;\n/gmu, ""), context);
  context.initial = { revision, catalog };
  vm.runInContext('libraryId = "library-personal"; adopt(initial);', context);
  return {
    $, context, document, actions, opened, sources,
    run: code => vm.runInContext(code, context),
    selected: () => [...vm.runInContext("linkSelection.selected()", context)],
    rows: () => document.querySelectorAll("#tree .link-row"),
    row: id => document.querySelectorAll("#tree .link-row").find(item => item.dataset.linkId === id),
    enter: () => $("select-mode").emit("click"),
    async check(id) { const input = this.row(id).querySelector("input"); input.checked = !input.checked; await input.emit("change"); return input; },
    async search(value) { $("search").value = value; await $("search").emit("input"); },
    setResponse(value) { response = value; },
    submit: () => $("dialog-form").emit("submit"),
    async target(value) { const target = $("dialog-body").querySelector("select"); target.value = value; await target.emit("change"); }
  };
}

test("selection uses named native checkboxes without link navigation, row menus or drag sources", async () => {
  const f = fixture(); await f.enter();
  assert.equal(f.$("selection-bar").hidden, false);
  assert.equal(f.$("select-mode").getAttribute("aria-pressed"), "true");
  assert.equal(f.$("add-group").hidden, true); assert.equal(f.$("add-link").hidden, true);
  const row = f.row("alpha"), input = row.querySelector("input");
  assert.equal(input.type, "checkbox"); assert.equal(input.getAttribute("aria-label"), "Alpha 선택");
  assert.equal(input.dataset.focusKey, "select:library-personal:alpha");
  assert.equal(row.querySelector("label").contains(input), true);
  assert.equal(row.querySelector("a"), null); assert.equal(row.querySelector("details"), null);
  assert.equal(f.sources.length, 0, "selection mode must not start link or group drags");
  assert.equal(input.listeners.has("keydown"), false, "native Space behavior must not be replaced by link handlers");
  await f.check("alpha");
  assert.deepEqual(f.selected(), ["alpha"]); assert.equal(f.opened.length, 0);
});

test("changing a checkbox preserves its DOM node and focus while updating count and mixed state", async () => {
  const f = fixture(); await f.enter();
  const input = f.row("alpha").querySelector("input"); input.focus();
  const renders = f.$("tree").replacements;
  await f.check("alpha");
  assert.equal(f.row("alpha").querySelector("input"), input);
  assert.equal(f.document.activeElement, input); assert.equal(f.$("tree").replacements, renders);
  assert.equal(f.$("selection-count").textContent, "1개 선택");
  assert.equal(f.$("select-visible").indeterminate, true); assert.equal(f.$("move-selected").disabled, false);
  await f.check("alpha"); assert.equal(f.$("move-selected").disabled, true);
});

test("ordinary mode retains single click navigation and drag/menu access after selection ends", async () => {
  const f = fixture(); await f.enter(); await f.check("alpha"); await f.enter();
  const row = f.row("alpha"); assert.ok(row.querySelector("details"));
  assert.ok(f.sources.some(item => item.element === row && item.metadata.kind === "link"));
  await row.querySelector("a").emit("click");
  assert.equal(f.opened.length, 1); assert.equal(f.opened[0][0], "https://example.com/alpha");
  assert.equal(f.$("selection-bar").hidden, true); assert.deepEqual(f.selected(), []);
});

test("visible select-all excludes collapsed children and preserves selected links outside a search", async () => {
  const f = fixture(); await f.enter(); await f.$("select-visible").emit("change");
  assert.deepEqual(f.selected(), ["alpha", "beta"]);
  assert.equal(f.$("select-visible").checked, true);
  await f.search("Hidden");
  assert.deepEqual(f.rows().map(row => row.dataset.linkId), ["hidden"]);
  assert.equal(f.$("selection-count").textContent, "2개 선택 · 화면 밖 2개 포함");
  await f.$("select-visible").emit("change");
  assert.deepEqual(f.selected(), ["alpha", "beta", "hidden"]);
  await f.$("select-visible").emit("change"); assert.deepEqual(f.selected(), ["alpha", "beta"]);
  await f.search("No matching result");
  assert.equal(f.$("select-visible").disabled, true); assert.equal(f.$("move-selected").disabled, false);
  assert.equal(f.$("selection-count").textContent, "2개 선택 · 화면 밖 2개 포함");
});

test("library switch ends selection rather than transferring selected IDs to another library", async () => {
  const f = fixture(); await f.enter(); await f.check("alpha");
  f.$("library-picker").value = "other-library"; await f.$("library-picker").emit("change");
  assert.deepEqual(f.selected(), []); assert.equal(f.$("selection-bar").hidden, true);
  assert.ok(f.row("other").querySelector("a"));
});

test("catalog reconciliation removes deleted IDs without discarding remaining valid selections", async () => {
  const f = fixture(); await f.enter(); await f.$("select-visible").emit("change");
  f.run('state.catalog.libraries[0].groups.find(group => group.id === "work").links.shift(); render();');
  assert.deepEqual(f.selected(), ["beta"]); assert.equal(f.$("selection-count").textContent, "1개 선택");
  assert.equal(f.$("selection-bar").hidden, false);
});

test("bulk move commits one atomic action with captured selection, library and revision", async () => {
  const f = fixture(); await f.enter(); await f.$("select-visible").emit("change"); await f.search("No matching result");
  await f.$("move-selected").emit("click");
  assert.match(f.$("dialog-body").textContent, /화면 밖에 있는 2개도 포함/u);
  await f.target("destination"); await f.submit();
  assert.equal(f.$("dialog-error").textContent, "");
  assert.equal(f.actions.length, 1);
  assert.deepEqual(f.actions[0], { expectedRevision: 7, action: { type: "moveLinks", libraryId: "library-personal", linkIds: ["alpha", "beta"], targetGroupId: "destination" } });
  assert.deepEqual([...f.run('library().groups.find(group => group.id === "destination").links.map(link => link.id)')], ["alpha", "beta"]);
  assert.equal(f.$("dialog").open, false); assert.equal(f.$("selection-bar").hidden, true);
  assert.equal(f.$("search").value, ""); assert.deepEqual(f.selected(), []);
  assert.equal(f.document.activeElement.dataset.focusKey, "g:library-personal:destination");
  assert.equal(f.$("undo").disabled, false);
});

test("same-group destination disables submission and does not produce a no-op mutation", async () => {
  const f = fixture(); await f.enter(); await f.check("alpha"); await f.$("move-selected").emit("click");
  await f.target("work"); assert.equal(f.$("dialog-submit").disabled, true);
  assert.match(f.$("dialog-body").textContent, /모두 이 그룹/u);
  await f.submit(); assert.equal(f.actions.length, 0); assert.equal(f.$("dialog").open, true);
  assert.deepEqual(f.selected(), ["alpha"]);
  await f.target("destination"); assert.equal(f.$("dialog-submit").disabled, false);
});

test("a cancelled no-op destination does not leave the next dialog submit disabled", async () => {
  const f = fixture(); await f.enter(); await f.check("alpha"); await f.$("move-selected").emit("click");
  await f.target("work"); assert.equal(f.$("dialog-submit").disabled, true);
  await f.$("dialog-cancel").emit("click");
  f.run('nameDialog("그룹 만들기", { type: "addGroup" });');
  assert.equal(f.$("dialog-submit").disabled, false);
  assert.equal(f.$("dialog-title").textContent, "그룹 만들기");
});

test("cancelling bulk move preserves selected links and their search context without storage writes", async () => {
  const f = fixture(); await f.enter(); await f.check("alpha"); await f.search("Beta");
  f.$("move-selected").focus(); await f.$("move-selected").emit("click");
  await f.$("dialog-cancel").emit("click");
  assert.equal(f.$("dialog").open, false); assert.equal(f.actions.length, 0);
  assert.deepEqual(f.selected(), ["alpha"]); assert.equal(f.$("search").value, "Beta");
  assert.equal(f.document.activeElement, f.$("move-selected"));
});

test("failed bulk move keeps selection and destination for retry instead of reporting success", async () => {
  const f = fixture(); await f.enter(); await f.check("alpha"); await f.$("move-selected").emit("click");
  await f.target("destination"); f.setResponse(() => ({ ok: false, error: "저장 실패" }));
  await f.submit();
  assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-error").textContent, "저장 실패");
  assert.deepEqual(f.selected(), ["alpha"]); assert.equal(f.$("dialog-body").querySelector("select").value, "destination");
  assert.equal(f.$("selection-bar").hidden, false); assert.equal(f.$("dialog-submit").disabled, false);
  f.setResponse(null); await f.submit(); assert.equal(f.$("dialog-error").textContent, ""); assert.equal(f.$("dialog").open, false); assert.deepEqual(f.selected(), []);
});

test("revision conflict adopts the latest catalog, prunes deleted selections and does not report partial success", async () => {
  const f = fixture(); await f.enter(); await f.$("select-visible").emit("change");
  await f.search("Beta"); await f.$("move-selected").emit("click"); await f.target("destination");
  const latestCatalog = structuredClone(f.run("state.catalog"));
  const latestWork = latestCatalog.libraries[0].groups.find(group => group.id === "work");
  latestWork.links = latestWork.links.filter(link => link.id !== "alpha");
  f.setResponse(() => ({
    ok: false, conflict: true, error: "다른 화면에서 목록이 변경되었습니다.",
    revision: 8, catalog: latestCatalog, canUndo: true
  }));
  await f.submit();
  assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0].expectedRevision, 7, "the dialog must not silently retry with the latest revision");
  assert.deepEqual(f.actions[0].action.linkIds, ["alpha", "beta"]);
  assert.equal(f.actions[0].action.libraryId, "library-personal");
  assert.equal(f.run("state.revision"), 8);
  assert.deepEqual(f.selected(), ["beta"], "keep surviving selection while removing only the deleted ID");
  assert.equal(f.$("selection-count").textContent, "1개 선택");
  assert.equal(f.$("selection-bar").hidden, false);
  assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, false);
  assert.equal(f.$("dialog-error").textContent, "다른 화면에서 목록이 변경되었습니다.");
  assert.equal(f.$("search").value, "Beta", "the success-only clear-search path must not run on conflict");
  assert.equal(f.$("dialog-body").querySelector("select").value, "destination");
  assert.deepEqual([...f.run('library().groups.find(group => group.id === "work").links.map(link => link.id)')], ["beta"]);
  assert.deepEqual([...f.run('library().groups.find(group => group.id === "destination").links')], []);
  assert.doesNotMatch(f.$("status").textContent, /이동했습니다/u);
});

test("pending move cannot be submitted twice or cancelled before its one save completes", async () => {
  const f = fixture(); await f.enter(); await f.check("alpha"); await f.$("move-selected").emit("click"); await f.target("destination");
  let finish; f.setResponse(() => new Promise(resolve => { finish = resolve; }));
  const saving = f.submit(); await f.submit(); await f.$("dialog-cancel").emit("click");
  assert.equal(f.actions.length, 1); assert.equal(f.$("dialog").open, true);
  assert.equal(f.$("dialog-body").querySelector("select").disabled, true);
  finish({ ok: false, error: "취소 없이 저장 실패" }); await saving;
  assert.deepEqual(f.selected(), ["alpha"]); assert.equal(f.$("dialog-submit").disabled, false);
});

test("Escape clears an active search first and only then exits selection", async () => {
  const f = fixture(); await f.enter(); await f.check("alpha"); await f.search("Alpha");
  f.$("search").tagName = "INPUT"; f.$("search").focus();
  await f.document.body.emit("keydown", { key: "Escape" });
  assert.equal(f.$("search").value, ""); assert.deepEqual(f.selected(), ["alpha"]);
  await f.document.body.emit("keydown", { key: "Escape" });
  assert.deepEqual(f.selected(), []); assert.equal(f.$("selection-bar").hidden, true);
  assert.equal(f.document.activeElement, f.$("select-mode"));
});
