import assert from "node:assert/strict";
import test from "node:test";
import { initializeThemeSettings } from "../src/theme-settings.js";
import { DEFAULT_THEME, THEME_PRESETS, resolveTheme, validateTheme } from "../src/theme.js";

const copy = value => structuredClone(value);
const customTheme = { ...DEFAULT_THEME, mode: "light", accent: "#8844aa", lightBackground: "#faf7fe", darkBackground: "#201929" };

// Deliberately small DOM fixture: events invoke the real controller listeners,
// while dialogs, focus and CSS custom properties stay inspectable in Node.
class Control {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase(); this.id = id; this.children = [];
    this.value = ""; this.textContent = ""; this.disabled = false; this.open = false;
    this.attributes = {}; this.listeners = new Map(); this.dataset = {};
    this.style = { properties: {}, setProperty(name, value) { this.properties[name] = value; } };
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  async emit(type, fields = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields };
    await Promise.all([...this.listeners.get(type) || []].map(listener => listener(event)));
    return event;
  }
  querySelectorAll(selector) {
    assert.ok(["input,select,button", "input,select"].includes(selector));
    const tagNames = selector.split(",").map(value => value.toUpperCase());
    const matches = [];
    const visit = node => { for (const child of node.children) { if (tagNames.includes(child.tagName)) matches.push(child); if (child.children) visit(child); } };
    visit(this); return matches;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.ownerDocument.activeElement = this; }
}

function fakeDocument() {
  const elements = new Map();
  const documentRef = {
    activeElement: null, documentElement: new Control("html"),
    getElementById(id) { assert.ok(elements.has(id), `Fixture missing #${id}`); return elements.get(id); },
    createElement(tagName) { const node = new Control(tagName); node.ownerDocument = this; return node; },
    createTextNode(textContent) { return { textContent }; }
  };
  const form = documentRef.createElement("form"); form.id = "theme-form"; elements.set(form.id, form);
  const tags = {
    "theme-dialog": "dialog", "theme-open": "button", "theme-close": "button", "theme-cancel": "button",
    "theme-reset": "button", "theme-save": "button", "theme-mode": "select", "theme-presets": "div",
    "theme-feedback": "p", "theme-error": "p", "theme-announcement": "p"
  };
  for (const id of ["theme-accent", "theme-light", "theme-dark"]) { tags[`${id}-picker`] = "input"; tags[`${id}-hex`] = "input"; }
  for (const [id, tagName] of Object.entries(tags)) {
    const node = documentRef.createElement(tagName); node.id = id; elements.set(id, node);
    if (!["theme-dialog", "theme-open", "theme-announcement"].includes(id)) form.append(node);
  }
  elements.get("theme-dialog").append(form);
  return documentRef;
}

function fakeStore(initial = DEFAULT_THEME) {
  let saved = validateTheme(initial);
  const subscribers = new Set();
  const calls = [];
  return {
    calls, subscribers, failure: null,
    async load() { calls.push(["load"]); return { ok: true, theme: copy(saved) }; },
    async save(value) {
      calls.push(["save", copy(value)]);
      if (this.failure) return { ok: false, error: this.failure };
      saved = validateTheme(value);
      for (const callback of subscribers) callback(copy(saved));
      return { ok: true, theme: copy(saved) };
    },
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    external(value) { saved = validateTheme(value); for (const callback of subscribers) callback(copy(saved)); },
    snapshot() { return copy(saved); }
  };
}

async function fixture({ initial = DEFAULT_THEME, store = fakeStore(initial), dark = false } = {}) {
  const documentRef = fakeDocument();
  const listeners = new Set();
  const mediaQuery = {
    matches: dark,
    addEventListener(type, callback) { assert.equal(type, "change"); listeners.add(callback); },
    removeEventListener(type, callback) { assert.equal(type, "change"); listeners.delete(callback); },
    change(matches) { this.matches = matches; for (const callback of listeners) callback({ matches }); },
    listeners
  };
  const controller = initializeThemeSettings({ documentRef, store, mediaQuery });
  await controller.ready;
  const $ = id => documentRef.getElementById(id);
  const open = () => $("theme-open").emit("click");
  const color = async (name, value) => { const field = $(`theme-${name}-hex`); field.value = value; await field.emit("input"); };
  const mode = async value => { $("theme-mode").value = value; await $("theme-mode").emit("change"); };
  const assertApplied = value => {
    const resolved = resolveTheme(value, mediaQuery.matches);
    assert.equal(documentRef.documentElement.dataset.themeMode, resolved.mode);
    assert.equal(documentRef.documentElement.style.colorScheme, resolved.mode);
    assert.deepEqual(documentRef.documentElement.style.properties, Object.fromEntries(Object.entries(resolved.tokens).map(([key, color]) => [`--${key}`, color])));
  };
  return { documentRef, store, controller, mediaQuery, $, open, color, mode, assertApplied };
}

test("preview changes colors immediately and Cancel restores saved theme without writing", async () => {
  const f = await fixture({ initial: customTheme });
  f.assertApplied(customTheme);
  await f.open();
  assert.equal(f.$("theme-dialog").open, true);
  assert.equal(f.documentRef.activeElement.id, "theme-mode");
  await f.color("accent", "#225577");
  f.assertApplied({ ...customTheme, accent: "#225577" });
  assert.equal(f.store.calls.filter(([type]) => type === "save").length, 0);
  await f.$("theme-cancel").emit("click");
  f.assertApplied(customTheme);
  assert.equal(f.$("theme-dialog").open, false);
  assert.equal(f.documentRef.activeElement.id, "theme-open");
  assert.deepEqual(f.store.snapshot(), customTheme);
});

test("Save persists a canonical theme, closes the dialog and survives controller reload", async () => {
  const f = await fixture();
  await f.open();
  await f.color("accent", "#3355AA");
  await f.mode("dark");
  const event = await f.$("theme-form").emit("submit");
  assert.equal(event.defaultPrevented, true);
  const expected = { ...DEFAULT_THEME, mode: "dark", accent: "#3355aa" };
  assert.deepEqual(f.store.snapshot(), expected);
  assert.equal(f.$("theme-dialog").open, false);
  assert.equal(f.$("theme-form").getAttribute("aria-busy"), "false");
  assert.match(f.$("theme-announcement").textContent, /저장했습니다/u);
  f.assertApplied(expected);
  f.controller.dispose();
  const reopened = await fixture({ store: f.store, dark: false });
  reopened.assertApplied(expected);
  await reopened.open();
  assert.equal(reopened.$("theme-mode").value, "dark");
  assert.equal(reopened.$("theme-accent-hex").value, "#3355aa");
});

test("invalid hex keeps the last valid preview and blocks submission until corrected", async () => {
  const f = await fixture();
  await f.open();
  for (const value of ["", "#fff", "#12gg44", "red", "url(x)"]) {
    await f.color("accent", value);
    assert.equal(f.$("theme-accent-hex").getAttribute("aria-invalid"), "true");
    assert.equal(f.$("theme-save").disabled, true);
    assert.notEqual(f.$("theme-error").textContent, "");
    await f.$("theme-form").emit("submit");
  }
  f.assertApplied(DEFAULT_THEME);
  assert.equal(f.store.calls.filter(([type]) => type === "save").length, 0);
  await f.color("accent", "#226688");
  assert.equal(f.$("theme-accent-hex").getAttribute("aria-invalid"), "false");
  assert.equal(f.$("theme-save").disabled, false);
  assert.equal(f.$("theme-error").textContent, "");
  await f.$("theme-form").emit("submit");
  assert.equal(f.store.snapshot().accent, "#226688");
});

test("save failure keeps the dialog and preview open, reports unsaved changes and allows Cancel", async () => {
  const f = await fixture();
  f.store.failure = "저장 공간이 부족합니다.";
  await f.open();
  await f.color("accent", "#552277");
  await f.$("theme-form").emit("submit");
  assert.equal(f.$("theme-dialog").open, true);
  assert.equal(f.$("theme-save").disabled, false);
  assert.match(f.$("theme-error").textContent, /아직 저장되지 않았습니다/u);
  assert.equal(f.$("theme-announcement").textContent, "");
  assert.deepEqual(f.store.snapshot(), DEFAULT_THEME);
  f.assertApplied({ ...DEFAULT_THEME, accent: "#552277" });
  await f.$("theme-cancel").emit("click");
  f.assertApplied(DEFAULT_THEME);
});

test("default reset is a reversible preview until Save and writes only theme fields", async () => {
  const f = await fixture({ initial: customTheme });
  await f.open();
  await f.$("theme-reset").emit("click");
  f.assertApplied(DEFAULT_THEME);
  assert.match(f.$("theme-feedback").textContent, /테마 설정만 초기화/u);
  assert.equal(f.store.calls.filter(([type]) => type === "save").length, 0);
  await f.$("theme-cancel").emit("click");
  f.assertApplied(customTheme);
  await f.open();
  await f.$("theme-reset").emit("click");
  await f.$("theme-form").emit("submit");
  assert.deepEqual(f.store.calls.filter(([type]) => type === "save"), [["save", DEFAULT_THEME]]);
  assert.deepEqual(f.store.snapshot(), DEFAULT_THEME);
});

test("system mode follows OS changes but explicit light and dark modes do not", async () => {
  const f = await fixture();
  f.assertApplied(DEFAULT_THEME);
  f.mediaQuery.change(true);
  assert.equal(f.documentRef.documentElement.dataset.themeMode, "dark");
  await f.open();
  await f.mode("light");
  f.mediaQuery.change(false);
  f.mediaQuery.change(true);
  assert.equal(f.documentRef.documentElement.dataset.themeMode, "light");
  await f.$("theme-form").emit("submit");
  f.mediaQuery.change(false);
  f.mediaQuery.change(true);
  f.assertApplied({ ...DEFAULT_THEME, mode: "light" });
  await f.open();
  await f.mode("dark");
  f.mediaQuery.change(false);
  assert.equal(f.documentRef.documentElement.dataset.themeMode, "dark");
  await f.$("theme-form").emit("submit");
  f.mediaQuery.change(false);
  f.assertApplied({ ...DEFAULT_THEME, mode: "dark" });
});

test("external change does not silently replace an open draft and Cancel applies latest saved theme", async () => {
  const f = await fixture();
  await f.open();
  await f.color("accent", "#224488");
  const draft = { ...DEFAULT_THEME, accent: "#224488" };
  f.store.external(customTheme);
  assert.equal(f.$("theme-accent-hex").value, draft.accent);
  f.assertApplied(draft);
  assert.match(f.$("theme-feedback").textContent, /다른 화면에서 테마가 변경/u);
  assert.equal(f.store.calls.filter(([type]) => type === "save").length, 0);
  await f.$("theme-cancel").emit("click");
  f.assertApplied(customTheme);
  await f.open();
  assert.equal(f.$("theme-accent-hex").value, customTheme.accent);
});

test("explicit Save may replace external settings after conflict warning", async () => {
  const f = await fixture();
  await f.open();
  await f.color("accent", "#224488");
  f.store.external(customTheme);
  assert.match(f.$("theme-feedback").textContent, /저장하면 지금 선택/u);
  await f.$("theme-form").emit("submit");
  assert.deepEqual(f.store.snapshot(), { ...DEFAULT_THEME, accent: "#224488" });
  assert.equal(f.$("theme-dialog").open, false);
});

test("closed panel follows external changes and dispose unsubscribes store and OS events", async () => {
  const f = await fixture();
  f.store.external(customTheme);
  f.assertApplied(customTheme);
  assert.equal(f.store.subscribers.size, 1);
  assert.equal(f.mediaQuery.listeners.size, 1);
  f.controller.dispose();
  assert.equal(f.store.subscribers.size, 0);
  assert.equal(f.mediaQuery.listeners.size, 0);
  f.store.external(DEFAULT_THEME);
  f.assertApplied(customTheme);
});

test("recommended presets retain chosen mode and picker inputs remain paired with hex fields", async () => {
  const f = await fixture();
  await f.open();
  await f.mode("dark");
  const preset = THEME_PRESETS[1];
  const button = f.$("theme-presets").children[1];
  await button.emit("click");
  assert.equal(f.$("theme-mode").value, "dark");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(f.$("theme-accent-hex").value, preset.accent);
  assert.equal(f.$("theme-light-picker").value, preset.lightBackground);
  f.$("theme-accent-picker").value = "#663311";
  await f.$("theme-accent-picker").emit("input");
  assert.equal(f.$("theme-accent-hex").value, "#663311");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  f.assertApplied({ schemaVersion: 1, mode: "dark", accent: "#663311", lightBackground: preset.lightBackground, darkBackground: preset.darkBackground });
});

test("Escape cancels preview instead of allowing the dialog to keep unsaved appearance", async () => {
  const f = await fixture({ initial: customTheme });
  await f.open();
  await f.color("light", "#eeeeee");
  const event = await f.$("theme-dialog").emit("cancel");
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.$("theme-dialog").open, false);
  f.assertApplied(customTheme);
  assert.equal(f.store.calls.filter(([type]) => type === "save").length, 0);
});

test("opening during initial load shares one read and disables edits but keeps Cancel available", async () => {
  const documentRef = fakeDocument();
  const store = fakeStore(customTheme);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let reads = 0;
  store.load = () => { reads += 1; return pending; };
  const mediaQuery = { matches: false, addEventListener() {}, removeEventListener() {} };
  const controller = initializeThemeSettings({ documentRef, store, mediaQuery });
  const $ = id => documentRef.getElementById(id);
  await $("theme-open").emit("click");
  assert.equal(reads, 1);
  assert.equal($("theme-dialog").open, true);
  assert.equal($("theme-mode").disabled, true);
  assert.equal($("theme-accent-hex").disabled, true);
  assert.equal($("theme-accent-picker").disabled, true);
  assert.equal($("theme-presets").children.every(control => control.disabled), true);
  assert.equal($("theme-reset").disabled, true);
  assert.equal($("theme-save").disabled, true);
  assert.equal($("theme-cancel").disabled, false);
  assert.equal($("theme-close").disabled, false);
  await $("theme-form").emit("submit");
  assert.equal(store.calls.filter(([type]) => type === "save").length, 0);
  release({ ok: true, theme: copy(customTheme) });
  await controller.ready;
  assert.equal(reads, 1);
  assert.equal($("theme-accent-hex").value, customTheme.accent);
  assert.equal($("theme-mode").disabled, false);
  assert.equal($("theme-accent-hex").disabled, false);
  assert.equal($("theme-save").disabled, false);
  controller.dispose();
});

test("failed initial reads leave edits disabled, and closing then reopening can retry", async () => {
  const store = fakeStore(customTheme);
  const realLoad = store.load.bind(store);
  let attempts = 0;
  store.load = async () => ++attempts <= 2 ? { ok: false, error: "읽기 오류" } : realLoad();
  const f = await fixture({ store });
  assert.equal(f.$("theme-save").disabled, true);
  await f.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.$("theme-error").textContent, /읽기 오류/u);
  assert.equal(f.$("theme-accent-hex").disabled, true);
  await f.$("theme-cancel").emit("click");
  await f.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.equal(f.$("theme-save").disabled, false);
  assert.equal(f.$("theme-accent-hex").value, customTheme.accent);
  assert.equal(f.$("theme-error").textContent, "");
});

test("pending save disables controls, ignores duplicate submission and prevents Escape cancellation", async () => {
  const f = await fixture();
  const realSave = f.store.save.bind(f.store);
  let release;
  let writes = 0;
  const pending = new Promise(resolve => { release = resolve; });
  f.store.save = async value => { writes += 1; await pending; return realSave(value); };
  await f.open();
  await f.color("accent", "#224466");
  const saving = f.$("theme-form").emit("submit");
  assert.equal(f.$("theme-form").getAttribute("aria-busy"), "true");
  assert.equal(f.$("theme-form").querySelectorAll("input,select,button").every(control => control.disabled), true);
  await f.$("theme-form").emit("submit");
  const event = await f.$("theme-dialog").emit("cancel");
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.$("theme-dialog").open, true);
  assert.equal(writes, 1);
  release();
  await saving;
  assert.equal(f.$("theme-dialog").open, false);
  assert.equal(f.$("theme-form").getAttribute("aria-busy"), "false");
  assert.equal(f.store.snapshot().accent, "#224466");
});

test("unexpected save rejection is shown as failure and re-enables editing", async () => {
  const f = await fixture();
  await f.open();
  await f.color("accent", "#441166");
  f.store.save = async () => { throw new Error("connection interrupted"); };
  await f.$("theme-form").emit("submit");
  assert.equal(f.$("theme-dialog").open, true);
  assert.equal(f.$("theme-save").disabled, false);
  assert.match(f.$("theme-error").textContent, /저장하지 못했습니다/u);
  assert.equal(f.$("theme-announcement").textContent, "");
  assert.deepEqual(f.store.snapshot(), DEFAULT_THEME);
});

test("late Save response cannot replace newer settings observed while the write was pending", async () => {
  const f = await fixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const realSave = f.store.save.bind(f.store);
  f.store.save = async value => { const result = await realSave(value); await pending; return result; };
  await f.open();
  await f.color("accent", "#445588");
  const saving = f.$("theme-form").emit("submit");
  await Promise.resolve();
  f.store.external(customTheme);
  release();
  await saving;
  f.assertApplied(customTheme);
  assert.equal(f.$("theme-dialog").open, false);
  assert.match(f.$("theme-announcement").textContent, /최신 테마/u);
  assert.deepEqual(f.store.snapshot(), customTheme);
});
