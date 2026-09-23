import { applyCatalogAction, createCatalog, migrateLegacyStorage, validateCatalog } from "./link-library.js";

export const FAVMOA_STORAGE_KEY = "favmoa:catalog:v1";
export const FAVMOA_UNDO_KEY = "favmoa:undo:v1";
export const FAVMOA_LEGACY_BACKUP_KEY = "favmoa:legacy-backup:v1";
export const FAVMOA_RESTORE_POINT_KEY = "favmoa:restore-point:v1";
export const FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY = "favmoa:schema-v1-backup:v1";
const MIGRATION_SOURCE_KEYS = [FAVMOA_STORAGE_KEY, FAVMOA_UNDO_KEY, FAVMOA_RESTORE_POINT_KEY];
const TYPES = new Set(["FAVMOA_GET", "FAVMOA_ACTION", "FAVMOA_IMPORT_LEGACY", "FAVMOA_IMPORT_BACKUP", "FAVMOA_UNDO", "FAVMOA_RESTORE_PREVIOUS_BACKUP"]);
const TRUSTED_PATHS = new Set(["/sidepanel/sidepanel.html"]);

export function isTrustedFavmoaSender(sender, runtimeId) {
  if (!runtimeId || sender?.id !== runtimeId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:" && url.hostname === runtimeId && !url.username && !url.password && TRUSTED_PATHS.has(url.pathname);
  } catch { return false; }
}

function failure(code, error) { return { ok: false, code, error }; }

function decodeEnvelope(value) {
  if (value === undefined) return { revision: 0, catalog: createCatalog() };
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("저장된 데이터 형식을 확인할 수 없습니다. 데이터를 덮어쓰지 않았습니다.");
  return { revision: value.revision, catalog: validateCatalog(value.catalog) };
}

function decodeRestorePoint(value) {
  if (!value) return null;
  try { return validateCatalog(value.catalog); }
  catch { return null; }
}

function hasVersionOneSource(values) {
  return MIGRATION_SOURCE_KEYS.some(key => values[key]?.catalog?.schemaVersion === 1);
}

function isMigrationBackup(value) {
  const shapeValid = value?.fromSchemaVersion === 1 && value?.toSchemaVersion === 2
    && Object.keys(value).every(key => ["fromSchemaVersion", "toSchemaVersion", "storage"].includes(key))
    && value.storage && typeof value.storage === "object" && !Array.isArray(value.storage)
    && Object.keys(value.storage).every(key => MIGRATION_SOURCE_KEYS.includes(key))
    && hasVersionOneSource(value.storage);
  if (!shapeValid) return false;
  try {
    // Undo/restore may have been unreadable already and are retained verbatim;
    // a captured current catalog must still be a readable revision envelope.
    if (Object.hasOwn(value.storage, FAVMOA_STORAGE_KEY)) decodeEnvelope(value.storage[FAVMOA_STORAGE_KEY]);
    return true;
  } catch { return false; }
}

// A single service-worker queue and expectedRevision prevent stale panels from
// overwriting each other. Legacy storage is only read on explicit import.
export function createCatalogService({ storage, runtimeId }) {
  let queue = Promise.resolve();
  const accessReady = Promise.resolve().then(async () => {
    if (typeof storage.setAccessLevel !== "function") return false;
    try { await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); return true; }
    catch { return false; }
  });

  async function execute(message) {
    if (!(await accessReady)) return failure("STORAGE_UNAVAILABLE", "안전한 로컬 저장소를 사용할 수 없습니다.");
    let stored;
    try { stored = await storage.get([...MIGRATION_SOURCE_KEYS, FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY]); }
    catch { return failure("STORAGE_UNAVAILABLE", "저장된 목록을 읽지 못했습니다. 다시 시도해 주세요."); }
    let current;
    try { current = decodeEnvelope(stored[FAVMOA_STORAGE_KEY]); }
    catch { return failure("CORRUPT_STORAGE", "저장된 목록을 확인할 수 없습니다. 기존 데이터는 유지됩니다."); }
    const previous = stored[FAVMOA_UNDO_KEY];
    const undoCatalog = previous?.revertsRevision === current.revision ? decodeRestorePoint(previous) : null;
    const canUndo = Boolean(undoCatalog);
    const restorePoint = decodeRestorePoint(stored[FAVMOA_RESTORE_POINT_KEY]);
    const hasRestorePoint = Boolean(restorePoint);
    if (message.type === "FAVMOA_GET") return { ok: true, ...current, canUndo, hasRestorePoint };
    if (!Number.isSafeInteger(message.expectedRevision) || message.expectedRevision < 0) return failure("INVALID_REQUEST", "저장 버전이 필요합니다. 목록을 다시 불러와 주세요.");
    if (message.expectedRevision !== current.revision) return { ...failure("CONFLICT", "다른 창에서 목록이 변경되었습니다. 최신 목록을 확인한 뒤 다시 시도해 주세요."), conflict: true, ...current, canUndo, hasRestorePoint };
    if (current.revision === Number.MAX_SAFE_INTEGER) return failure("REVISION_LIMIT", "저장 버전을 더 이상 변경할 수 없습니다.");

    let catalog;
    let extra = {};
    let legacySnapshot;
    try {
      if (message.type === "FAVMOA_ACTION") catalog = applyCatalogAction(current.catalog, message.action);
      if (message.type === "FAVMOA_IMPORT_BACKUP") catalog = validateCatalog(message.catalog);
      if (message.type === "FAVMOA_IMPORT_LEGACY") {
        let all;
        try { all = await storage.get(null); }
        catch { return failure("STORAGE_UNAVAILABLE", "이전 목록을 읽지 못했습니다. 기존 데이터는 유지됩니다."); }
        legacySnapshot = Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith("nfs:workspace:") || key.startsWith("nfs:metadata:")));
        const imported = migrateLegacyStorage(current.catalog, legacySnapshot);
        catalog = imported.catalog;
        extra = { importedLibraries: imported.importedLibraries, importedLinks: imported.importedLinks, warnings: imported.warnings };
      }
      if (message.type === "FAVMOA_UNDO") {
        if (!canUndo) return failure("NOTHING_TO_UNDO", "되돌릴 변경사항이 없습니다.");
        catalog = undoCatalog;
      }
      if (message.type === "FAVMOA_RESTORE_PREVIOUS_BACKUP") {
        if (!restorePoint) return failure("NO_RESTORE_POINT", "복원 전 목록의 안전 사본이 없거나 읽을 수 없습니다. 현재 목록은 유지됩니다.");
        catalog = restorePoint;
      }
      catalog = validateCatalog(catalog);
    } catch (error) {
      return failure("INVALID_DATA", error instanceof Error ? error.message : "입력한 데이터를 확인해 주세요.");
    }
    if (JSON.stringify(catalog) === JSON.stringify(current.catalog) && !["FAVMOA_UNDO", "FAVMOA_RESTORE_PREVIOUS_BACKUP"].includes(message.type)) return { ok: true, ...current, canUndo, hasRestorePoint, ...extra };
    const next = { revision: current.revision + 1, catalog };
    const writes = {
      [FAVMOA_STORAGE_KEY]: next,
      [FAVMOA_UNDO_KEY]: message.type === "FAVMOA_UNDO" ? null : { catalog: current.catalog, revertsRevision: next.revision }
    };
    // Loading v1 returns a pure v2 view without rewriting storage. Only the first
    // changed save archives the exact old envelope, undo and restore point, in
    // the same set call as the mutation. Failed quota checks must leave both the
    // source and its checkpoint untouched; never overwrite a prior archive.
    if (catalog.schemaVersion === 2 && hasVersionOneSource(stored)) {
      if (Object.hasOwn(stored, FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY)) {
        if (!isMigrationBackup(stored[FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY])) return failure("MIGRATION_BACKUP_INVALID", "이전 버전 안전 사본을 확인하지 못했습니다. 현재 목록은 변경하지 않았습니다. JSON 내보내기로 보관한 뒤 지원을 요청해 주세요.");
      } else {
        writes[FAVMOA_SCHEMA_MIGRATION_BACKUP_KEY] = {
          fromSchemaVersion: 1, toSchemaVersion: 2,
          storage: Object.fromEntries(MIGRATION_SOURCE_KEYS.filter(key => Object.hasOwn(stored, key)).map(key => [key, stored[key]]))
        };
      }
    }
    // The checkpoint shares the catalog write, survives normal edits/undo, and
    // is consumed only by successful explicit recovery or replaced by an import.
    if (message.type === "FAVMOA_IMPORT_BACKUP") writes[FAVMOA_RESTORE_POINT_KEY] = { catalog: current.catalog };
    if (message.type === "FAVMOA_RESTORE_PREVIOUS_BACKUP") writes[FAVMOA_RESTORE_POINT_KEY] = null;
    if (legacySnapshot && !stored[FAVMOA_LEGACY_BACKUP_KEY]) {
      const existingBackup = await storage.get(FAVMOA_LEGACY_BACKUP_KEY);
      if (!existingBackup[FAVMOA_LEGACY_BACKUP_KEY]) writes[FAVMOA_LEGACY_BACKUP_KEY] = legacySnapshot;
    }
    try { await storage.set(writes); }
    catch { return failure("SAVE_FAILED", "저장하지 못했습니다. 저장 공간을 확인하고 다시 시도해 주세요."); }
    return { ok: true, ...next, canUndo: message.type !== "FAVMOA_UNDO",
      hasRestorePoint: message.type === "FAVMOA_IMPORT_BACKUP" || (message.type !== "FAVMOA_RESTORE_PREVIOUS_BACKUP" && hasRestorePoint), ...extra };
  }

  return {
    accepts: (message) => TYPES.has(message?.type),
    handle(message, sender) {
      if (!TYPES.has(message?.type)) return Promise.resolve(failure("UNKNOWN_REQUEST", "지원하지 않는 요청입니다."));
      if (!isTrustedFavmoaSender(sender, runtimeId)) return Promise.resolve(failure("UNTRUSTED_SENDER", "이 요청은 FAVMOA 화면에서만 사용할 수 있습니다."));
      const task = queue.catch(() => undefined).then(() => execute(message));
      queue = task;
      return task.catch(() => failure("STORAGE_UNAVAILABLE", "로컬 데이터를 처리하지 못했습니다. 다시 시도해 주세요."));
    }
  };
}

if (typeof globalThis.document === "undefined" && globalThis.chrome?.runtime?.onMessage && globalThis.chrome?.storage?.local) {
  const service = createCatalogService({ storage: chrome.storage.local, runtimeId: chrome.runtime.id });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!service.accepts(message)) return false;
    service.handle(message, sender).then(respond);
    return true;
  });
}
