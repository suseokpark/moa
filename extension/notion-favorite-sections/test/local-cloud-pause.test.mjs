import assert from "node:assert/strict";
import test from "node:test";

test("release background pauses every cloud message without accessing credentials, network, or saved data", async t => {
  const runtimeId = "ebbgmhdbonpillbfjapebljagnbjembj";
  const values = {
    "favmoa:google:connection:v1": { connected: true, account: { id: "saved-account", email: "saved@example.com" }, lastBackupAt: "2026-09-22T12:00:00.000Z" },
    "favmoa:catalog:v1": { revision: 12, catalog: { preserved: "existing local data" } }
  };
  const initial = structuredClone(values);
  const accesses = [];
  const listeners = [];
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const forbidden = name => async () => { accesses.push(name); throw new Error(`Unexpected ${name}`); };
  globalThis.chrome = {
    runtime: {
      id: runtimeId,
      getManifest: () => ({}),
      onMessage: { addListener: listener => listeners.push(listener) },
      onConnect: { addListener() {} }
    },
    identity: {
      getAuthToken: forbidden("getAuthToken"),
      removeCachedAuthToken: forbidden("removeCachedAuthToken"),
      clearAllCachedAuthTokens: forbidden("clearAllCachedAuthTokens")
    },
    storage: { local: {
      async setAccessLevel() {},
      get: forbidden("storage.get"),
      set: forbidden("storage.set"),
      remove: forbidden("storage.remove"),
      clear: forbidden("storage.clear")
    } }
  };
  globalThis.fetch = forbidden("fetch");
  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  });
  await import(`../src/background.js?cloud-paused=${Date.now()}`);
  for (const operation of ["STATUS", "CONNECT", "DISCONNECT", "LIST", "UPLOAD", "READ", "UNKNOWN"]) {
    const message = { type: `FAVMOA_CLOUD_${operation}`, accountId: "saved-account", fileId: "backup-1", expectedRevision: 12 };
    const sender = { id: runtimeId, url: `chrome-extension://${runtimeId}/sidepanel/sidepanel.html` };
    const responses = [];
    for (const listener of listeners) listener(message, sender, result => responses.push(result));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(responses.length, 1, `${operation} receives one response`);
    assert.equal(responses[0].ok, false);
    assert.equal(responses[0].code, "CLOUD_PAUSED", operation);
    assert.equal(JSON.stringify(responses[0]).includes("saved@example.com"), false);
  }
  assert.deepEqual(accesses, []);
  assert.deepEqual(values, initial);
});
