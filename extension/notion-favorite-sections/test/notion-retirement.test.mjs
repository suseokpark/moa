import assert from "node:assert/strict";
import test from "node:test";

test("browser-only worker leaves old data untouched, rejects stale Notion clients and keeps modern storage usable", async t => {
  const runtimeId = "ebbgmhdbonpillbfjapebljagnbjembj";
  const initial = {
    "nfs:workspace:alpha": { original: "workspace retained verbatim" },
    "nfs:metadata:alpha": [{ original: "metadata retained verbatim" }],
    "nfs:profile-catalog:v1": { original: "profile retained verbatim" },
    "favmoa:catalog:v1": {
      revision: 4,
      catalog: { schemaVersion: 2, libraries: [{ id: "personal", name: "내 링크", groups: [
        { id: "custom-group", name: "자료", collapsed: false, groups: [], links: [] }
      ] }], migratedLegacyKeys: [] }
    }
  };
  const values = structuredClone(initial);
  const accesses = [];
  const listeners = [];
  const connectListeners = [];
  const panelBehaviors = [];
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    runtime: {
      id: runtimeId,
      onMessage: { addListener: listener => listeners.push(listener) },
      onConnect: { addListener: listener => connectListeners.push(listener) }
    },
    sidePanel: { async setPanelBehavior(options) { panelBehaviors.push(options); } },
    storage: { local: {
      async setAccessLevel(options) { accesses.push(["access", options]); },
      async get(keys) {
        accesses.push(["get", keys]);
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter(key => Object.hasOwn(values, key)).map(key => [key, structuredClone(values[key])]));
      },
      async set(entries) {
        accesses.push(["set", Object.keys(entries)]);
        Object.assign(values, structuredClone(entries));
      },
      async remove() { assert.fail("Retirement must never delete stored data"); },
      async clear() { assert.fail("Retirement must never clear stored data"); }
    } }
  };
  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  });
  await import(`../src/background.js?retirement=${Date.now()}`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(accesses, [["access", { accessLevel: "TRUSTED_CONTEXTS" }]]);
  assert.deepEqual(values, initial, "startup does not read, migrate or rewrite either catalog");
  assert.deepEqual(panelBehaviors, [{ openPanelOnActionClick: true }]);

  const notionSender = { id: runtimeId, url: "https://app.notion.com/p/workspace/page", tab: { id: 1 } };
  async function request(message, sender = notionSender) {
    const responses = [];
    const pending = [];
    for (const listener of listeners) {
      let resolve;
      const done = new Promise(complete => { resolve = complete; });
      const waiting = listener(message, sender, result => { responses.push(result); resolve(); });
      if (waiting === true) pending.push(done);
    }
    await Promise.all(pending);
    return responses;
  }
  for (const type of ["NFS_STORAGE_GET", "NFS_STORAGE_SET", "NFS_STORAGE_RESET", "NFS_METADATA_GET", "NFS_METADATA_MERGE", "NFS_PROFILE_CATALOG_GET", "NFS_PROFILE_CATALOG_SET", "NFS_UNKNOWN"]) {
    const responses = await request({ type, payload: { workspaceKey: "alpha", expectedRevision: 0 } });
    assert.equal(responses.length, 1, `${type} receives one retirement response`);
    assert.equal(responses[0].code, "LEGACY_NOTION_RETIRED", type);
    assert.equal(responses[0].ok, false);
  }
  assert.equal(accesses.length, 1, "stale requests never touch storage");
  assert.deepEqual(values, initial);

  assert.equal(connectListeners.length, 1);
  let disconnected = false;
  connectListeners[0]({ name: "NFS_WORKSPACE_SYNC", sender: notionSender, disconnect() { disconnected = true; } });
  assert.equal(disconnected, true);
  assert.equal(accesses.length, 1);

  const panelSender = { id: runtimeId, url: `chrome-extension://${runtimeId}/sidepanel/sidepanel.html` };
  const [loaded] = await request({ type: "FAVMOA_GET" }, panelSender);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.revision, 4);
  assert.deepEqual(values, initial, "read-only panel startup preserves legacy and current storage");
  const [saved] = await request({ type: "FAVMOA_ACTION", expectedRevision: 4,
    action: { type: "renameGroup", libraryId: "personal", groupId: "custom-group", name: "업무 자료" }
  }, panelSender);
  assert.equal(saved.ok, true);
  assert.equal(saved.revision, 5);
  assert.equal(saved.catalog.libraries[0].groups.find(group => group.id === "custom-group").name, "업무 자료");
  for (const key of Object.keys(initial).filter(key => key.startsWith("nfs:"))) assert.deepEqual(values[key], initial[key]);
  assert.equal(accesses.filter(([operation]) => operation === "get").some(([, keys]) => keys === null || keys.some(key => key.startsWith("nfs:"))), false);
  const [rejected] = await request({ type: "FAVMOA_GET" }, notionSender);
  assert.equal(rejected.code, "UNTRUSTED_SENDER");
});
