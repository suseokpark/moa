import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog, identifyUrl } from "../src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY, FAVMOA_LEGACY_BACKUP_KEY, FAVMOA_RESTORE_POINT_KEY, FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY, isTrustedFavmoaSender } from "../src/favmoa-service.js";
import { createPlatform } from "../src/favmoa-platform.js";

const sender = { id: "extension-test", url: "chrome-extension://extension-test/sidepanel/sidepanel.html" };
const copy = value => structuredClone(value);

function memoryStorage(initial = {}) {
  const data = copy(initial);
  return {
    data,
    access: [],
    async setAccessLevel(options) { this.access.push(options); },
    async get(keys) {
      if (keys === null) return copy(data);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, copy(data[key])]));
    },
    async set(values) { Object.assign(data, copy(values)); }
  };
}

function service(initial) {
  const storage = memoryStorage(initial);
  return { storage, handle: createCatalogService({ storage, runtimeId: sender.id }).handle };
}

function changedCatalog(name = "프로젝트 자료") {
  const catalog = createCatalog();
  catalog.libraries[0].name = name;
  return catalog;
}

function chromeFixture(tabs = []) {
  const calls = [];
  const changedListeners = new Set();
  const api = {
    runtime: { id: sender.id, sendMessage: async message => ({ ok: true, catalog: createCatalog(), revision: message.expectedRevision ?? 0 }) },
    tabs: {
      async query(query) { calls.push(["query", query]); return copy(query.active ? tabs.filter(tab => tab.active) : tabs); },
      async update(id, update) { calls.push(["update", id, update]); return { id }; },
      async create(options) { calls.push(["create", options]); return { id: 100 }; }
    },
    windows: { async update(id, update) { calls.push(["window", id, update]); } },
    permissions: { async request(options) { calls.push(["permission", options]); return true; } },
    bookmarks: { async getTree() { calls.push(["bookmarks"]); return []; } },
    storage: { onChanged: { addListener(listener) { changedListeners.add(listener); }, removeListener(listener) { changedListeners.delete(listener); } } }
  };
  const platform = createPlatform({ chrome: api, location: { protocol: "chrome-extension:", hostname: sender.id } });
  return { api, platform, calls, changedListeners };
}

test("only the known FAVMOA sidepanel is trusted", () => {
  assert.equal(isTrustedFavmoaSender(sender, sender.id), true);
  assert.equal(isTrustedFavmoaSender({ ...sender, url: `${sender.url}?view=tree` }, sender.id), true);
  for (const variant of [
    { ...sender, url: "https://app.notion.com/page" },
    { ...sender, url: "chrome-extension://other/sidepanel/sidepanel.html" },
    { ...sender, url: "chrome-extension://extension-test/popup/popup.html" },
    { ...sender, url: "chrome-extension://extension-test/sidepanel/sidepanel.html/extra" },
    { ...sender, id: "other" }, {}, null
  ]) assert.equal(isTrustedFavmoaSender(variant, sender.id), false);
});

test("new catalog has revision zero and restricts storage without importing legacy", async () => {
  const { storage, handle } = service({ "nfs:workspace:private": { revision: 7, workspace: {} } });
  const result = await handle({ type: "FAVMOA_GET" }, sender);
  assert.equal(result.ok, true);
  assert.equal(result.revision, 0);
  assert.deepEqual(result.catalog, createCatalog());
  assert.deepEqual(storage.access, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
  assert.equal(storage.data[FAVMOA_STORAGE_KEY], undefined);
});

test("untrusted content messages cannot read or overwrite catalog", async () => {
  const { storage, handle } = service();
  const bad = { ...sender, url: "https://app.notion.com/" };
  assert.equal((await handle({ type: "FAVMOA_GET" }, bad)).code, "UNTRUSTED_SENDER");
  assert.equal((await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: changedCatalog(), expectedRevision: 0 }, bad)).ok, false);
  assert.equal(storage.data[FAVMOA_STORAGE_KEY], undefined);
});

test("backup import is revision guarded and undo restores prior catalog", async () => {
  const { storage, handle } = service();
  const first = await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: changedCatalog(), expectedRevision: 0 }, sender);
  assert.equal(first.ok, true);
  assert.equal(first.revision, 1);
  assert.equal(first.canUndo, true);
  assert.deepEqual(storage.data[FAVMOA_UNDO_KEY].catalog, createCatalog());
  const stale = await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: changedCatalog("다른 창"), expectedRevision: 0 }, sender);
  assert.equal(stale.code, "CONFLICT");
  assert.equal(stale.catalog.libraries[0].name, "프로젝트 자료");
  const undo = await handle({ type: "FAVMOA_UNDO", expectedRevision: 1 }, sender);
  assert.equal(undo.ok, true);
  assert.equal(undo.revision, 2);
  assert.equal(undo.canUndo, false);
  assert.deepEqual(undo.catalog, createCatalog());
  assert.equal((await handle({ type: "FAVMOA_UNDO", expectedRevision: 2 }, sender)).code, "NOTHING_TO_UNDO");
});

test("restore checkpoint survives edits, folds and undo, then recovery can itself be undone", async () => {
  const original = changedCatalog("복원 전 목록");
  const { handle } = service({ [FAVMOA_STORAGE_KEY]: { revision: 0, catalog: original } });
  assert.equal((await handle({ type: "FAVMOA_GET" }, sender)).hasRestorePoint, false);
  const imported = await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: changedCatalog("가져온 목록"), expectedRevision: 0 }, sender);
  assert.equal(imported.hasRestorePoint, true);
  const edited = await handle({ type: "FAVMOA_ACTION", action: { type: "renameLibrary", libraryId: "library-personal", name: "가져온 뒤 편집" }, expectedRevision: 1 }, sender);
  assert.equal(edited.hasRestorePoint, true);
  const folded = await handle({ type: "FAVMOA_ACTION", action: { type: "toggleGroup", libraryId: "library-personal", groupId: original.libraries[0].groups[0].id }, expectedRevision: 2 }, sender);
  assert.equal(folded.hasRestorePoint, true);
  const undoEdit = await handle({ type: "FAVMOA_UNDO", expectedRevision: 3 }, sender);
  assert.equal(undoEdit.hasRestorePoint, true);
  assert.equal(undoEdit.catalog.libraries[0].name, imported.catalog.libraries[0].name);
  assert.equal(undoEdit.catalog.libraries[0].groups[0].collapsed, folded.catalog.libraries[0].groups[0].collapsed);
  const recovered = await handle({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 4 }, sender);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.catalog, original);
  assert.equal(recovered.hasRestorePoint, false);
  assert.equal(recovered.canUndo, true);
  const undoRecovery = await handle({ type: "FAVMOA_UNDO", expectedRevision: 5 }, sender);
  assert.deepEqual(undoRecovery.catalog, undoEdit.catalog);
  assert.equal(undoRecovery.hasRestorePoint, false);
  assert.equal((await handle({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 6 }, sender)).code, "NO_RESTORE_POINT");
});

test("platform exposes revision guarded recovery and its current availability", async () => {
  const { api, platform } = chromeFixture();
  let sent;
  api.runtime.sendMessage = async message => {
    sent = message;
    return { ok: true, catalog: changedCatalog("복구한 목록"), revision: 8, canUndo: true, hasRestorePoint: false };
  };
  const result = await platform.restorePreviousBackup(7);
  assert.deepEqual(sent, { type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 7 });
  assert.equal(result.hasRestorePoint, false);
  assert.equal(result.canUndo, true);
});

test("a no-op backup import keeps its checkpoint and a later changed import replaces it", async () => {
  const original = changedCatalog("원래 목록");
  const { handle } = service({ [FAVMOA_STORAGE_KEY]: { revision: 0, catalog: original } });
  const first = changedCatalog("첫 백업");
  await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: first, expectedRevision: 0 }, sender);
  const unchanged = await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: first, expectedRevision: 1 }, sender);
  assert.equal(unchanged.revision, 1);
  assert.equal(unchanged.hasRestorePoint, true);
  const recovered = await handle({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 1 }, sender);
  assert.deepEqual(recovered.catalog, original);
  await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: first, expectedRevision: 2 }, sender);
  await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: changedCatalog("두 번째 백업"), expectedRevision: 3 }, sender);
  assert.deepEqual((await handle({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 4 }, sender)).catalog, first);
});

test("stale, invalid and untrusted recovery requests preserve current data and the checkpoint", async () => {
  const { storage, handle } = service();
  await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: changedCatalog(), expectedRevision: 0 }, sender);
  const snapshot = copy(storage.data);
  const conflict = await handle({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 0 }, sender);
  assert.equal(conflict.code, "CONFLICT");
  assert.equal(conflict.revision, 1);
  assert.equal(conflict.hasRestorePoint, true);
  assert.equal((await handle({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP" }, sender)).code, "INVALID_REQUEST");
  assert.equal((await handle({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 1 }, { ...sender, url: "https://app.notion.com/" })).code, "UNTRUSTED_SENDER");
  assert.deepEqual(storage.data, snapshot);
});

test("an unreadable restore checkpoint never blocks local loads or edits and cannot overwrite data", async () => {
  const catalog = changedCatalog("유효한 현재 목록");
  for (const checkpoint of [null, {}, { catalog: {} }, { catalog: { ...createCatalog(), schemaVersion: 99 } }]) {
    const { storage, handle } = service({
      [FAVMOA_STORAGE_KEY]: { revision: 3, catalog },
      [FAVMOA_RESTORE_POINT_KEY]: checkpoint
    });
    const snapshot = copy(storage.data);
    const loaded = await handle({ type: "FAVMOA_GET" }, sender);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.hasRestorePoint, false);
    assert.deepEqual(loaded.catalog, catalog);
    assert.equal((await handle({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 3 }, sender)).code, "NO_RESTORE_POINT");
    assert.deepEqual(storage.data, snapshot);
    const edited = await handle({ type: "FAVMOA_ACTION", action: { type: "renameLibrary", libraryId: "library-personal", name: "안전한 편집" }, expectedRevision: 3 }, sender);
    assert.equal(edited.ok, true);
    assert.equal(edited.hasRestorePoint, false);
  }
});

test("failed backup import or checkpoint recovery keeps all saved data and can be retried", async () => {
  const original = changedCatalog("보존할 원래 목록");
  const { storage, handle } = service({ [FAVMOA_STORAGE_KEY]: { revision: 0, catalog: original } });
  await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: changedCatalog("현재 목록"), expectedRevision: 0 }, sender);
  const snapshot = copy(storage.data);
  const save = storage.set;
  storage.set = async () => { throw new Error("synthetic storage failure"); };
  for (const request of [
    { type: "FAVMOA_IMPORT_BACKUP", catalog: changedCatalog("저장 실패한 백업"), expectedRevision: 1 },
    { type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 1 }
  ]) {
    assert.equal((await handle(request, sender)).code, "SAVE_FAILED");
    assert.deepEqual(storage.data, snapshot);
    const current = await handle({ type: "FAVMOA_GET" }, sender);
    assert.equal(current.revision, 1);
    assert.equal(current.hasRestorePoint, true);
  }
  storage.set = save;
  const recovered = await handle({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision: 1 }, sender);
  assert.deepEqual(recovered.catalog, original);
  assert.equal(recovered.hasRestorePoint, false);
});

test("concurrent writers serialize and only one wins the same revision", async () => {
  const { handle } = service();
  const results = await Promise.all(["첫 창", "두 번째 창"].map(name => handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: changedCatalog(name), expectedRevision: 0 }, sender)));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => result.code === "CONFLICT").length, 1);
});

test("catalog actions persist, save failures do not advance revision, and retry works", async () => {
  const { storage, handle } = service();
  const action = { type: "addGroup", libraryId: "library-personal", name: "프로젝트" };
  const save = storage.set;
  storage.set = async () => { throw new Error("quota details are private"); };
  const failed = await handle({ type: "FAVMOA_ACTION", action, expectedRevision: 0 }, sender);
  assert.equal(failed.code, "SAVE_FAILED");
  assert.equal(failed.error.includes("quota"), false);
  assert.equal((await handle({ type: "FAVMOA_GET" }, sender)).revision, 0);
  storage.set = save;
  const result = await handle({ type: "FAVMOA_ACTION", action, expectedRevision: 0 }, sender);
  assert.equal(result.ok, true);
  assert.equal(result.revision, 1);
  assert.equal(result.catalog.libraries[0].groups.at(-1).name, "프로젝트");
});

test("explicit legacy import keeps source data and a bounded snapshot, repeated import is idempotent", async () => {
  const pageId = "0123456789abcdef0123456789abcdef";
  const workspaceKey = "nfs:workspace:sample";
  const metadataKey = "nfs:metadata:sample";
  const original = {
    [workspaceKey]: { revision: 2, workspace: { schemaVersion: 1, groups: [{ id: "group", name: "자료", color: "", emoji: "", collapsed: false, order: 0, system: true, sections: [{ id: "section", name: "문서", color: "", emoji: "", collapsed: false, order: 0, system: true, favorites: [{ pageId, order: 0, dormant: false, updatedAt: "2026-09-21T00:00:00.000Z" }] }] }] } },
    [metadataKey]: [{ pageId, title: "샘플 페이지", icon: "" }],
    "unrelated-private-setting": "never-copy-this"
  };
  const { storage, handle } = service(original);
  const imported = await handle({ type: "FAVMOA_IMPORT_LEGACY", expectedRevision: 0 }, sender);
  assert.equal(imported.ok, true);
  assert.equal(imported.importedLibraries, 1);
  assert.equal(imported.importedLinks, 1);
  assert.deepEqual(storage.data[workspaceKey], original[workspaceKey]);
  assert.deepEqual(storage.data[metadataKey], original[metadataKey]);
  assert.deepEqual(Object.keys(storage.data[FAVMOA_LEGACY_BACKUP_KEY]).sort(), [metadataKey, workspaceKey].sort());
  const again = await handle({ type: "FAVMOA_IMPORT_LEGACY", expectedRevision: 1 }, sender);
  assert.equal(again.importedLibraries, 0);
  assert.equal(again.revision, 1);
  const undo = await handle({ type: "FAVMOA_UNDO", expectedRevision: 1 }, sender);
  assert.deepEqual(undo.catalog, createCatalog());
  assert.deepEqual(storage.data[workspaceKey], original[workspaceKey]);
});

test("invalid backup, corrupt envelope and omitted revision never overwrite saved data", async () => {
  const { storage, handle } = service();
  assert.equal((await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: {} , expectedRevision: 0 }, sender)).ok, false);
  assert.equal((await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: changedCatalog() }, sender)).code, "INVALID_REQUEST");
  assert.equal(storage.data[FAVMOA_STORAGE_KEY], undefined);
  storage.data[FAVMOA_STORAGE_KEY] = { revision: -1, catalog: changedCatalog() };
  assert.equal((await handle({ type: "FAVMOA_GET" }, sender)).code, "CORRUPT_STORAGE");
  assert.equal(storage.data[FAVMOA_STORAGE_KEY].revision, -1);
});

test("storage access restriction failures fail closed", async () => {
  const storage = memoryStorage();
  storage.setAccessLevel = async () => { throw new Error("do not reveal implementation details"); };
  const result = await createCatalogService({ storage, runtimeId: sender.id }).handle({ type: "FAVMOA_GET" }, sender);
  assert.equal(result.code, "STORAGE_UNAVAILABLE");
  assert.equal(result.error.includes("implementation"), false);
});

test("no-op import leaves revision unchanged", async () => {
  const { handle } = service();
  const result = await handle({ type: "FAVMOA_IMPORT_BACKUP", catalog: createCatalog(), expectedRevision: 0 }, sender);
  assert.equal(result.ok, true);
  assert.equal(result.revision, 0);
});

test("current/open tabs exclude unsafe and browser-internal URLs", async () => {
  const { platform } = chromeFixture([
    { id: 1, windowId: 2, active: true, title: "Current", url: "https://example.com/work" },
    { id: 2, windowId: 2, url: "chrome://settings" },
    { id: 3, windowId: 2, url: "javascript:alert(1)" }
  ]);
  assert.equal(platform.mode, "extension");
  assert.equal((await platform.getCurrentPage()).title, "Current");
  assert.equal((await platform.getOpenTabs()).length, 1);
});

test("normal link click focuses matching tab in current window without duplication", async () => {
  const { platform, calls } = chromeFixture([
    { id: 1, windowId: 1, url: "https://example.com/work" },
    { id: 2, windowId: 2, active: true, url: "https://example.com/current" },
    { id: 3, windowId: 2, url: "https://example.com/work" }
  ]);
  const result = await platform.openLink("https://example.com/work");
  assert.equal(result.reused, true);
  assert.equal(result.tabId, 3);
  assert.deepEqual(calls.find(call => call[0] === "update"), ["update", 3, { active: true }]);
  assert.equal(calls.some(call => call[0] === "window"), false);
  assert.equal(calls.some(call => call[0] === "create"), false);
});

test("link opening starts independent tab queries together instead of waiting two response rounds", async () => {
  const { api, platform, calls } = chromeFixture();
  const pendingQueries = [];
  api.tabs.query = query => {
    calls.push(["query", query]);
    return new Promise(resolve => pendingQueries.push(resolve));
  };
  const opening = platform.openLink("https://example.com/new?view=board#summary");
  const firstWaveQueries = calls.filter(call => call[0] === "query");
  // Resolve every request that started before either independent response.
  pendingQueries.splice(0).forEach(resolve => resolve([]));
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  const openedAfterOneRound = calls.some(call => call[0] === "create");
  // Let the pre-fix serial implementation settle too, keeping this test bounded.
  pendingQueries.splice(0).forEach(resolve => resolve([]));
  const result = await opening;
  assert.equal(result.ok, true);
  assert.deepEqual(firstWaveQueries, [["query", { active: true, lastFocusedWindow: true }], ["query", {}]]);
  assert.equal(openedAfterOneRound, true);
  assert.deepEqual(calls.find(call => call[0] === "create"), ["create", { url: "https://example.com/new?view=board#summary" }]);
});

test("ordinary concurrent clicks share one in-flight open and a later click can retry", async () => {
  const { api, platform, calls } = chromeFixture();
  const pendingCreates = [];
  api.tabs.create = options => {
    calls.push(["create", options]);
    return new Promise(resolve => pendingCreates.push(resolve));
  };
  const first = platform.openLink("https://example.com/new");
  const second = platform.openLink("https://example.com/new");
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
  const createCount = calls.filter(call => call[0] === "create").length;
  pendingCreates.splice(0).forEach(resolve => resolve({ id: 123 }));
  assert.deepEqual(await Promise.all([first, second]), [
    { ok: true, reused: false, tabId: 123 }, { ok: true, reused: false, tabId: 123 }
  ]);
  assert.equal(createCount, 1);
  assert.equal(calls.filter(call => call[0] === "query").length, 2);
  api.tabs.create = async () => ({ id: 124 });
  assert.equal((await platform.openLink("https://example.com/new")).tabId, 124);
});

test("only identical ordinary URLs share an open; forced new tabs remain independent", async () => {
  const { api, platform, calls } = chromeFixture();
  api.tabs.create = async options => { calls.push(["create", options]); return { id: calls.length }; };
  const page = "https://app.notion.com/p/sample/0123456789abcdef0123456789abcdef";
  const results = await Promise.all([
    platform.openLink(`${page}?view=one`),
    platform.openLink(`${page}?view=two`),
    platform.openLink(`${page}?view=one`, { newTab: true }),
    platform.openLink(`${page}?view=one`, { newTab: true })
  ]);
  assert.equal(results.every(result => result.ok), true);
  assert.equal(calls.filter(call => call[0] === "create").length, 4);
  assert.deepEqual(calls.filter(call => call[0] === "create").map(call => call[1].url).sort(), [
    `${page}?view=one`, `${page}?view=one`, `${page}?view=one`, `${page}?view=two`
  ]);
  assert.equal(calls.filter(call => call[0] === "query").length, 4);
});

test("cross-window matches still focus their window and active current-window matches take priority", async () => {
  const crossWindow = chromeFixture([
    { id: 1, windowId: 1, active: true, url: "https://example.com/current" },
    { id: 2, windowId: 2, url: "https://example.com/work" }
  ]);
  assert.equal((await crossWindow.platform.openLink("https://example.com/work")).tabId, 2);
  assert.deepEqual(crossWindow.calls.find(call => call[0] === "window"), ["window", 2, { focused: true }]);
  const activeMatch = chromeFixture([
    { id: 1, windowId: 1, url: "https://example.com/work" },
    { id: 2, windowId: 1, active: true, url: "https://example.com/work" }
  ]);
  assert.equal((await activeMatch.platform.openLink("https://example.com/work")).tabId, 2);
});

test("failed in-flight opens are sanitized, clear their pending entry and never open blindly after a query failure", async () => {
  const { api, platform, calls } = chromeFixture();
  api.tabs.query = async () => { throw new Error("private Chrome failure details"); };
  const results = await Promise.all([platform.openLink("https://example.com/work"), platform.openLink("https://example.com/work")]);
  assert.equal(results.every(result => result.code === "OPEN_FAILED" && !result.error.includes("private")), true);
  assert.equal(calls.some(call => call[0] === "create"), false);
  api.tabs.query = async query => {
    if (query.active) return [{ id: 1, windowId: 1, url: "https://example.com/current", active: true }];
    throw new Error("private all-tabs query failure");
  };
  assert.equal((await platform.openLink("https://example.com/work")).code, "OPEN_FAILED");
  assert.equal(calls.some(call => call[0] === "create"), false);
  api.tabs.query = async () => [];
  api.tabs.create = async () => { throw new Error("private create details"); };
  assert.equal((await platform.openLink("https://example.com/work")).code, "OPEN_FAILED");
  api.tabs.create = async () => ({ id: 500 });
  assert.equal((await platform.openLink("https://example.com/work")).tabId, 500);
});

test("explicit new tab bypasses existing matches and unsafe URLs never open", async () => {
  const { platform, calls } = chromeFixture([{ id: 1, windowId: 1, active: true, url: "https://example.com/work" }]);
  const result = await platform.openLink("https://example.com/work", { newTab: true });
  assert.equal(result.reused, false);
  assert.equal(result.tabId, 100);
  assert.equal((await platform.openLink("javascript:alert(1)")).code, "UNSAFE_URL");
  assert.equal(calls.filter(call => call[0] === "create").length, 1);
});

test("current-window matching is preserved even when the active tab is browser-internal", async () => {
  const { platform } = chromeFixture([
    { id: 1, windowId: 1, url: "https://example.com/work" },
    { id: 2, windowId: 2, active: true, url: "chrome://settings" },
    { id: 3, windowId: 2, url: "https://example.com/work" }
  ]);
  assert.equal(await platform.getCurrentPage(), null);
  assert.equal((await platform.openLink("https://example.com/work")).tabId, 3);
});

test("URL identity is used for matching instead of title or hostname alone", async () => {
  const { platform, calls } = chromeFixture([{ id: 1, windowId: 1, active: true, title: "Same", url: "https://example.com/one" }]);
  assert.notEqual(identifyUrl("https://example.com/one").key, identifyUrl("https://example.com/two").key);
  assert.equal((await platform.openLink("https://example.com/two")).reused, false);
  assert.equal(calls.filter(call => call[0] === "create").length, 1);
});

test("bookmark permission is requested only on explicit import and reads no unsafe URLs", async () => {
  const { api, platform, calls } = chromeFixture();
  await platform.load();
  await platform.getOpenTabs();
  assert.equal(calls.some(call => call[0] === "permission"), false);
  api.bookmarks.getTree = async () => [{ title: "", children: [{ title: "Work", children: [{ title: "Spec", url: "https://example.org/spec" }, { title: "Bad", url: "javascript:alert(1)" }] }] }];
  const result = await platform.getBookmarkCandidates();
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates, [{ title: "Spec", url: "https://example.org/spec", folderPath: "Work" }]);
  assert.deepEqual(calls.find(call => call[0] === "permission"), ["permission", { permissions: ["bookmarks"] }]);
});

test("denied bookmark permission does not read the bookmark tree", async () => {
  const { api, platform, calls } = chromeFixture();
  api.permissions.request = async () => false;
  assert.equal((await platform.getBookmarkCandidates()).code, "PERMISSION_DENIED");
  assert.equal(calls.some(call => call[0] === "bookmarks"), false);
});

test("subscription unregisters listeners and rejects malformed state", async () => {
  const { platform, changedListeners } = chromeFixture();
  const received = [];
  const unsubscribe = platform.subscribe(value => received.push(value));
  for (const callback of changedListeners) {
    await callback({ [FAVMOA_STORAGE_KEY]: { newValue: { revision: 1, catalog: createCatalog() } } }, "local");
    await callback({ [FAVMOA_STORAGE_KEY]: { newValue: { revision: 2, catalog: {} } } }, "local");
  }
  assert.equal(received.length, 1);
  unsubscribe();
  assert.equal(changedListeners.size, 0);
});

test("another window's storage change refreshes undo and restore availability from the service", async () => {
  const { api, platform, changedListeners } = chromeFixture();
  const requests = [];
  const current = { ok: true, revision: 1, catalog: changedCatalog(), canUndo: true, hasRestorePoint: true };
  api.runtime.sendMessage = async message => { requests.push(message); return copy(current); };
  const received = [];
  platform.subscribe(value => received.push(value));
  const callback = [...changedListeners][0];
  await callback({ [FAVMOA_STORAGE_KEY]: { newValue: { revision: 1, catalog: current.catalog } } }, "local");
  assert.deepEqual(requests, [{ type: "FAVMOA_GET" }]);
  assert.deepEqual(received, [current]);
  current.revision = 2; current.canUndo = false; current.hasRestorePoint = false;
  await callback({ [FAVMOA_STORAGE_KEY]: { newValue: { revision: 2, catalog: current.catalog } } }, "local");
  assert.deepEqual(received.at(-1), current);
});

test("tab activation, completed navigation and window focus notify and clean up", () => {
  const { api } = chromeFixture();
  const events = [];
  const event = () => {
    const listeners = new Set();
    const result = { addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback), fire: (...args) => listeners.forEach(callback => callback(...args)), listeners };
    events.push(result);
    return result;
  };
  api.tabs.onActivated = event();
  api.tabs.onUpdated = event();
  api.tabs.onRemoved = event();
  api.windows.onFocusChanged = event();
  const platform = createPlatform({ chrome: api, location: { protocol: "chrome-extension:", hostname: sender.id } });
  const received = [];
  const unsubscribe = platform.subscribe(value => received.push(value));
  api.tabs.onActivated.fire({ tabId: 1 });
  api.tabs.onUpdated.fire(1, { url: "https://example.com/new" });
  api.tabs.onUpdated.fire(1, { status: "complete" });
  api.tabs.onUpdated.fire(1, { status: "loading" });
  api.tabs.onRemoved.fire(1);
  api.windows.onFocusChanged.fire(-1);
  api.windows.onFocusChanged.fire(2);
  assert.equal(received.length, 5);
  assert.equal(received.every(value => value.type === "tabs-changed"), true);
  unsubscribe();
  assert.equal(events.every(value => value.listeners.size === 0), true);
});

test("demo is loopback-only, explicitly synthetic and persists separately", async () => {
  assert.throws(() => createPlatform({ chrome: undefined, location: { hostname: "example.com", protocol: "https:" } }), /로컬/);
  const values = new Map();
  const localStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const platform = createPlatform({ chrome: undefined, location: { hostname: "127.0.0.1", protocol: "http:" }, localStorage });
  assert.equal(platform.mode, "demo");
  assert.match((await platform.getCurrentPage()).title, /데모/);
  const result = await platform.importBackup(changedCatalog("데모 링크"), 0);
  assert.equal(result.ok, true);
  assert.deepEqual([...values.keys()], ["favmoa:demo:v1"]);
  const another = createPlatform({ chrome: undefined, location: { hostname: "localhost", protocol: "http:" }, localStorage });
  assert.equal((await another.load()).catalog.libraries[0].name, "데모 링크");
});

test("platform demo loads old v1 read-only and checkpoints it inside the same local value on first edit", async () => {
  const oldCatalog = { schemaVersion: 1, libraries: [{ id: "library-personal", name: "Old demo", groups: [
    { id: "old-group", name: "Old group", collapsed: true, sections: [
      { id: "old-section", name: "Named section", collapsed: true, links: [] }
    ] }
  ] }], migratedLegacyKeys: [] };
  const rawEnvelope = { revision: 4, catalog: oldCatalog };
  const values = new Map([["favmoa:demo:v1", JSON.stringify({ [FAVMOA_STORAGE_KEY]: rawEnvelope })]]);
  const before = values.get("favmoa:demo:v1");
  let writes = 0;
  const localStorage = { getItem: key => values.get(key), setItem: (key, value) => { writes += 1; values.set(key, value); } };
  const platform = createPlatform({ chrome: undefined, location: { hostname: "127.0.0.1", protocol: "http:" }, localStorage });
  const loaded = await platform.load();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.catalog.schemaVersion, 2);
  assert.equal(loaded.catalog.libraries[0].groups[0].groups[0].name, "Named section");
  assert.equal(values.get("favmoa:demo:v1"), before);
  assert.equal(writes, 0);
  const edited = await platform.dispatch({ type: "renameLibrary", libraryId: "library-personal", name: "New demo" }, 4);
  assert.equal(edited.ok, true);
  assert.equal(writes, 1);
  const saved = JSON.parse(values.get("favmoa:demo:v1"));
  assert.equal(saved[FAVMOA_STORAGE_KEY].catalog.schemaVersion, 2);
  assert.deepEqual(saved[FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY].storage[FAVMOA_STORAGE_KEY], rawEnvelope);
});
