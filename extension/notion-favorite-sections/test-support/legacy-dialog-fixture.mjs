import { fixture, flush } from "./candidate-picker-fixture.mjs";
import { createCatalogService, FAVMOA_STORAGE_KEY } from "../src/favmoa-service.js";

export const workspaceKey = "nfs:workspace:synthetic";
export const metadataKey = "nfs:metadata:synthetic";
export async function legacyFixture() {
  const f = fixture(), writes = [], requests = [], reads = [];
  const original = structuredClone(f.context.initial.catalog);
  const pageId = "0123456789abcdef0123456789abcdef";
  const values = {
    [FAVMOA_STORAGE_KEY]: { revision: 7, catalog: original },
    [workspaceKey]: { revision: 2, workspace: { schemaVersion: 1, groups: [{ id: "legacy-group", name: "Legacy group", color: "", emoji: "", collapsed: false, order: 0, system: true, sections: [{ id: "legacy-section", name: "Legacy section", color: "", emoji: "", collapsed: false, order: 0, system: true, favorites: [{ pageId, order: 0, dormant: false, updatedAt: "2026-09-21T00:00:00.000Z" }] }] }] } },
    [metadataKey]: [{ pageId, title: "Synthetic legacy page", icon: "" }],
    "unrelated-setting": "not copied"
  };
  const storage = {
    setAccessLevel: async () => {},
    get: async keys => {
      reads.push(structuredClone(keys));
      return structuredClone(Object.fromEntries((keys === null ? Object.keys(values) : Array.isArray(keys) ? keys : [keys]).filter(key => key in values).map(key => [key, values[key]])));
    },
    set: async next => { writes.push(structuredClone(next)); Object.assign(values, structuredClone(next)); }
  };
  const service = createCatalogService({ runtimeId: "legacy-test", storage });
  const send = message => service.handle(message, { id: "legacy-test", url: "chrome-extension://legacy-test/sidepanel/sidepanel.html" });
  let readOverride = null, writeOverride = null;
  f.context.legacyPlatform = {
    load: async () => { requests.push({ type: "read" }); return readOverride ? readOverride() : send({ type: "FAVMOA_GET" }); },
    importLegacy: async expectedRevision => {
      const message = { type: "FAVMOA_IMPORT_LEGACY", expectedRevision }; requests.push(message);
      return writeOverride ? writeOverride(message) : send(message);
    }
  };
  f.run("Object.assign(platform, legacyPlatform)");
  return Object.assign(f, {
    original, values, writes, requests, reads, storage, send,
    edits: () => requests.filter(item => item.type === "FAVMOA_IMPORT_LEGACY"),
    current: () => structuredClone(values[FAVMOA_STORAGE_KEY]),
    setRead: value => { readOverride = value; }, setWrite: value => { writeOverride = value; },
    external(catalog, revision = 8) { values[FAVMOA_STORAGE_KEY] = { catalog: structuredClone(catalog), revision }; },
    async openLegacy() { await f.$("import-legacy").emit("click"); await flush(); if (!f.$("dialog").open) throw new Error("Legacy dialog did not open"); }
  });
}
