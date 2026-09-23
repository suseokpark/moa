import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { applyCatalogAction, createCatalog, flattenGroups, identifyUrl, MAX_GROUP_DEPTH, SYSTEM_GROUP_ID } from "../src/link-library.js";
import { createLinkSelection } from "../src/link-selection.js";
import { findSavedPage } from "../src/link-navigation.js";
import * as candidatePreparation from "../src/open-tab-candidates.js";

// Exercise the shipped modal handlers and real candidate/reducer modules. This
// small synthetic DOM does not stand in for native layout or Chrome API checks.
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
    this.disabled = false; this.open = false; this.isConnected = true;
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = {
      contains: name => this.className.split(/\s+/u).includes(name),
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/u).filter(Boolean));
        if (force ?? !names.has(name)) names.add(name); else names.delete(name);
        this.className = [...names].join(" ");
      }, add: name => this.classList.toggle(name, true)
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
    this.children = []; this.ownText = ""; this.append(...children);
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
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
export const tab = (title, url = `https://example.org/${title.toLowerCase()}`) => ({ title, url });
export const defaults = [tab("Alpha"), tab("Beta"), tab("Gamma")];
export function fixture(tabs = defaults, { bookmarks = false } = {}) {
  const elements = new Map(), actions = [], opened = [];
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
  for (const id of ["dialog-close", "dialog-cancel", "dialog-submit", "save-tabs", "select-mode", "move-selected"]) $(id).tagName = "BUTTON";
  $("select-visible").tagName = "INPUT"; $("select-visible").type = "checkbox";
  let catalog = createCatalog(), revision = 7, response = null, fetches = 0, interactionActive = false;
  let candidateResponse = async () => ({ ok: true, ...(bookmarks ? { candidates: tabs } : { tabs }), excludedCount: 0 });
  catalog.libraries[0].groups[0].links.push({ id: "saved", title: "Saved", url: "https://example.com/saved", icon: "", provider: "generic" });
  catalog.libraries[0].groups.push({ id: "parent", name: "Parent", links: [], collapsed: true, groups: [
    { id: "destination", name: "Destination", links: [], groups: [], collapsed: true }
  ] });
  catalog.libraries.push({ id: "other-library", name: "Other library", groups: [{ id: SYSTEM_GROUP_ID, name: "Other group", links: [], groups: [], collapsed: false }] });
  const context = vm.createContext({
    document, window: { addEventListener() {} }, identifyUrl, findSavedPage, createLinkSelection, ...candidatePreparation,
    flattenGroups, MAX_GROUP_DEPTH, SYSTEM_GROUP_ID,
    createInteractionGuard: () => ({ isActive: () => interactionActive }),
    createTreeDrag: () => ({ bindSource() {}, bindTarget() {}, reset() {}, isDragging: () => false }),
    createPlatform: () => ({
      mode: "demo", getCurrentPage: async () => null, getOpenTabs: async () => [],
      getOpenTabCandidates: async () => { fetches += 1; return candidateResponse(); },
      getBookmarkCandidates: async () => { fetches += 1; return candidateResponse(); },
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
    $, context, document, actions, opened,
    run: code => vm.runInContext(code, context),
    setCandidates(value) { candidateResponse = value; }, setResponse(value) { response = value; },
    setInteraction(value) { interactionActive = value; },
    fetches: () => fetches,
    open: async () => { void $(bookmarks ? "import-bookmarks" : "save-tabs").emit("click"); await flush(); },
    checks: () => $("dialog-body").querySelectorAll(".tab-candidates input"),
    filter: () => $("dialog-body").querySelector('input'),
    count: () => $("dialog-body").querySelector(".tab-selection-controls p").textContent,
    all: () => $("dialog-body").querySelector(".tab-selection-controls input"),
    async check(title) {
      const input = this.checks().find(item => item.getAttribute("aria-label") === `${title} 선택`);
      assert.ok(input, `checkbox for ${title}`); input.checked = !input.checked; await input.emit("change"); return input;
    },
    async search(value) { this.filter().value = value; await this.filter().emit("input"); },
    async clickText(text) { const control = $("dialog-body").querySelectorAll("button").find(item => item.textContent.startsWith(text)); assert.ok(control, text); await control.emit("click"); await flush(); },
    async target(value) { const target = $("dialog-body").querySelector("select"); target.value = value; await target.emit("change"); },
    submit: () => $("dialog-form").emit("submit")
  };
}



