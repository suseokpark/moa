import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_THEME } from "../src/theme.js";
import { createThemeStore, THEME_STORAGE_KEY, DEMO_THEME_STORAGE_KEY } from "../src/theme-store.js";

const extensionId = "theme-test";
const extensionLocation = new URL(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
const copy = (value) => structuredClone(value);
const theme = (accent = "#8844aa") => ({ ...DEFAULT_THEME, mode: "dark", accent });

function extensionFixture(initial = {}) {
  const data = copy(initial);
  const listeners = new Set();
  const reads = [];
  const writes = [];
  const emit = (changes, area = "local") => { for (const listener of listeners) listener(copy(changes), area); };
  const api = {
    runtime: { id: extensionId },
    storage: {
      local: {
        async get(key) { reads.push(key); return Object.hasOwn(data, key) ? { [key]: copy(data[key]) } : {}; },
        async set(values) {
          writes.push(copy(values));
          const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: data[key], newValue }]));
          Object.assign(data, copy(values));
          emit(changes);
        }
      },
      onChanged: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) }
    }
  };
  const create = (options = {}) => createThemeStore({ chrome: api, location: extensionLocation, ...options });
  return { data, api, reads, writes, emit, listeners, create };
}

function demoFixture(initial = {}) {
  const data = new Map(Object.entries(initial));
  const listeners = new Set();
  const writes = [];
  const local = {
    getItem: (key) => data.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); data.set(key, value); }
  };
  const events = { addEventListener: (_name, fn) => listeners.add(fn), removeEventListener: (_name, fn) => listeners.delete(fn) };
  const create = () => createThemeStore({ chrome: undefined, location: new URL("http://127.0.0.1:4175/extension/notion-favorite-sections/sidepanel/sidepanel.html"), localStorage: local, eventTarget: events });
  const emit = (event) => { for (const listener of listeners) listener(event); };
  return { data, local, writes, listeners, create, emit };
}

test("first load returns a fresh default theme without writing storage", async () => {
  const f = extensionFixture();
  const store = f.create();
  assert.equal(store.mode, "extension");
  const result = await store.load();
  assert.deepEqual(result, { ok: true, theme: DEFAULT_THEME });
  assert.deepEqual(f.reads, [THEME_STORAGE_KEY]);
  assert.deepEqual(f.writes, []);
  result.theme.accent = "#000000";
  assert.deepEqual((await store.load()).theme, DEFAULT_THEME);
});

test("save and theme-only reset preserve all catalog, legacy, undo and backup keys", async () => {
  const unrelated = {
    "favmoa:catalog:v1": { revision: 41, catalog: { title: "링크 보관함" } },
    "favmoa:undo:v1": { revertsRevision: 41 },
    "favmoa:restore-point:v1": { catalog: {} },
    "favmoa:legacy-backup:v1": { original: true },
    "favmoa:schema-v1-backup:v1": { original: true },
    "nfs:workspace:private": { groups: ["original"] },
    "nfs:metadata:private": { title: "기존 제목" }
  };
  const f = extensionFixture(unrelated);
  const store = f.create();
  assert.deepEqual(await store.save(theme()), { ok: true, theme: theme() });
  assert.deepEqual((await store.load()).theme, theme());
  assert.equal((await store.save(DEFAULT_THEME)).ok, true);
  assert.deepEqual(f.data, { ...unrelated, [THEME_STORAGE_KEY]: DEFAULT_THEME });
  assert.ok(f.writes.every(value => Object.keys(value).length === 1 && Object.hasOwn(value, THEME_STORAGE_KEY)));
});

test("invalid saves never write or notify", async () => {
  const f = extensionFixture({ [THEME_STORAGE_KEY]: theme() });
  const store = f.create();
  const notifications = [];
  store.subscribe(value => notifications.push(value));
  for (const invalid of [null, {}, [], { ...theme(), mode: "auto" }, { ...theme(), accent: "url(https://example.com)" }, { ...theme(), extra: "unknown" }, { ...theme(), schemaVersion: 2 }]) {
    assert.deepEqual((await store.save(invalid)).code, "INVALID_THEME");
  }
  assert.deepEqual(f.writes, []);
  assert.deepEqual(notifications, []);
  assert.deepEqual(f.data[THEME_STORAGE_KEY], theme());
});

test("corrupt or future extension preferences fall back without overwriting original bytes", async () => {
  for (const invalid of [null, "invalid", { ...theme(), schemaVersion: 9 }, { ...theme(), accent: "bad" }]) {
    const f = extensionFixture({ [THEME_STORAGE_KEY]: invalid });
    const result = await f.create().load();
    assert.equal(result.ok, true);
    assert.equal(result.code, "INVALID_SAVED_THEME");
    assert.equal(typeof result.warning, "string");
    assert.deepEqual(result.theme, DEFAULT_THEME);
    assert.deepEqual(f.data[THEME_STORAGE_KEY], invalid);
    assert.deepEqual(f.writes, []);
  }
});

test("storage read and write failures never claim success or emit a saved theme", async () => {
  const f = extensionFixture({ [THEME_STORAGE_KEY]: DEFAULT_THEME });
  const store = f.create();
  const notifications = [];
  store.subscribe(value => notifications.push(value));
  f.api.storage.local.get = async () => { throw new Error("disconnected"); };
  assert.equal((await store.load()).code, "THEME_READ_FAILED");
  f.api.storage.local.set = async () => { throw new Error("quota"); };
  assert.equal((await store.save(theme())).code, "THEME_SAVE_FAILED");
  assert.deepEqual(notifications, []);
  assert.deepEqual(f.data[THEME_STORAGE_KEY], DEFAULT_THEME);
});

test("only own extension sidepanel and loopback demos may access theme preferences", async () => {
  const f = extensionFixture();
  for (const href of [
    "https://app.notion.com/page", "https://example.com/sidepanel/sidepanel.html",
    "chrome-extension://other/sidepanel/sidepanel.html", `chrome-extension://${extensionId}/popup/popup.html`,
    `chrome-extension://${extensionId}/sidepanel/sidepanel.html/extra`,
    `chrome-extension://name@${extensionId}/sidepanel/sidepanel.html`
  ]) {
    const store = f.create({ location: new URL(href) });
    assert.equal(store.mode, "unavailable", href);
    assert.equal((await store.load()).ok, false, href);
    assert.equal((await store.save(theme())).ok, false, href);
  }
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
});

test("valid theme changes propagate across panels once and subscriptions clean up", async () => {
  const f = extensionFixture();
  const first = f.create();
  const second = f.create();
  const firstEvents = [];
  const secondEvents = [];
  const stopFirst = first.subscribe(value => firstEvents.push(value));
  const stopSecond = second.subscribe(value => secondEvents.push(value));
  assert.equal(f.listeners.size, 2);
  await first.save(theme());
  assert.deepEqual(firstEvents, [theme()]);
  assert.deepEqual(secondEvents, [theme()]);
  const last = theme("#3344aa");
  await second.save(last);
  assert.deepEqual((await first.load()).theme, last);
  assert.deepEqual(firstEvents.at(-1), last);
  stopFirst();
  stopSecond();
  assert.equal(f.listeners.size, 0);
  f.emit({ [THEME_STORAGE_KEY]: { newValue: DEFAULT_THEME } });
  assert.equal(firstEvents.length, 2);
  assert.equal(secondEvents.length, 2);
});

test("subscriptions ignore other keys, areas, removal and malformed changes", () => {
  const f = extensionFixture();
  const seen = [];
  f.create().subscribe(value => seen.push(value));
  f.emit({ "favmoa:catalog:v1": { newValue: theme() } });
  f.emit({ [THEME_STORAGE_KEY]: { newValue: theme() } }, "sync");
  f.emit({ [THEME_STORAGE_KEY]: { oldValue: theme() } });
  f.emit({ [THEME_STORAGE_KEY]: { newValue: null } });
  f.emit({ [THEME_STORAGE_KEY]: { newValue: { ...theme(), accent: "script" } } });
  assert.deepEqual(seen, []);
  f.emit({ [THEME_STORAGE_KEY]: { newValue: theme() } });
  assert.deepEqual(seen, [theme()]);
});

test("subscriber errors and mutations cannot affect saved values or other subscribers", async () => {
  const f = extensionFixture();
  const store = f.create();
  store.subscribe(value => { value.accent = "#000000"; throw new Error("view error"); });
  const seen = [];
  store.subscribe(value => seen.push(value));
  const result = await store.save(theme());
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [theme()]);
  assert.deepEqual(f.data[THEME_STORAGE_KEY], theme());
  assert.deepEqual(result.theme, theme());
});

test("concurrent saves in one panel persist in user-request order", async () => {
  const f = extensionFixture();
  const write = f.api.storage.local.set;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  f.api.storage.local.set = async (value) => {
    calls += 1;
    if (calls === 1) await gate;
    await write(value);
  };
  const store = f.create();
  const first = store.save(theme());
  const lastTheme = theme("#223344");
  const second = store.save(lastTheme);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.deepEqual(f.data[THEME_STORAGE_KEY], lastTheme);
});

test("late save completion cannot regress a newer theme already persisted by another panel", async () => {
  const f = extensionFixture();
  const write = f.api.storage.local.set;
  let releaseFirst;
  const firstCompletion = new Promise(resolve => { releaseFirst = resolve; });
  const firstTheme = theme("#553388");
  const lastTheme = theme("#227744");
  f.api.storage.local.set = async value => {
    await write(value);
    if (value[THEME_STORAGE_KEY].accent === firstTheme.accent) await firstCompletion;
  };
  const first = f.create();
  const second = f.create();
  const firstEvents = [];
  const secondEvents = [];
  first.subscribe(value => firstEvents.push(value));
  second.subscribe(value => secondEvents.push(value));
  const firstSave = first.save(firstTheme);
  await Promise.resolve();
  assert.deepEqual(f.data[THEME_STORAGE_KEY], firstTheme);
  await second.save(lastTheme);
  assert.deepEqual(f.data[THEME_STORAGE_KEY], lastTheme);
  releaseFirst();
  const result = await firstSave;
  assert.equal(result.ok, true);
  assert.equal(result.superseded, true);
  assert.deepEqual(result.theme, lastTheme);
  assert.deepEqual(firstEvents, [firstTheme, lastTheme]);
  assert.deepEqual(secondEvents, [firstTheme, lastTheme]);
  assert.deepEqual(f.data[THEME_STORAGE_KEY], lastTheme);
});

test("pending saves observe newer storage events even without a UI subscriber and clean up", async () => {
  const f = extensionFixture();
  const write = f.api.storage.local.set;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.api.storage.local.set = async value => { await write(value); await gate; };
  const store = f.create();
  const saving = store.save(theme());
  await Promise.resolve();
  assert.equal(f.listeners.size, 1);
  const latest = theme("#225599");
  f.data[THEME_STORAGE_KEY] = copy(latest);
  f.emit({ [THEME_STORAGE_KEY]: { newValue: latest } });
  release();
  const result = await saving;
  assert.equal(result.superseded, true);
  assert.deepEqual(result.theme, latest);
  assert.equal(f.listeners.size, 0);
});

test("demo settings use a separate local key and leave real settings and demo catalog untouched", async () => {
  const real = JSON.stringify(theme("#556677"));
  const catalog = JSON.stringify({ "favmoa:catalog:v1": { revision: 12 } });
  const f = demoFixture({ [THEME_STORAGE_KEY]: real, "favmoa:demo:v1": catalog });
  const store = f.create();
  assert.equal(store.mode, "demo");
  assert.deepEqual((await store.load()).theme, DEFAULT_THEME);
  assert.equal((await store.save(theme())).ok, true);
  assert.deepEqual((await store.load()).theme, theme());
  assert.equal(f.data.get(THEME_STORAGE_KEY), real);
  assert.equal(f.data.get("favmoa:demo:v1"), catalog);
  assert.ok(f.writes.every(([key]) => key === DEMO_THEME_STORAGE_KEY));
});

test("corrupt demo JSON displays defaults without rewriting the original string", async () => {
  const f = demoFixture({ [DEMO_THEME_STORAGE_KEY]: "{broken" });
  const result = await f.create().load();
  assert.equal(result.ok, true);
  assert.equal(result.code, "INVALID_SAVED_THEME");
  assert.deepEqual(result.theme, DEFAULT_THEME);
  assert.equal(f.data.get(DEMO_THEME_STORAGE_KEY), "{broken");
  assert.deepEqual(f.writes, []);
});

test("demo storage events accept only valid theme data from the same local storage area", async () => {
  const f = demoFixture();
  const store = f.create();
  const seen = [];
  const stop = store.subscribe(value => seen.push(value));
  f.emit({ key: "favmoa:demo:v1", newValue: JSON.stringify(theme()) });
  f.emit({ key: DEMO_THEME_STORAGE_KEY, newValue: "broken" });
  f.emit({ key: DEMO_THEME_STORAGE_KEY, newValue: null });
  f.emit({ key: DEMO_THEME_STORAGE_KEY, newValue: JSON.stringify(theme()), storageArea: {} });
  assert.deepEqual(seen, []);
  f.emit({ key: DEMO_THEME_STORAGE_KEY, newValue: JSON.stringify(theme()), storageArea: f.local });
  assert.deepEqual(seen, [theme()]);
  assert.equal((await store.save(DEFAULT_THEME)).ok, true);
  assert.deepEqual(seen.at(-1), DEFAULT_THEME);
  stop();
  assert.equal(f.listeners.size, 0);
});

test("demo quota and read errors fail without rewriting preferences or notifying", async () => {
  const f = demoFixture({ [DEMO_THEME_STORAGE_KEY]: JSON.stringify(DEFAULT_THEME) });
  const store = f.create();
  const seen = [];
  store.subscribe(value => seen.push(value));
  f.local.getItem = () => { throw new Error("blocked storage"); };
  assert.equal((await store.load()).ok, false);
  f.local.setItem = () => { throw new Error("quota"); };
  assert.equal((await store.save(theme())).ok, false);
  assert.equal(f.data.get(DEMO_THEME_STORAGE_KEY), JSON.stringify(DEFAULT_THEME));
  assert.deepEqual(seen, []);
});
