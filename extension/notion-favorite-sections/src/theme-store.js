import { DEFAULT_THEME, validateTheme } from "./theme.js";

export const THEME_STORAGE_KEY = "favmoa:theme:v1";
export const DEMO_THEME_STORAGE_KEY = "favmoa:demo:theme:v1";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const clone = (theme) => ({ ...theme });
const failure = (code, error) => ({ ok: false, code, error });

function storageMode(chromeApi, pageLocation) {
  try {
    const url = new URL(pageLocation?.href || `${pageLocation?.protocol}//${pageLocation?.hostname}${pageLocation?.pathname || "/"}`);
    if (url.username || url.password || url.port && url.protocol === "chrome-extension:") return "unavailable";
    if (chromeApi?.runtime?.id && url.protocol === "chrome-extension:" && url.hostname === chromeApi.runtime.id
      && url.pathname === "/sidepanel/sidepanel.html") return "extension";
    if (["http:", "https:"].includes(url.protocol) && LOCAL_HOSTS.has(url.hostname)) return "demo";
  } catch { /* Missing or malformed locations cannot access preferences. */ }
  return "unavailable";
}

// Appearance preferences intentionally live outside catalog, undo and backup
// records. They are local to this browser; local demos use a separate namespace.
export function createThemeStore({ chrome: chromeApi = globalThis.chrome, location: pageLocation = globalThis.location,
  localStorage: local = globalThis.localStorage, eventTarget = globalThis.window } = {}) {
  const mode = storageMode(chromeApi, pageLocation);
  const key = mode === "demo" ? DEMO_THEME_STORAGE_KEY : THEME_STORAGE_KEY;
  const subscribers = new Set();
  let listening = false;
  let lastNotification = null;
  let observedGeneration = 0;
  let observedTheme = null;
  let pendingWrites = 0;
  let queue = Promise.resolve();

  function notify(theme) {
    const signature = JSON.stringify(theme);
    if (signature === lastNotification) return;
    lastNotification = signature;
    for (const callback of subscribers) {
      try { callback(clone(theme)); }
      catch { /* A view failure cannot turn a completed save into a failure. */ }
    }
  }

  function validChange(raw) {
    try {
      const theme = validateTheme(raw);
      observedGeneration += 1;
      observedTheme = clone(theme);
      notify(theme);
    }
    catch { /* Never render unvalidated external storage values. */ }
  }

  const extensionChanged = (changes, area) => {
    if (area !== "local" || !changes || !Object.hasOwn(changes, THEME_STORAGE_KEY)) return;
    const change = changes[THEME_STORAGE_KEY];
    if (change && Object.hasOwn(change, "newValue")) validChange(change.newValue);
  };
  const demoChanged = (event) => {
    if (event.key !== DEMO_THEME_STORAGE_KEY || event.newValue === null || event.newValue === undefined) return;
    if (event.storageArea && event.storageArea !== local) return;
    try { validChange(JSON.parse(event.newValue)); }
    catch { /* A malformed demo preference must not affect the current theme. */ }
  };

  function updateListening() {
    const needed = mode !== "unavailable" && (subscribers.size > 0 || pendingWrites > 0);
    if (needed === listening) return;
    if (needed) {
      lastNotification = null;
      if (mode === "extension") chromeApi.storage?.onChanged?.addListener(extensionChanged);
      else eventTarget?.addEventListener("storage", demoChanged);
    } else {
      if (mode === "extension") chromeApi.storage?.onChanged?.removeListener(extensionChanged);
      else eventTarget?.removeEventListener("storage", demoChanged);
      lastNotification = null;
    }
    listening = needed;
  }

  const unavailable = () => failure("THEME_STORAGE_UNAVAILABLE", "테마 설정은 FAVMOA 사이드 패널에서 사용할 수 있습니다.");

  async function load() {
    if (mode === "unavailable") return unavailable();
    let value;
    try {
      if (mode === "extension") {
        if (typeof chromeApi?.storage?.local?.get !== "function") return unavailable();
        const stored = await chromeApi.storage.local.get(THEME_STORAGE_KEY);
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("Invalid storage response");
        value = stored[THEME_STORAGE_KEY];
      } else {
        if (typeof local?.getItem !== "function") return unavailable();
        const raw = local.getItem(DEMO_THEME_STORAGE_KEY);
        if (raw !== null) {
          try { value = JSON.parse(raw); }
          catch { value = null; }
        }
      }
    } catch {
      return failure("THEME_READ_FAILED", "테마 설정을 읽지 못했습니다. 저장된 링크와 설정은 변경하지 않았습니다.");
    }
    if (value === undefined) return { ok: true, theme: clone(DEFAULT_THEME) };
    try { return { ok: true, theme: validateTheme(value) }; }
    catch {
      // A read is never a migration or reset. Keep corrupt/future-version bytes
      // until the user explicitly saves another theme or chooses theme reset.
      return { ok: true, theme: clone(DEFAULT_THEME), code: "INVALID_SAVED_THEME",
        warning: "저장된 테마를 확인할 수 없어 기본 테마로 표시합니다. 기존 설정은 덮어쓰지 않았습니다." };
    }
  }

  function save(raw) {
    if (mode === "unavailable") return Promise.resolve(unavailable());
    let theme;
    try { theme = validateTheme(raw); }
    catch { return Promise.resolve(failure("INVALID_THEME", "테마 색상과 표시 모드를 확인해 주세요.")); }
    // Serialise this panel's writes. Across panels the last persisted explicit
    // save wins; there is intentionally no catalog revision or undo mutation.
    const operation = queue.then(async () => {
      pendingWrites += 1;
      updateListening();
      const generationAtWrite = observedGeneration;
      try {
        if (mode === "extension") {
          if (typeof chromeApi?.storage?.local?.set !== "function") return unavailable();
          await chromeApi.storage.local.set({ [THEME_STORAGE_KEY]: clone(theme) });
        } else {
          if (typeof local?.setItem !== "function") return unavailable();
          local.setItem(DEMO_THEME_STORAGE_KEY, JSON.stringify(theme));
        }
      } catch {
        return failure("THEME_SAVE_FAILED", "테마를 저장하지 못했습니다. 다시 시도해 주세요. 저장된 링크는 변경하지 않았습니다.");
      } finally {
        pendingWrites -= 1;
        updateListening();
      }
      // Chrome can deliver a later panel's storage event before this write's
      // Promise settles. Completion is not another write: never re-announce an
      // older theme after observing the actual newer persisted value.
      if (observedGeneration > generationAtWrite && observedTheme && JSON.stringify(observedTheme) !== JSON.stringify(theme)) {
        return { ok: true, theme: clone(observedTheme), superseded: true,
          info: "다른 화면에서 더 최근에 저장한 테마를 적용했습니다." };
      }
      notify(theme);
      return { ok: true, theme: clone(theme) };
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function subscribe(callback) {
    if (typeof callback !== "function") throw new TypeError("Theme subscriber must be a function");
    subscribers.add(callback);
    updateListening();
    return () => {
      subscribers.delete(callback);
      updateListening();
    };
  }

  return { mode, load, save, subscribe };
}
