import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_MESSAGE_TYPES,
  StorageContractError,
  decodeStoredWorkspace,
  isTrustedNotionSender,
  validateStorageRequest,
  validateStorageEnvelope,
  validateWorkspace,
  workspaceStorageKey
} from "../src/storage-contract.js";

await import("../src/profile-catalog.js");

const {
  PROFILE_CATALOG_MESSAGE_TYPES,
  PROFILE_CATALOG_STORAGE_KEY,
  addLocalProfile,
  createProfileCatalog
} = globalThis.NotionFavoriteSections.profileCatalog;

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

function favorite(pageId = "0123456789abcdef0123456789abcdef") {
  return {
    pageId,
    order: 0,
    dormant: false,
    updatedAt: "2026-08-31T00:00:00.000Z"
  };
}

function workspace() {
  return {
    schemaVersion: 1,
    groups: [
      {
        id: "group-system",
        name: "미분류 그룹",
        color: "default",
        emoji: "",
        collapsed: false,
        order: 0,
        system: true,
        sections: [
          {
            id: "section-system",
            name: "미분류 섹션",
            color: "default",
            emoji: "",
            collapsed: false,
            order: 0,
            system: true,
            favorites: [favorite()]
          }
        ]
      }
    ]
  };
}

test("accepts the three storage message contracts", () => {
  const workspaceKey = "notion:workspace-1";

  assert.deepEqual(
    validateStorageRequest({
      type: STORAGE_MESSAGE_TYPES.GET,
      payload: { workspaceKey }
    }),
    { type: STORAGE_MESSAGE_TYPES.GET, workspaceKey }
  );

  assert.deepEqual(
    validateStorageRequest({
      type: STORAGE_MESSAGE_TYPES.SET,
      payload: { workspaceKey, workspace: workspace(), expectedRevision: 3 }
    }),
    {
      type: STORAGE_MESSAGE_TYPES.SET,
      workspaceKey,
      workspace: workspace(),
      expectedRevision: 3
    }
  );

  assert.deepEqual(
    validateStorageRequest({
      type: STORAGE_MESSAGE_TYPES.RESET,
      payload: { workspaceKey }
    }),
    { type: STORAGE_MESSAGE_TYPES.RESET, workspaceKey }
  );
});

test("rejects unknown fields and malformed payloads", () => {
  assert.throws(
    () =>
      validateStorageRequest({
        type: STORAGE_MESSAGE_TYPES.GET,
        payload: { workspaceKey: "workspace-1", workspace: workspace() }
      }),
    StorageContractError
  );

  assert.throws(
    () =>
      validateStorageRequest({
        type: STORAGE_MESSAGE_TYPES.SET,
        payload: { workspaceKey: "workspace-1", workspace: workspace() }
      }),
    StorageContractError
  );

  assert.throws(
    () =>
      validateStorageRequest({
        type: STORAGE_MESSAGE_TYPES.SET,
        payload: {
          workspaceKey: "workspace-1",
          workspace: workspace(),
          expectedRevision: -1
        }
      }),
    StorageContractError
  );

  assert.throws(
    () =>
      validateStorageRequest({
        type: "NFS_STORAGE_DELETE_ALL",
        payload: { workspaceKey: "workspace-1" }
      }),
    StorageContractError
  );

  assert.throws(
    () =>
      validateStorageRequest({
        type: STORAGE_MESSAGE_TYPES.RESET,
        payload: { workspaceKey: "  " }
      }),
    StorageContractError
  );
});

test("workspace validation permits only the persisted tree fields", () => {
  assert.equal(validateWorkspace(workspace()).schemaVersion, 1);

  const withPageTitle = workspace();
  withPageTitle.groups[0].sections[0].favorites[0].title = "Must not be stored";
  assert.throws(() => validateWorkspace(withPageTitle), StorageContractError);

  const duplicateFavorite = workspace();
  duplicateFavorite.groups[0].sections.push({
    ...duplicateFavorite.groups[0].sections[0],
    id: "section-2",
    order: 1,
    system: false,
    favorites: [favorite()]
  });
  assert.throws(() => validateWorkspace(duplicateFavorite), /appears more than once/u);
});

test("decodes revision envelopes and treats a raw workspace as revision zero", () => {
  assert.deepEqual(validateStorageEnvelope({ revision: 4, workspace: workspace() }), {
    revision: 4,
    workspace: workspace()
  });
  assert.deepEqual(decodeStoredWorkspace({ revision: 4, workspace: workspace() }), {
    revision: 4,
    workspace: workspace(),
    legacy: false
  });
  assert.deepEqual(decodeStoredWorkspace(workspace()), {
    revision: 0,
    workspace: workspace(),
    legacy: true
  });
  assert.throws(
    () => validateStorageEnvelope({ revision: 1.5, workspace: workspace() }),
    StorageContractError
  );
});

test("storage keys are namespaced per validated workspace", () => {
  assert.equal(
    workspaceStorageKey("workspace:alpha"),
    "nfs:workspace:workspace:alpha"
  );
  assert.throws(() => workspaceStorageKey("\u0000workspace"), StorageContractError);
});

test("only this extension's app.notion.com content script is trusted", () => {
  const extensionId = "extension-id";
  const notionSender = {
    id: extensionId,
    url: "https://app.notion.com/workspace/page",
    tab: { url: "https://app.notion.com/workspace/page" }
  };

  assert.equal(isTrustedNotionSender(notionSender, extensionId), true);
  assert.equal(
    isTrustedNotionSender(
      { ...notionSender, url: "https://app.notion.com.evil.example/page" },
      extensionId
    ),
    false
  );
  assert.equal(
    isTrustedNotionSender({ ...notionSender, id: "another-extension" }, extensionId),
    false
  );
  assert.equal(isTrustedNotionSender({ id: extensionId }, extensionId), false);
});

test("background serializes tree and profile catalog CAS writes", async () => {
  const extensionId = "extension-id";
  const sender = {
    id: extensionId,
    url: "https://app.notion.com/workspace/page",
    tab: { url: "https://app.notion.com/workspace/page" }
  };
  const values = new Map();
  const messageListeners = [];
  const connectListeners = [];
  const broadcasts = [];

  globalThis.chrome = {
    runtime: {
      id: extensionId,
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener);
        }
      },
      onConnect: {
        addListener(listener) {
          connectListeners.push(listener);
        }
      }
    },
    storage: {
      local: {
        async setAccessLevel() {},
        async get(key) {
          return values.has(key) ? { [key]: values.get(key) } : {};
        },
        async set(entries) {
          for (const [key, value] of Object.entries(entries)) {
            values.set(key, structuredClone(value));
          }
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
        }
      }
    }
  };

  await import(`../src/background.js?cas-test=${Date.now()}`);
  assert.equal(messageListeners.length, 1);
  assert.equal(connectListeners.length, 1);

  const port = {
    name: "NFS_WORKSPACE_SYNC",
    sender,
    postMessage(message) {
      broadcasts.push(structuredClone(message));
    },
    disconnect() {},
    onDisconnect: { addListener() {} }
  };
  connectListeners[0](port);

  function request(message) {
    return new Promise((resolve) => {
      messageListeners[0](message, sender, resolve);
    });
  }

  const emptyCatalogResponse = await request({
    type: PROFILE_CATALOG_MESSAGE_TYPES.GET,
    payload: {}
  });
  assert.deepEqual(emptyCatalogResponse, {
    ok: true,
    catalog: createProfileCatalog(),
    revision: 0
  });

  const { catalog } = addLocalProfile(createProfileCatalog(), "업무 계정", {
    profileId: PROFILE_ID
  });
  const catalogSetMessage = {
    type: PROFILE_CATALOG_MESSAGE_TYPES.SET,
    payload: { catalog, expectedRevision: 0 }
  };
  const catalogResults = await Promise.all([
    request(catalogSetMessage),
    request(catalogSetMessage)
  ]);
  const catalogSuccess = catalogResults.find((result) => result.ok === true);
  const catalogConflict = catalogResults.find((result) => result.conflict === true);
  assert.deepEqual(catalogSuccess, { ok: true, catalog, revision: 1 });
  assert.deepEqual(catalogConflict, {
    ok: false,
    error: "Profile catalog changed in another tab. Reload the latest state and retry.",
    conflict: true,
    catalog,
    revision: 1
  });
  assert.deepEqual(values.get(PROFILE_CATALOG_STORAGE_KEY), {
    revision: 1,
    catalog
  });

  const legacyKey = workspaceStorageKey("workspace:legacy");
  values.set(legacyKey, workspace());
  const legacyResponse = await request({
    type: STORAGE_MESSAGE_TYPES.GET,
    payload: { workspaceKey: "workspace:legacy" }
  });
  assert.equal(legacyResponse.ok, true);
  assert.equal(legacyResponse.revision, 0);
  assert.deepEqual(values.get(legacyKey), {
    revision: 0,
    workspace: workspace()
  });

  const workspaceKey = "workspace:concurrent";
  const setMessage = {
    type: STORAGE_MESSAGE_TYPES.SET,
    payload: { workspaceKey, workspace: workspace(), expectedRevision: 0 }
  };
  const results = await Promise.all([request(setMessage), request(setMessage)]);
  const success = results.find((result) => result.ok === true);
  const conflict = results.find((result) => result.conflict === true);

  assert.equal(success.revision, 1);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.revision, 1);
  assert.deepEqual(conflict.workspace, workspace());
  assert.deepEqual(values.get(workspaceStorageKey(workspaceKey)), {
    revision: 1,
    workspace: workspace()
  });
  assert.deepEqual(broadcasts.at(-1), {
    type: "NFS_STORAGE_CHANGED",
    payload: { workspaceKey, workspace: workspace(), revision: 1 }
  });

  const resetResponse = await request({
    type: STORAGE_MESSAGE_TYPES.RESET,
    payload: { workspaceKey }
  });
  assert.deepEqual(resetResponse, { ok: true, revision: 0 });
  assert.equal(values.has(workspaceStorageKey(workspaceKey)), false);
  assert.deepEqual(broadcasts.at(-1), {
    type: "NFS_STORAGE_CHANGED",
    payload: { workspaceKey, revision: 0, reset: true }
  });

  delete globalThis.chrome;
});
