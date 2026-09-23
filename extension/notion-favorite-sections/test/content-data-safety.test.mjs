import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sources = await Promise.all([
  "favorite-tree-model.js", "profile-catalog.js", "content.js", "favorite-tree-view.js", "notion-url.js"
].map((name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8")));
const PAGE_A = "0123456789abcdef0123456789abcdef";
const PAGE_B = "fedcba9876543210fedcba9876543210";
const PAGE_C = "11111111111111111111111111111111";
const KEY = "workspace:id:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SLUG_KEY = "workspace:slug:acme";
const copy = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// The real content controller and model run in their own VM realm. The browser
// boundary is supplied by fakes so GET/SET can be paused at real async seams.
async function harness({
  seed, key = KEY, slugKey = SLUG_KEY, primarySafe = true,
  pageIds = [PAGE_A, PAGE_B], activePageId = null, sourceSafe = true,
  favoriteMetadata = {}, realView = false, metadataRecords = new Map(), metadataError = false,
  workspaceSync = false,
  pageNavigation = { currentPage: null, roots: [], renderedOnly: true, scopeSafe: true, reason: "" }
} = {}) {
  const records = new Map();
  const messages = [];
  const timers = new Map();
  const intervals = new Map();
  const listeners = new Map();
  const ui = { value: null, initialValue: null, callbacks: null, announcements: [], mounts: 0 };
  const native = {
    pageIds, safe: sourceSafe, key, slugKey, primarySafe, activePageId, favoriteMetadata,
    pageNavigation, navigationError: null, metadataError,
    href: `https://www.notion.so/${activePageId || PAGE_A}`
  };
  let timerId = 0;
  let observerCallback;
  let observerOptions;
  let beforeGet = null;
  let beforeSet = null;
  let onWorkspaceSync;

  // Small DOM boundary for exercising the actual renderer as well as the
  // controller. Assertions walk rendered nodes; no title logic is duplicated.
  const element = (tagName = "div") => {
    const attributes = new Map();
    const node = {
      tagName: tagName.toUpperCase(), isConnected: true, children: [],
      className: "", textContent: "", style: { setProperty() {} },
      get ownerDocument() { return document; },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      hasAttribute(name) { return attributes.has(name); },
      removeAttribute(name) { attributes.delete(name); },
      addEventListener() {}, removeEventListener() {},
      contains(candidate) { return candidate === this || this.children.some((child) => child.contains?.(candidate)); },
      remove() { this.isConnected = false; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      append(...children) {
        for (const child of children) {
          if (child.tagName === "#FRAGMENT") this.append(...child.children);
          else { child.parentElement = this; this.children.push(child); }
        }
      },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      attachShadow() { this.shadowRoot = element("#shadow-root"); return this.shadowRoot; }
    };
    node.classList = {
      contains(name) { return node.className.split(/\s+/u).includes(name); },
      add(name) { node.className += ` ${name}`; },
      remove() {}, toggle() {}
    };
    return node;
  };
  const root = element();
  const document = {
    documentElement: root,
    body: root,
    visibilityState: "visible",
    querySelectorAll() { return []; },
    createElement: element,
    createElementNS(_namespace, name) { return element(name); },
    createDocumentFragment() { return element("#fragment"); },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {}, removeEventListener() {}
  };
  const inspection = {
    scopeSafe: true, sidebarRoot: root, container: element(),
    inboxWrapper: element(), inboxItem: element(), contentSurface: element(),
    selectedNativeTab: element(), nativeTabpanel: element()
  };
  const context = vm.createContext({
    document, URL, console: { warn() {} },
    location: { get href() { return native.href; } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { intervals.set(++timerId, callback); return timerId; },
    clearInterval(id) { intervals.delete(id); },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe(_root, options) { observerOptions = options; }
      disconnect() {}
    },
    chrome: { runtime: {
      ...(workspaceSync ? { connect() { return {
        onMessage: { addListener(callback) { onWorkspaceSync = callback; } },
        onDisconnect: { addListener() {} }, disconnect() {}
      }; } } : {}),
      async sendMessage(message) {
        messages.push(copy(message));
        if (message.type === "NFS_PROFILE_CATALOG_GET") return { ok: true, revision: 0 };
        const workspaceKey = message.payload.workspaceKey;
        if (message.type === "NFS_METADATA_GET" || message.type === "NFS_METADATA_MERGE") {
          if (native.metadataError) return { ok: false, error: "Metadata cache is unavailable" };
          const managedIds = new Set(favorites(records.get(workspaceKey)?.workspace || { groups: [] })
            .map((favorite) => favorite.pageId));
          const metadata = new Map((metadataRecords.get(workspaceKey) || [])
            .filter((entry) => managedIds.has(entry.pageId)).map((entry) => [entry.pageId, entry]));
          if (message.type === "NFS_METADATA_MERGE") {
            for (const entry of message.payload.entries) {
              if (managedIds.has(entry.pageId)) metadata.set(entry.pageId, copy(entry));
            }
            metadataRecords.set(workspaceKey, [...metadata.values()]);
          }
          return { ok: true, metadata: copy([...metadata.values()]) };
        }
        if (message.type === "NFS_STORAGE_GET") {
          if (beforeGet) {
            const hook = beforeGet;
            beforeGet = null;
            await hook();
          }
          const record = records.get(workspaceKey);
          return { ok: true, revision: record?.revision || 0,
            ...(record ? { workspace: copy(record.workspace) } : {}) };
        }
        if (message.type === "NFS_STORAGE_SET") {
          if (beforeSet) {
            const hook = beforeSet;
            beforeSet = null;
            await hook();
          }
          const record = records.get(workspaceKey);
          if ((record?.revision || 0) !== message.payload.expectedRevision) {
            return { ok: false, conflict: true, revision: record.revision,
              workspace: copy(record.workspace), error: "conflict" };
          }
          const next = { workspace: copy(message.payload.workspace), revision: (record?.revision || 0) + 1 };
          records.set(workspaceKey, next);
          return { ok: true, ...copy(next) };
        }
        throw new Error(`Unexpected message ${message.type}`);
      }
    } }
  });
  vm.runInContext(sources[4], context);
  vm.runInContext(sources[0], context);
  vm.runInContext(sources[1], context);
  const namespace = context.NotionFavoriteSections;
  const model = namespace.model;
  if (seed) records.set(key, { workspace: copy(seed(model)), revision: 1 });
  namespace.adapter = {
    normalizePageId: (id) => /^[a-f0-9]{32}$/u.test(id || "") ? id : null,
    deriveWorkspaceKey: () => native.key,
    deriveWorkspaceIdentity: () => ({ key: native.key, slugKey: native.slugKey }),
    activePageId: () => native.activePageId,
    readPageNavigation: () => {
      if (native.navigationError) throw native.navigationError;
      return copy(native.pageNavigation);
    },
    inspectFavoritesSection: () => ({
      section: root, inSidebar: true, scopeSafe: native.safe,
      topLevelSafe: native.safe, confidence: 1, favoriteCount: native.pageIds.length
    }),
    readFavorites: () => native.pageIds.map((pageId) => ({ pageId, title: pageId, ...native.favoriteMetadata[pageId] })),
    inspectPrimaryNavigation: () => native.primarySafe ? inspection : null,
    mountPrimaryNavigationHost: (i, host) => {
      host.parentElement = i.container; host.previousElementSibling = i.inboxWrapper;
      return host;
    },
    mountPrimaryNavigationViewHost: (i, host) => {
      host.parentElement = i.contentSurface; return host;
    },
    restorePrimaryNavigation(host) { host?.remove(); },
    restorePrimaryNavigationView(host) { host?.remove(); }
  };
  namespace.panel = { createPanelShell({ viewHost }) {
    return { contentHost: element(), overlayHost: viewHost, destroy() {} };
  } };
  let actualView;
  if (realView) {
    vm.runInContext(sources[3], context);
    actualView = namespace.view;
  }
  namespace.view = { createFavoriteTreeView(options) {
    ui.mounts += 1; ui.callbacks = options.callbacks; ui.value = options; ui.initialValue = options;
    const rendered = actualView?.createFavoriteTreeView(options);
    ui.shadowRoot = rendered?.shadowRoot;
    return { update(value) { ui.value = { ...ui.value, ...value }; rendered?.update(value); },
      announce(value) { ui.announcements.push(value); rendered?.announce(value); },
      destroy() { rendered?.destroy(); } };
  } };
  vm.runInContext(sources[2], context);
  await namespace.content.refresh();
  timers.clear();
  return {
    model, native, records, ui, messages, namespace, document, metadataRecords,
    get observedAttributes() { return observerOptions.attributeFilter; },
    get writes() { return messages.filter(({ type }) => type === "NFS_STORAGE_SET"); },
    get metadataWrites() { return messages.filter(({ type }) => type === "NFS_METADATA_MERGE"); },
    get stored() { return records.get(ui.value.workspaceKey); },
    holdGet() {
      const entered = deferred(); const release = deferred();
      beforeGet = async () => { entered.resolve(); await release.promise; };
      return { entered: entered.promise, release: release.resolve };
    },
    holdSet() {
      const entered = deferred(); const release = deferred();
      beforeSet = async () => { entered.resolve(); await release.promise; };
      return { entered: entered.promise, release: release.resolve };
    },
    writeFromOtherTab(workspace, workspaceKey = ui.value.workspaceKey) {
      const old = records.get(workspaceKey);
      records.set(workspaceKey, { workspace: copy(workspace), revision: (old?.revision || 0) + 1 });
    },
    async syncFromOtherTab(workspace, workspaceKey = ui.value.workspaceKey) {
      const revision = (records.get(workspaceKey)?.revision || 0) + 1;
      records.set(workspaceKey, { workspace: copy(workspace), revision });
      assert.ok(onWorkspaceSync, "the workspace synchronization port is connected");
      onWorkspaceSync({ type: "NFS_STORAGE_CHANGED", payload: { workspaceKey, workspace: copy(workspace), revision } });
      await namespace.content.refresh();
    },
    async refresh() { await namespace.content.refresh(); },
    async pollRoute() {
      for (const callback of intervals.values()) callback();
      const pending = [...timers.values()]; timers.clear();
      for (const callback of pending) callback();
      if (pending.length) await namespace.content.refresh();
      return pending.length;
    },
    async dispatch(type) {
      for (const callback of listeners.get(type) || []) callback({ type });
      const pending = [...timers.values()]; timers.clear();
      for (const callback of pending) callback();
      // Refresh joins the controller's queue, so the scheduled refresh has
      // completed before assertions inspect the view. The returned count
      // verifies that the event itself scheduled work, without a DOM mutation.
      if (pending.length) await namespace.content.refresh();
      return pending.length;
    },
    async notify(mutation) {
      observerCallback([mutation]);
      const pending = [...timers.values()]; timers.clear();
      for (const callback of pending) callback();
      if (pending.length) await namespace.content.refresh();
      return pending.length;
    }
  };
}

const withFavorite = (model) => model.addFavorite(model.createWorkspace(), PAGE_A);
const withGroup = (model) => model.createGroup(withFavorite(model), { id: "work", name: "업무" });
const favorites = (workspace) => workspace.groups.flatMap((group) =>
  group.sections.flatMap((section) => section.favorites));

function pageNode(pageId, title, children = []) {
  return { pageId, title, href: `https://www.notion.so/${pageId}`, icon: "📄", children };
}

function navigationFor(currentPage, roots = [currentPage]) {
  return { currentPage, roots, renderedOnly: true, scopeSafe: true, reason: "rendered-only" };
}

function renderedNode(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root?.children || []) {
    const found = renderedNode(child, predicate);
    if (found) return found;
  }
  return null;
}

function renderedFavorite(h, pageId) {
  const row = renderedNode(h.ui.shadowRoot, (node) =>
    node?.classList?.contains("nfs-favorite") && node.getAttribute("data-page-id") === pageId);
  assert.ok(row, `saved Favorite ${pageId} remains rendered`);
  return {
    title: renderedNode(row, (node) => node?.classList?.contains("nfs-favorite-title"))?.textContent,
    href: renderedNode(row, (node) => node?.classList?.contains("nfs-favorite-link"))?.getAttribute("href")
  };
}

test("managed Favorite titles and links survive a collapsed or unmounted source", async () => {
  const title = "영업 시스템 로드맵";
  const href = `https://app.notion.com/${PAGE_A}`;
  const h = await harness({ seed: withGroup, realView: true, pageIds: [PAGE_A],
    favoriteMetadata: { [PAGE_A]: { title, href, iconText: "📘" } } });
  const storedBefore = copy(h.stored);
  assert.deepEqual(renderedFavorite(h, PAGE_A), { title, href });
  h.native.safe = false;
  h.native.pageIds = [];
  await h.refresh();
  assert.equal(h.ui.value.importPreview.canManage, false);
  assert.equal(h.ui.value.importPreview.sourceCount, 0);
  assert.deepEqual(copy(h.ui.value.favorites), [], "display metadata must not become source candidates");
  assert.throws(() => h.ui.callbacks.onAddFavorites([PAGE_A], h.model.getSystemSectionId("work")),
    /현재 Notion 즐겨찾기에서 확인할 수 없습니다/u);
  assert.deepEqual(h.stored, storedBefore);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(renderedFavorite(h, PAGE_A), { title, href });
});

test("managed Favorite titles survive a partially rendered source without enlarging candidates", async () => {
  const title = "현재 숨겨진 즐겨찾기";
  const h = await harness({ seed: (model) => model.addFavorite(withFavorite(model), PAGE_B),
    realView: true, favoriteMetadata: { [PAGE_A]: { title, href: `https://app.notion.com/${PAGE_A}` } } });
  const storedBefore = copy(h.stored);
  assert.equal(renderedFavorite(h, PAGE_A).title, title);
  h.native.pageIds = [PAGE_B];
  await h.refresh();
  assert.equal(h.ui.value.importPreview.sourceCount, 1);
  assert.deepEqual(copy(h.ui.value.favorites).map((favorite) => favorite.pageId), [PAGE_B]);
  assert.deepEqual(h.stored, storedBefore);
  assert.equal(h.writes.length, 0);
  assert.equal(renderedFavorite(h, PAGE_A).title, title);
});

test("a cold start without loaded page metadata preserves saved references without inventing titles", async () => {
  const h = await harness({ seed: withGroup, realView: true, pageIds: [], sourceSafe: false });
  assert.deepEqual(favorites(h.stored.workspace).map((favorite) => favorite.pageId), [PAGE_A]);
  assert.equal(h.ui.value.importPreview.canManage, false);
  assert.equal(h.ui.value.importPreview.sourceCount, 0);
  assert.match(renderedFavorite(h, PAGE_A).title, new RegExp(PAGE_A.slice(-6), "u"));
  assert.equal(renderedFavorite(h, PAGE_A).href, null,
    "a saved page ID alone must not fabricate an unknown page route");
  await assert.rejects(h.ui.callbacks.onRefreshManagedFavorites(), /안전하게 확인하지 못해/u);
  assert.equal(h.writes.length, 0);
});

test("known managed titles survive a fresh controller when the source starts collapsed", async () => {
  const title = "새 탭에서도 읽을 수 있는 제목";
  const first = await harness({ seed: withFavorite, realView: true, pageIds: [PAGE_A],
    favoriteMetadata: { [PAGE_A]: { title, href: `https://app.notion.com/${PAGE_A}`, iconText: "📚" } } });
  const restarted = await harness({ seed: () => first.stored.workspace,
    metadataRecords: first.metadataRecords, realView: true, sourceSafe: false, pageIds: [] });
  assert.deepEqual(renderedFavorite(restarted, PAGE_A), { title, href: `https://app.notion.com/${PAGE_A}` });
  assert.equal(restarted.ui.value.importPreview.canManage, false);
  assert.equal(restarted.ui.value.importPreview.sourceCount, 0);
  assert.equal(first.writes.length + restarted.writes.length, 0,
    "display metadata does not change the saved tree or its revision");
  for (const entry of first.metadataRecords.get(KEY) || []) {
    assert.deepEqual(Object.keys(entry).sort(), ["href", "icon", "pageId", "title"]);
  }
});

test("observed managed routes survive a collapsed-source restart without becoming import candidates", async () => {
  const title = "워크스페이스 경로가 있는 문서";
  const href = `https://app.notion.com/p/another-workspace/${PAGE_A}?pvs=4#notes`;
  const first = await harness({ seed: withFavorite, pageIds: [PAGE_A],
    favoriteMetadata: { [PAGE_A]: { title, href, iconText: "📚" } } });
  assert.equal(first.metadataRecords.get(KEY)[0].href, href);
  const restarted = await harness({ seed: () => first.stored.workspace,
    metadataRecords: first.metadataRecords, sourceSafe: false, pageIds: [] });
  assert.equal(restarted.ui.value.favoriteMetadata[0].href, href);
  assert.deepEqual(copy(restarted.ui.value.favorites), []);
  assert.equal(restarted.ui.value.importPreview.canManage, false);
  assert.equal(first.writes.length + restarted.writes.length, 0);
  assert.equal(restarted.stored.revision, first.stored.revision);
});

test("actual current-page route wins stale native metadata and survives later partial refreshes", async () => {
  const href = `https://app.notion.com/p/current-workspace/${PAGE_A}?pvs=4#notes`;
  const currentPage = { ...pageNode(PAGE_A, "Current title"), href };
  const h = await harness({ seed: withFavorite, pageIds: [PAGE_A], activePageId: PAGE_A,
    favoriteMetadata: { [PAGE_A]: { title: "Old native title", href: `https://app.notion.com/p/old-workspace/${PAGE_A}` } },
    pageNavigation: navigationFor(currentPage) });
  h.native.href = href;
  await h.refresh();
  assert.equal(h.metadataRecords.get(KEY)[0].href, href);
  assert.equal(h.metadataRecords.get(KEY)[0].title, "Current title");
  h.native.pageNavigation = { currentPage: null, roots: [], renderedOnly: true, scopeSafe: false, reason: "collapsed" };
  h.native.favoriteMetadata[PAGE_A] = { title: "Updated native title", href: `https://app.notion.com/${PAGE_A}` };
  await h.refresh();
  assert.equal(h.metadataRecords.get(KEY)[0].href, href);
  h.native.favoriteMetadata[PAGE_A] = { title: "Title only" };
  await h.refresh();
  assert.equal(h.metadataRecords.get(KEY)[0].href, href);
  assert.equal(h.metadataRecords.get(KEY)[0].title, "Title only");
  assert.equal(h.writes.length, 0);
});

test("a title-less current page can refresh its observed route without erasing a known managed title", async () => {
  const previousHref = `https://app.notion.com/p/old-workspace/${PAGE_A}`;
  const href = `https://app.notion.com/p/renamed-workspace/${PAGE_A}`;
  const h = await harness({ seed: withFavorite, pageIds: [PAGE_A], activePageId: PAGE_A,
    favoriteMetadata: { [PAGE_A]: { title: "Known title", href: previousHref, icon: "📘" } } });
  h.native.href = href;
  h.native.pageIds = [];
  h.native.safe = false;
  h.native.pageNavigation = navigationFor({ ...pageNode(PAGE_A, "현재 열린 페이지"), href, icon: null });
  await h.refresh();
  assert.deepEqual(h.metadataRecords.get(KEY), [{ pageId: PAGE_A, title: "Known title", icon: "📘", href }]);
  assert.equal(h.writes.length, 0);
});

test("loading another tab's cached route upgrades an in-memory title-only entry", async () => {
  const h = await harness({ seed: withFavorite, pageIds: [PAGE_A], workspaceSync: true,
    favoriteMetadata: { [PAGE_A]: { title: "Live title" } } });
  const href = `https://app.notion.com/p/known-workspace/${PAGE_A}`;
  h.metadataRecords.set(KEY, [{ pageId: PAGE_A, title: "Cached title", icon: "", href }]);
  h.native.pageIds = [];
  h.native.safe = false;
  await h.syncFromOtherTab(withFavorite(h.model));
  assert.equal(h.ui.value.favoriteMetadata[0].href, href);
  assert.equal(h.ui.value.favoriteMetadata[0].title, "Live title");
  assert.equal(h.writes.length, 0);
});

test("managed title cache never leaks a previous workspace title for the same page ID", async () => {
  const title = "이전 워크스페이스에서만 본 제목";
  const href = `https://app.notion.com/p/previous-workspace/${PAGE_A}`;
  const h = await harness({ seed: withFavorite, realView: true, pageIds: [PAGE_A],
    favoriteMetadata: { [PAGE_A]: { title, href } } });
  assert.equal(renderedFavorite(h, PAGE_A).title, title);
  const otherKey = "workspace:id:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  h.records.set(otherKey, { workspace: copy(withFavorite(h.model)), revision: 1 });
  h.native.key = otherKey;
  h.native.slugKey = "workspace:slug:other";
  h.native.safe = false;
  h.native.pageIds = [];
  await h.refresh();
  assert.notEqual(renderedFavorite(h, PAGE_A).title, title);
  assert.notEqual(renderedFavorite(h, PAGE_A).href, href);
  assert.equal(h.ui.value.favoriteMetadata.some(entry => entry.href === href), false);
  assert.equal(h.ui.value.importPreview.canManage, false);
  assert.equal(h.writes.length, 0);
});

test("old saved references recover their titles when the original source becomes visible", async () => {
  const title = "나중에 확인한 실제 제목";
  const h = await harness({ seed: withFavorite, realView: true, pageIds: [], sourceSafe: false });
  const storedBefore = copy(h.stored);
  assert.notEqual(renderedFavorite(h, PAGE_A).title, title);
  h.native.safe = true;
  h.native.pageIds = [PAGE_A];
  h.native.favoriteMetadata = { [PAGE_A]: { title, href: `https://app.notion.com/${PAGE_A}` } };
  await h.refresh();
  assert.equal(renderedFavorite(h, PAGE_A).title, title);
  h.native.safe = false;
  h.native.pageIds = [];
  await h.refresh();
  assert.equal(renderedFavorite(h, PAGE_A).title, title);
  assert.deepEqual(h.stored, storedBefore);
  assert.equal(h.writes.length, 0);
});

test("metadata cache failures preserve saved structure and in-tab title recovery", async () => {
  const title = "캐시 장애 중 확인한 제목";
  const h = await harness({ seed: withGroup, realView: true, pageIds: [PAGE_A], metadataError: true,
    favoriteMetadata: { [PAGE_A]: { title, href: `https://app.notion.com/${PAGE_A}` } } });
  const storedBefore = copy(h.stored);
  assert.equal(renderedFavorite(h, PAGE_A).title, title);
  h.native.safe = false;
  h.native.pageIds = [];
  await h.refresh();
  assert.equal(renderedFavorite(h, PAGE_A).title, title);
  assert.deepEqual(h.stored, storedBefore);
  assert.equal(h.ui.value.importPreview.canReset, true);
  assert.equal(h.writes.length, 0);
});

test("display cache stores only explicitly managed Favorites, not unselected source pages", async () => {
  const h = await harness({ seed: withFavorite, realView: true,
    favoriteMetadata: { [PAGE_A]: { title: "관리하는 페이지" }, [PAGE_B]: { title: "선택하지 않은 페이지" } } });
  assert.ok(h.metadataWrites.length > 0, "the managed title is cached");
  for (const message of h.metadataWrites) {
    assert.deepEqual(message.payload.entries.map((entry) => entry.pageId), [PAGE_A]);
  }
  assert.deepEqual((h.metadataRecords.get(KEY) || []).map((entry) => entry.pageId), [PAGE_A]);
  assert.equal(h.writes.length, 0);
});

test("a title cached after another tab's tree broadcast is recovered on the next refresh", async () => {
  const h = await harness({ realView: true, workspaceSync: true, pageIds: [], sourceSafe: false });
  const title = "다른 탭에서 추가한 페이지";
  // A tree SET broadcasts before the writer's subsequent metadata MERGE.
  // This tab can legitimately read an empty cache when it receives the tree.
  await h.syncFromOtherTab(withFavorite(h.model));
  assert.notEqual(renderedFavorite(h, PAGE_A).title, title);
  h.metadataRecords.set(KEY, [{ pageId: PAGE_A, title, icon: "" }]);
  await h.refresh();
  assert.equal(renderedFavorite(h, PAGE_A).title, title);
  assert.equal(h.ui.value.importPreview.canManage, false);
  assert.equal(h.ui.value.importPreview.sourceCount, 0);
  assert.equal(h.writes.length, 0);
});

test("page navigation reaches the first view even when the open page is not a Favorite", async () => {
  const child = pageNode(PAGE_C, "하위 페이지");
  const currentPage = pageNode(PAGE_B, "열린 페이지", [child]);
  const pageNavigation = navigationFor(currentPage);
  const h = await harness({ seed: withFavorite, pageIds: [PAGE_A], activePageId: PAGE_B, pageNavigation });
  assert.deepEqual(copy(h.ui.initialValue.pageNavigation), pageNavigation);
  assert.deepEqual(copy(h.ui.value.pageNavigation), pageNavigation);
  assert.equal(h.ui.value.activePageId, PAGE_B);
  assert.equal(h.ui.mounts, 1);
  assert.equal(h.writes.length, 0);
});

test("page navigation refresh replaces the current page and tree without a storage write", async () => {
  const first = navigationFor(pageNode(PAGE_B, "이전 페이지"));
  const h = await harness({ seed: withFavorite, pageIds: [PAGE_A], activePageId: PAGE_B, pageNavigation: first });
  const storedBefore = copy(h.stored);
  const next = navigationFor(pageNode(PAGE_C, "다음 페이지"));
  h.native.activePageId = PAGE_C;
  h.native.pageNavigation = next;
  await h.refresh();
  assert.deepEqual(copy(h.ui.value.pageNavigation), next);
  assert.equal(h.ui.value.activePageId, PAGE_C);
  assert.equal(h.ui.mounts, 1, "navigation updates the existing view");
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.stored, storedBefore);
});

test("workspace changes discard the previous workspace's read-only page navigation", async () => {
  const previous = navigationFor(pageNode(PAGE_B, "이전 워크스페이스 전용 제목"));
  const h = await harness({ seed: withFavorite, pageIds: [PAGE_A], activePageId: PAGE_B, pageNavigation: previous });
  const previousRecord = copy(h.records.get(KEY));
  h.native.key = "workspace:id:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  h.native.slugKey = "workspace:slug:other";
  h.native.activePageId = PAGE_C;
  h.native.pageNavigation = navigationFor(pageNode(PAGE_C, "새 워크스페이스 페이지"));
  await h.refresh();
  assert.equal(h.ui.value.workspaceKey, h.native.key);
  assert.deepEqual(copy(h.ui.value.pageNavigation), h.native.pageNavigation);
  assert.equal(JSON.stringify(h.ui.value.pageNavigation).includes("이전 워크스페이스 전용 제목"), false);
  assert.deepEqual(h.records.get(KEY), previousRecord);
  assert.equal(h.records.has(h.native.key), false);
  assert.equal(h.writes.length, 0);
});

test("page navigation read errors clear stale page metadata and preserve saved Favorites", async () => {
  const h = await harness({
    seed: withFavorite, pageIds: [PAGE_A], activePageId: PAGE_B,
    pageNavigation: navigationFor(pageNode(PAGE_B, "숨겨져야 하는 이전 페이지"))
  });
  const storedBefore = copy(h.stored);
  h.native.navigationError = new Error("Notion page DOM is unavailable");
  await h.refresh();
  assert.equal(h.ui.value.pageNavigation.currentPage, null);
  assert.deepEqual(copy(h.ui.value.pageNavigation.roots), []);
  assert.equal(h.ui.value.pageNavigation.scopeSafe, false);
  assert.equal(h.ui.value.pageNavigation.renderedOnly, true);
  assert.deepEqual(h.stored, storedBefore);
  assert.equal(favorites(h.ui.value.workspace).length, 1);
  assert.equal(favorites(h.ui.value.workspace)[0].pageId, PAGE_A);
  assert.equal(h.writes.length, 0);
});

test("reading current and child pages never imports them into the Favorite source or saved tree", async () => {
  const h = await harness({
    seed: withFavorite, pageIds: [PAGE_A], activePageId: PAGE_B,
    pageNavigation: navigationFor(pageNode(PAGE_B, "열린 페이지", [pageNode(PAGE_C, "하위 페이지")]))
  });
  await h.refresh();
  await h.refresh();
  assert.deepEqual(copy(h.ui.value.favorites).map((favorite) => favorite.pageId), [PAGE_A]);
  assert.deepEqual(favorites(h.stored.workspace).map((favorite) => favorite.pageId), [PAGE_A]);
  assert.deepEqual(copy(favorites(h.ui.value.workspace)).map((favorite) => favorite.pageId), [PAGE_A]);
  assert.equal(h.ui.value.importPreview.sourceCount, 1);
  assert.equal(h.ui.value.importPreview.availableCount, 0);
  assert.equal(h.writes.length, 0);
});

test("a route-only popstate refreshes page navigation without a sidebar mutation or storage write", async () => {
  const h = await harness({
    seed: withFavorite, pageIds: [PAGE_A], activePageId: PAGE_B,
    pageNavigation: navigationFor(pageNode(PAGE_B, "이전 경로"))
  });
  h.native.activePageId = PAGE_C;
  h.native.pageNavigation = navigationFor(pageNode(PAGE_C, "현재 경로"));
  const scheduled = await h.dispatch("popstate");
  assert.equal(scheduled, 1);
  assert.equal(h.ui.value.activePageId, PAGE_C);
  assert.deepEqual(copy(h.ui.value.pageNavigation), h.native.pageNavigation);
  assert.equal(h.writes.length, 0);
});

test("route polling refreshes only a changed visible URL and does not write Favorites", async () => {
  const h = await harness({
    seed: withFavorite, pageIds: [PAGE_A], activePageId: PAGE_B,
    pageNavigation: navigationFor(pageNode(PAGE_B, "이전 URL"))
  });
  assert.equal(await h.pollRoute(), 0, "an unchanged URL does not schedule a scan");
  h.native.activePageId = PAGE_C;
  h.native.href = `https://www.notion.so/${PAGE_C}`;
  h.native.pageNavigation = navigationFor(pageNode(PAGE_C, "새 URL"));
  h.document.visibilityState = "hidden";
  assert.equal(await h.pollRoute(), 0, "background tabs defer scanning");
  assert.equal(h.ui.value.activePageId, PAGE_B);
  h.document.visibilityState = "visible";
  assert.equal(await h.pollRoute(), 1, "the changed URL is scanned when visible");
  assert.deepEqual(copy(h.ui.value.pageNavigation), h.native.pageNavigation);
  assert.equal(h.ui.value.activePageId, PAGE_C);
  assert.equal(await h.pollRoute(), 0, "the same URL is not scanned on every tick");
  assert.equal(h.writes.length, 0);
});

test("reset refuses changes written by another tab before its GET returns", async () => {
  const h = await harness({ seed: withFavorite });
  const observed = h.ui.value.workspaceRevision;
  const gate = h.holdGet();
  const request = h.ui.callbacks.onResetTree({ expectedRevision: observed, workspaceKey: KEY });
  await gate.entered;
  const newer = h.model.createGroup(h.stored.workspace, { name: "다른 탭의 그룹" });
  h.writeFromOtherTab(newer);
  gate.release();
  await assert.rejects(request, /확인하는 동안/u);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.stored.workspace, copy(newer));
  assert.equal(h.ui.value.workspaceRevision, 2);
});

test("confirmation revision protects group and section deletion and Favorite removal", async () => {
  for (const operation of ["group", "section", "favorite"]) {
    const h = await harness({ seed: (model) => model.createSection(withGroup(model), "work", { id: "project", name: "프로젝트" }) });
    const confirmed = { expectedRevision: 1, workspaceKey: KEY };
    h.writeFromOtherTab(h.model.renameGroup(h.stored.workspace, "work", "변경된 그룹"));
    const request = operation === "group" ? h.ui.callbacks.onDeleteGroup("work", confirmed)
      : operation === "section" ? h.ui.callbacks.onDeleteSection("project", confirmed)
      : h.ui.callbacks.onRemoveFavorite(PAGE_A, confirmed);
    await assert.rejects(request, /확인하는 동안/u);
    assert.equal(h.writes.length, 0, operation);
  }
});

test("an old confirmation cannot reset a new workspace with the same revision", async () => {
  const h = await harness({ seed: withFavorite });
  const confirmed = { expectedRevision: 1, workspaceKey: KEY };
  h.native.key = "workspace:id:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  h.native.slugKey = "workspace:slug:other";
  h.records.set(h.native.key, { workspace: copy(withGroup(h.model)), revision: 1 });
  await h.refresh();
  await assert.rejects(h.ui.callbacks.onResetTree(confirmed), /워크스페이스가 변경/u);
  assert.equal(h.writes.length, 0);
});

test("source changes while storage GET waits are detected without an observer refresh", async () => {
  const h = await harness();
  const gate = h.holdGet();
  const sectionId = h.model.getSystemSectionId(h.model.SYSTEM_GROUP_ID);
  const request = h.ui.callbacks.onAddFavorites([PAGE_A], sectionId);
  await gate.entered;
  h.native.pageIds = [PAGE_B];
  gate.release();
  await assert.rejects(request, /즐겨찾기 목록이 변경/u);
  assert.equal(h.writes.length, 0);
});

test("a successful add remains successful if the source changes after SET begins", async () => {
  const h = await harness();
  const gate = h.holdSet();
  const sectionId = h.model.getSystemSectionId(h.model.SYSTEM_GROUP_ID);
  const request = h.ui.callbacks.onAddFavorites([PAGE_A], sectionId);
  await gate.entered;
  h.native.pageIds = [PAGE_B];
  gate.release();
  const result = await request;
  assert.equal(result.addedCount, 1);
  assert.equal(favorites(h.stored.workspace)[0].pageId, PAGE_A);
});

test("refresh preserves managed Favorites missing from a partially rendered source", async () => {
  const h = await harness({ seed: (model) => model.addFavorite(withFavorite(model), PAGE_B) });
  h.native.pageIds = [PAGE_B];
  await h.ui.callbacks.onRefreshManagedFavorites();
  assert.equal(favorites(h.stored.workspace).length, 2);
  assert.equal(favorites(h.stored.workspace).some((favorite) => favorite.dormant), false);
});

test("a collapsed or unmounted source cannot refresh or hide existing items", async () => {
  const h = await harness({ seed: withFavorite });
  h.native.safe = false;
  h.native.pageIds = [];
  await assert.rejects(h.ui.callbacks.onRefreshManagedFavorites(), /안전하게 확인하지 못해/u);
  assert.equal(h.writes.length, 0);
  assert.equal(favorites(h.stored.workspace)[0].dormant, false);
  assert.equal(h.ui.value.importPreview.canManage, false);
});

test("bulk add reports concurrent duplicates truthfully and preserves their destination", async () => {
  const h = await harness({ seed: (model) => model.createGroup(model.createWorkspace(), { id: "other", name: "기존 그룹" }) });
  const gate = h.holdGet();
  const destination = h.model.getSystemSectionId(h.model.SYSTEM_GROUP_ID);
  const request = h.ui.callbacks.onAddFavorites([PAGE_A, PAGE_B], destination);
  await gate.entered;
  h.writeFromOtherTab(h.model.addFavorite(h.stored.workspace, PAGE_A, {
    sectionId: h.model.getSystemSectionId("other")
  }));
  gate.release();
  const result = await request;
  assert.equal(result.addedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(h.writes.length, 1);
  const other = h.stored.workspace.groups.find((group) => group.id === "other");
  assert.equal(other.sections[0].favorites[0].pageId, PAGE_A);
});

test("a fully duplicate add does not write, announce an addition, or create Undo", async () => {
  const h = await harness({ seed: withFavorite });
  const result = await h.ui.callbacks.onAddFavorites([PAGE_A], h.model.getSystemSectionId(h.model.SYSTEM_GROUP_ID));
  assert.equal(result.addedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(h.writes.length, 0);
  assert.equal(h.ui.value.undoState.canUndo, false);
});

test("Undo restores reset once and refuses to overwrite a concurrent edit", async () => {
  const h = await harness({ seed: withGroup });
  const original = copy(h.stored.workspace);
  await h.ui.callbacks.onResetTree();
  assert.equal(h.ui.value.undoState.canUndo, true);
  await h.ui.callbacks.onUndo();
  assert.deepEqual(h.stored.workspace, original);
  assert.equal(h.ui.value.undoState.canUndo, false);
  await h.ui.callbacks.onResetTree();
  const gate = h.holdGet();
  const request = h.ui.callbacks.onUndo();
  await gate.entered;
  const newer = h.model.createGroup(h.stored.workspace, { name: "초기화 이후 다른 탭 변경" });
  h.writeFromOtherTab(newer);
  gate.release();
  await assert.rejects(request, /확인하는 동안/u);
  assert.deepEqual(h.stored.workspace, copy(newer));
});

test("Undo survives folding and refresh while keeping the latest disclosure state", async () => {
  const h = await harness({ seed: withGroup });
  await h.ui.callbacks.onRenameGroup("work", "이름 변경");
  await h.ui.callbacks.onToggleGroup("work");
  await h.ui.callbacks.onToggleSection(h.model.getSystemSectionId("work"));
  await h.ui.callbacks.onRefreshManagedFavorites();
  assert.equal(h.ui.value.undoState.canUndo, true);
  await h.ui.callbacks.onUndo();
  const group = h.stored.workspace.groups.find((entry) => entry.id === "work");
  assert.equal(group.name, "업무");
  assert.equal(group.collapsed, true);
  assert.equal(group.sections[0].collapsed, true);
});

test("folding a newly created group does not discard Undo for its creation", async () => {
  const h = await harness();
  await h.ui.callbacks.onCreateGroup("새 그룹");
  const groupId = h.stored.workspace.groups.find((group) => !group.isSystem).id;
  await h.ui.callbacks.onToggleGroup(groupId);
  assert.equal(h.ui.value.undoState.canUndo, true);
  await h.ui.callbacks.onUndo();
  assert.equal(h.stored.workspace.groups.some((group) => group.id === groupId), false);
});

test("folding after an unseen concurrent edit cannot revive an unsafe Undo snapshot", async () => {
  const h = await harness({ seed: withGroup });
  await h.ui.callbacks.onRenameGroup("work", "이름 변경");
  const external = h.model.addFavorite(h.stored.workspace, PAGE_B);
  h.writeFromOtherTab(external);
  await h.ui.callbacks.onToggleGroup("work");
  assert.equal(h.ui.value.undoState.canUndo, false);
  assert.equal(favorites(h.stored.workspace).length, 2);
});

test("existing slug tree survives stable workspace ID discovery without merging records", async () => {
  const h = await harness({ seed: withGroup, key: SLUG_KEY });
  const original = copy(h.stored.workspace);
  h.native.key = KEY;
  await h.refresh();
  assert.equal(h.ui.value.workspaceKey, SLUG_KEY);
  assert.deepEqual(copy(h.ui.value.workspace), original);
  await h.ui.callbacks.onRenameGroup("work", "연속된 트리");
  assert.equal(h.writes[0].payload.workspaceKey, SLUG_KEY);
  assert.equal(h.records.has(KEY), false);
});

test("a populated stable ID record wins over a distinct slug record without merging either", async () => {
  const h = await harness({ seed: withGroup });
  const stable = copy(h.stored.workspace);
  const slugTree = h.model.createGroup(h.model.createWorkspace(), { name: "별도 이전 트리" });
  h.records.set(SLUG_KEY, { revision: 3, workspace: copy(slugTree) });
  h.native.key = "workspace:id:cccccccccccccccccccccccccccccccc";
  h.native.slugKey = "workspace:slug:elsewhere";
  await h.refresh();
  h.native.key = KEY; h.native.slugKey = SLUG_KEY;
  await h.refresh();
  assert.deepEqual(copy(h.ui.value.workspace), stable);
  assert.deepEqual(h.records.get(SLUG_KEY).workspace, copy(slugTree));
  assert.equal(h.writes.length, 0);
});

test("attribute-only Notion shell completion recovers the fail-open mount", async () => {
  const h = await harness({ primarySafe: false });
  assert.equal(h.ui.mounts, 0);
  h.native.primarySafe = true;
  const scheduled = await h.notify({ type: "attributes", target: {}, attributeName: "aria-label" });
  assert.equal(scheduled, 1);
  assert.equal(h.ui.mounts, 1);
  assert.ok(h.observedAttributes.includes("aria-expanded"));
  assert.ok(h.observedAttributes.includes("style"));
});
