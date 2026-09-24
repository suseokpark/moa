import { fixture, flush } from "./candidate-picker-fixture.mjs";
import { createCatalogService, FAVMOA_STORAGE_KEY, FAVMOA_RESTORE_POINT_KEY } from "../src/favmoa-service.js";

export async function backupFixture() {
  const f = fixture(), writes = [], requests = [];
  // The shipped parser and validator share one realm in the browser. Keep that
  // boundary coherent when the full script runs inside the synthetic VM.
  f.context.JSON = JSON;
  const original = structuredClone(f.context.initial.catalog);
  const target = structuredClone(original); target.libraries[0].name = "Backup library";
  const values = {
    [FAVMOA_STORAGE_KEY]: { revision: 7, catalog: original },
    [FAVMOA_RESTORE_POINT_KEY]: { catalog: target }
  };
  const service = createCatalogService({ runtimeId: "backup-test", storage: {
    setAccessLevel: async () => {},
    get: async keys => structuredClone(Object.fromEntries((keys === null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys]).filter(key => key in values).map(key => [key, values[key]]))),
    set: async next => { writes.push(structuredClone(next)); Object.assign(values, structuredClone(next)); }
  } });
  const send = message => service.handle(message, { id: "backup-test", url: "chrome-extension://backup-test/sidepanel/sidepanel.html" });
  let readOverride = null, writeOverride = null;
  f.context.backupPlatform = {
    load: async () => { requests.push({ type: "read" }); return readOverride ? readOverride() : send({ type: "FAVMOA_GET" }); },
    previewBackup: async () => { requests.push({ type: "preview" }); return readOverride ? readOverride() : send({ type: "FAVMOA_PREVIEW_BACKUP" }); },
    importBackup: async (catalog, expectedRevision) => {
      const message = { type: "FAVMOA_IMPORT_BACKUP", catalog: structuredClone(catalog), expectedRevision }; requests.push(message);
      return writeOverride ? writeOverride(message) : send(message);
    },
    restorePreviousBackup: async expectedRevision => {
      const message = { type: "FAVMOA_RESTORE_PREVIOUS_BACKUP", expectedRevision }; requests.push(message);
      return writeOverride ? writeOverride(message) : send(message);
    }
  };
  f.run("Object.assign(platform, backupPlatform)");
  f.context.initial = await send({ type: "FAVMOA_GET" }); f.run("adopt(initial)");
  return Object.assign(f, {
    original, target, values, writes, requests, send,
    edits: () => requests.filter(item => item.type.startsWith("FAVMOA_")),
    current: () => structuredClone(values[FAVMOA_STORAGE_KEY]),
    setRead: value => { readOverride = value; }, setWrite: value => { writeOverride = value; },
    external(catalog, revision = 8, restoreCatalog = target) {
      values[FAVMOA_STORAGE_KEY] = { catalog: structuredClone(catalog), revision };
      values[FAVMOA_RESTORE_POINT_KEY] = restoreCatalog ? { catalog: structuredClone(restoreCatalog) } : null;
    },
    async openBackup(kind = "file") {
      if (kind === "previous") await f.$("restore-previous-backup").emit("click");
      else await f.$("backup-file").emit("change", { target: { value: "backup.json", files: [{ name: "synthetic-backup.json", size: 1000, text: async () => JSON.stringify({ format: "favmoa-backup", version: 1, catalog: target }) }] } });
      await flush();
      if (!f.$("dialog").open) throw new Error(f.$("status").textContent || "Backup dialog did not open");
    }
  });
}
