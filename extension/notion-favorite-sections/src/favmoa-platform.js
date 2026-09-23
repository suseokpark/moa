import { identifyUrl, validateCatalog } from "./link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY } from "./favmoa-service.js";

const DEMO_STORAGE_KEY = "favmoa:demo:v1";
const DEMO_PAGE = { id: 1, windowId: 1, title: "예시 프로젝트 문서 (데모)", url: "https://example.com/project/specification" };
const clone = (value) => JSON.parse(JSON.stringify(value));

function safeTab(tab) {
  try {
    const identified = identifyUrl(tab.url);
    return { id: tab.id, windowId: tab.windowId, title: tab.title || identified.url, url: identified.url, active: Boolean(tab.active) };
  } catch { return null; }
}

export function createPlatform({ chrome: chromeApi = globalThis.chrome, location: pageLocation = globalThis.location, localStorage: local = globalThis.localStorage, eventTarget = globalThis.window, open = globalThis.open?.bind(globalThis) } = {}) {
  const extension = Boolean(chromeApi?.runtime?.id && pageLocation?.protocol === "chrome-extension:");
  if (!extension && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(pageLocation?.hostname)) throw new Error("데모는 로컬 개발 서버에서만 실행할 수 있습니다.");
  const subscribers = new Set();
  const pendingOpens = new Map();
  let demoService;
  let notifyInstalled = false;

  if (!extension) {
    const read = () => {
      const value = local?.getItem(DEMO_STORAGE_KEY);
      if (!value) return {};
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid demo storage");
      return parsed;
    };
    demoService = createCatalogService({
      runtimeId: "demo",
      storage: {
        setAccessLevel: async () => undefined,
        get: async (keys) => {
          const values = read();
          if (keys === null) return values;
          return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in values).map(key => [key, values[key]]));
        },
        set: async (values) => {
          if (!local) throw new Error("Local storage unavailable");
          local.setItem(DEMO_STORAGE_KEY, JSON.stringify({ ...read(), ...values }));
        }
      }
    });
  }

  const notify = (value) => { for (const callback of subscribers) { try { callback(value); } catch { /* Subscriber errors must not reject a saved mutation. */ } } };
  async function request(message) {
    try {
      const response = extension
        ? await chromeApi.runtime.sendMessage(message)
        : await demoService.handle(message, { id: "demo", url: "chrome-extension://demo/sidepanel/sidepanel.html" });
      if (!response || typeof response.ok !== "boolean") return { ok: false, code: "NO_RESPONSE", error: "확장 프로그램을 새로고침하고 다시 시도해 주세요." };
      if (!extension && response.ok && message.type !== "FAVMOA_GET") notify(response);
      return response;
    } catch { return { ok: false, code: "CONNECTION_FAILED", error: "확장 프로그램과 연결하지 못했습니다. 새로고침 후 다시 시도해 주세요." }; }
  }

  const storageChanged = async (changes, area) => {
    if (area !== "local" || !changes[FAVMOA_STORAGE_KEY]?.newValue) return;
    const value = changes[FAVMOA_STORAGE_KEY].newValue;
    if (!Number.isSafeInteger(value.revision) || value.revision < 0) return;
    try {
      validateCatalog(value.catalog);
      // Undo and restore availability live beside the catalog. Read one coherent
      // service snapshot so another window cannot leave these controls stale.
      const current = await request({ type: "FAVMOA_GET" });
      if (current.ok) notify(current);
    } catch { /* Invalid changes are never rendered. */ }
  };
  const demoChanged = (event) => { if (event.key === DEMO_STORAGE_KEY) request({ type: "FAVMOA_GET" }).then(notify); };
  const tabsChanged = () => notify({ type: "tabs-changed" });
  const tabUpdated = (_tabId, change) => { if (change.url || change.title || change.status === "complete") tabsChanged(); };
  const windowFocused = (windowId) => { if (windowId >= 0) tabsChanged(); };
  const tabEvents = [
    [chromeApi?.tabs?.onActivated, tabsChanged],
    [chromeApi?.tabs?.onRemoved, tabsChanged],
    [chromeApi?.tabs?.onUpdated, tabUpdated],
    [chromeApi?.windows?.onFocusChanged, windowFocused]
  ];

  async function getCurrentPage() {
    if (!extension) return clone(DEMO_PAGE);
    try { return safeTab((await chromeApi.tabs.query({ active: true, lastFocusedWindow: true }))[0] || {}); }
    catch { return null; }
  }

  async function getOpenTabs() {
    if (!extension) return [{ ...clone(DEMO_PAGE), active: true }];
    try { return (await chromeApi.tabs.query({})).map(safeTab).filter(Boolean); }
    catch { return []; }
  }

  async function openExtensionLink(identified, newTab) {
    try {
      if (!newTab) {
        // Both queries are independent. Keep the raw active tab's window even
        // on chrome:// pages, without serializing two Chrome response rounds.
        const [currentTabs, allTabs] = await Promise.all([
          chromeApi.tabs.query({ active: true, lastFocusedWindow: true }),
          chromeApi.tabs.query({})
        ]);
        const current = currentTabs[0];
        const candidates = allTabs.filter(tab => {
          try { return identifyUrl(tab.url).key === identified.key; }
          catch { return false; }
        });
        const existing = candidates.find(tab => tab.windowId === current?.windowId && tab.active)
          || candidates.find(tab => tab.windowId === current?.windowId) || candidates[0];
        if (existing) {
          await chromeApi.tabs.update(existing.id, { active: true });
          if (existing.windowId !== current?.windowId && chromeApi.windows?.update && Number.isInteger(existing.windowId)) {
            await chromeApi.windows.update(existing.windowId, { focused: true });
          }
          return { ok: true, reused: true, tabId: existing.id };
        }
      }
      const created = await chromeApi.tabs.create({ url: identified.url });
      return { ok: true, reused: false, tabId: created.id };
    } catch { return { ok: false, code: "OPEN_FAILED", error: "페이지를 열지 못했습니다. 다시 시도해 주세요." }; }
  }

  return {
    mode: extension ? "extension" : "demo",
    load: () => request({ type: "FAVMOA_GET" }),
    dispatch: (action, expectedRevision) => request({ type: "FAVMOA_ACTION", action, expectedRevision }),
    importLegacy: (expectedRevision) => request({ type: "FAVMOA_IMPORT_LEGACY", expectedRevision }),
    importBackup: (catalog, expectedRevision) => request({ type: "FAVMOA_IMPORT_BACKUP", catalog, expectedRevision }),
    restorePreviousBackup: (expectedRevision) => request({ type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision }),
    undo: (expectedRevision) => request({ type: "FAVMOA_UNDO", expectedRevision }),
    getCurrentPage,
    getOpenTabs,
    async openLink(url, { newTab = false } = {}) {
      let identified;
      try { identified = identifyUrl(url); }
      catch { return { ok: false, code: "UNSAFE_URL", error: "안전한 웹 주소만 열 수 있습니다." }; }
      if (!extension) {
        if (typeof open !== "function") return { ok: false, code: "OPEN_FAILED", error: "새 창을 열 수 없습니다." };
        open(identified.url, "_blank", "noopener,noreferrer");
        return { ok: true, reused: false };
      }
      if (newTab) return openExtensionLink(identified, true);
      // Coalesce only overlapping ordinary clicks on the exact URL. This is
      // not a tab cache: every later click reads fresh Chrome state, and distinct
      // saved Notion views retain their own URL even when page identities match.
      if (pendingOpens.has(identified.url)) return pendingOpens.get(identified.url);
      const opening = openExtensionLink(identified, false);
      pendingOpens.set(identified.url, opening);
      try { return await opening; }
      finally { pendingOpens.delete(identified.url); }
    },
    async getBookmarkCandidates() {
      if (!extension) return { ok: true, demo: true, candidates: [{ title: "예시 참고 문서 (데모)", url: "https://example.org/reference", folderPath: "데모 북마크" }] };
      try {
        // Called directly from the import button so permission is not requested
        // during startup. The extension never writes browser bookmarks.
        const granted = await chromeApi.permissions.request({ permissions: ["bookmarks"] });
        if (!granted) return { ok: false, code: "PERMISSION_DENIED", error: "북마크 읽기 권한을 허용하면 선택해서 가져올 수 있습니다." };
        const roots = await chromeApi.bookmarks.getTree();
        const candidates = [];
        const visit = (nodes, path = []) => {
          for (const node of nodes) {
            if (node.url) {
              try { const { url } = identifyUrl(node.url); candidates.push({ title: node.title || url, url, folderPath: path.join(" / ") }); } catch { /* Skip browser-internal and unsafe bookmarks. */ }
            }
            if (node.children) visit(node.children, node.title ? [...path, node.title] : path);
          }
        };
        visit(roots);
        return { ok: true, candidates };
      } catch { return { ok: false, code: "BOOKMARKS_UNAVAILABLE", error: "브라우저 북마크를 읽지 못했습니다." }; }
    },
    subscribe(callback) {
      subscribers.add(callback);
      if (!notifyInstalled) {
        if (extension) {
          chromeApi.storage?.onChanged?.addListener(storageChanged);
          for (const [event, handler] of tabEvents) event?.addListener(handler);
        }
        else eventTarget?.addEventListener("storage", demoChanged);
        notifyInstalled = true;
      }
      return () => {
        subscribers.delete(callback);
        if (!subscribers.size && notifyInstalled) {
          if (extension) {
            chromeApi.storage?.onChanged?.removeListener(storageChanged);
            for (const [event, handler] of tabEvents) event?.removeListener(handler);
          }
          else eventTarget?.removeEventListener("storage", demoChanged);
          notifyInstalled = false;
        }
      };
    }
  };
}
