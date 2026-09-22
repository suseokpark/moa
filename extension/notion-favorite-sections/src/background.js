import {
  STORAGE_MESSAGE_TYPES,
  METADATA_MESSAGE_TYPES,
  decodeStoredWorkspace,
  isTrustedNotionSender,
  metadataStorageKey,
  validateMetadataEntries,
  validateStorageRequest,
  workspaceStorageKey
} from "./storage-contract.js";
import "./profile-catalog.js";

const {
  PROFILE_CATALOG_MESSAGE_TYPES,
  PROFILE_CATALOG_STORAGE_KEY,
  createProfileCatalog,
  decodeStoredProfileCatalog,
  validateProfileCatalogRequest
} = globalThis.NotionFavoriteSections.profileCatalog;

const storageAccessReady = configureStorageAccess();
const workspaceSyncPorts = new Set();
const workspaceQueues = new Map();
let profileCatalogQueue = Promise.resolve();

function broadcastWorkspaceChange(workspaceKey, workspace, revision, reset = false) {
  const message = {
    type: "NFS_STORAGE_CHANGED",
    payload: { workspaceKey, revision }
  };
  if (workspace) {
    message.payload.workspace = workspace;
  }
  if (reset) {
    message.payload.reset = true;
  }

  for (const port of [...workspaceSyncPorts]) {
    try {
      port.postMessage(message);
    } catch {
      workspaceSyncPorts.delete(port);
    }
  }
}

function enqueueWorkspace(workspaceKey, operation) {
  const previous = workspaceQueues.get(workspaceKey) || Promise.resolve();
  const queued = previous.catch(() => undefined).then(operation);
  workspaceQueues.set(workspaceKey, queued);

  const cleanup = () => {
    if (workspaceQueues.get(workspaceKey) === queued) {
      workspaceQueues.delete(workspaceKey);
    }
  };
  queued.then(cleanup, cleanup);
  return queued;
}

function enqueueProfileCatalog(operation) {
  const queued = profileCatalogQueue.catch(() => undefined).then(operation);
  profileCatalogQueue = queued;
  return queued;
}

async function configureStorageAccess() {
  if (typeof chrome.storage.local.setAccessLevel !== "function") {
    console.error("Moa requires chrome.storage.local.setAccessLevel.");
    return false;
  }

  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    return true;
  } catch (error) {
    console.error("Could not restrict extension storage access.", error);
    return false;
  }
}

function errorResponse(error) {
  const message = error instanceof Error ? error.message : "Unexpected storage error.";
  return { ok: false, error: message };
}

async function readStoredWorkspace(storageKey) {
  const stored = await chrome.storage.local.get(storageKey);
  if (!Object.prototype.hasOwnProperty.call(stored, storageKey)) {
    return { revision: 0, workspace: undefined };
  }

  const decoded = decodeStoredWorkspace(stored[storageKey]);
  if (decoded.legacy) {
    await chrome.storage.local.set({
      [storageKey]: {
        revision: decoded.revision,
        workspace: decoded.workspace
      }
    });
  }

  return {
    revision: decoded.revision,
    workspace: decoded.workspace
  };
}

function managedPageIds(workspace) {
  return new Set((workspace?.groups || []).flatMap(group =>
    group.sections.flatMap(section => section.favorites.map(favorite => favorite.pageId))
  ));
}

async function readStoredMetadata(storageKey) {
  const stored = await chrome.storage.local.get(storageKey);
  try {
    return validateMetadataEntries(stored[storageKey]).map(({ pageId, title, icon }) => ({ pageId, title, icon }));
  } catch {
    // Display-cache corruption must not prevent the managed tree from loading.
    return [];
  }
}

async function executeMetadataRequest(request) {
  const current = await readStoredWorkspace(workspaceStorageKey(request.workspaceKey));
  const allowedIds = managedPageIds(current.workspace);
  const storageKey = metadataStorageKey(request.workspaceKey);
  const stored = await readStoredMetadata(storageKey);
  const metadata = new Map(stored.filter(entry => allowedIds.has(entry.pageId)).map(entry => [entry.pageId, entry]));
  if (request.type === METADATA_MESSAGE_TYPES.MERGE) {
    for (const { pageId, title, icon } of request.entries) {
      if (allowedIds.has(pageId)) metadata.set(pageId, { pageId, title, icon });
    }
    const entries = validateMetadataEntries([...metadata.values()]);
    if (JSON.stringify(entries) !== JSON.stringify(stored)) {
      await chrome.storage.local.set({ [storageKey]: entries });
    }
  }
  return { ok: true, metadata: [...metadata.values()] };
}

async function readStoredProfileCatalog() {
  const stored = await chrome.storage.local.get(PROFILE_CATALOG_STORAGE_KEY);
  if (!Object.prototype.hasOwnProperty.call(stored, PROFILE_CATALOG_STORAGE_KEY)) {
    return { revision: 0, catalog: createProfileCatalog() };
  }

  const decoded = decodeStoredProfileCatalog(stored[PROFILE_CATALOG_STORAGE_KEY]);
  if (decoded.legacy) {
    await chrome.storage.local.set({
      [PROFILE_CATALOG_STORAGE_KEY]: {
        revision: decoded.revision,
        catalog: decoded.catalog
      }
    });
  }
  return { revision: decoded.revision, catalog: decoded.catalog };
}

async function executeProfileCatalogRequest(request) {
  const current = await readStoredProfileCatalog();
  if (request.type === PROFILE_CATALOG_MESSAGE_TYPES.GET) {
    return {
      ok: true,
      catalog: current.catalog,
      revision: current.revision
    };
  }

  if (request.expectedRevision !== current.revision) {
    return {
      ok: false,
      error: "Profile catalog changed in another tab. Reload the latest state and retry.",
      conflict: true,
      catalog: current.catalog,
      revision: current.revision
    };
  }
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error("Profile catalog revision cannot be incremented safely.");
  }

  const revision = current.revision + 1;
  await chrome.storage.local.set({
    [PROFILE_CATALOG_STORAGE_KEY]: { revision, catalog: request.catalog }
  });
  return { ok: true, catalog: request.catalog, revision };
}

async function dispatchProfileCatalogRequest(request) {
  if (!(await storageAccessReady)) {
    throw new Error("Extension storage is unavailable.");
  }
  return enqueueProfileCatalog(() => executeProfileCatalogRequest(request));
}

async function executeStorageRequest(request) {
  const storageKey = workspaceStorageKey(request.workspaceKey);

  switch (request.type) {
    case METADATA_MESSAGE_TYPES.GET:
    case METADATA_MESSAGE_TYPES.MERGE:
      return executeMetadataRequest(request);

    case STORAGE_MESSAGE_TYPES.GET: {
      const current = await readStoredWorkspace(storageKey);
      const response = { ok: true, revision: current.revision };
      if (current.workspace) {
        response.workspace = current.workspace;
      }
      return response;
    }

    case STORAGE_MESSAGE_TYPES.SET: {
      const current = await readStoredWorkspace(storageKey);
      if (request.expectedRevision !== current.revision) {
        const response = {
          ok: false,
          error: "Workspace changed in another tab. Reload the latest state and retry.",
          conflict: true,
          revision: current.revision
        };
        if (current.workspace) {
          response.workspace = current.workspace;
        }
        return response;
      }

      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new Error("Workspace revision cannot be incremented safely.");
      }

      const revision = current.revision + 1;
      const cacheKey = metadataStorageKey(request.workspaceKey);
      const metadata = await readStoredMetadata(cacheKey);
      const allowedIds = managedPageIds(request.workspace);
      const retained = metadata.filter(entry => allowedIds.has(entry.pageId));
      const changes = { [storageKey]: { revision, workspace: request.workspace } };
      if (allowedIds.size === 0 || retained.length !== metadata.length) {
        changes[cacheKey] = retained;
      }
      // Commit cache pruning with the tree so later queued merges see one state.
      await chrome.storage.local.set(changes);
      broadcastWorkspaceChange(
        request.workspaceKey,
        request.workspace,
        revision
      );
      return { ok: true, workspace: request.workspace, revision };
    }

    case STORAGE_MESSAGE_TYPES.RESET:
      await chrome.storage.local.remove([storageKey, metadataStorageKey(request.workspaceKey)]);
      broadcastWorkspaceChange(request.workspaceKey, undefined, 0, true);
      return { ok: true, revision: 0 };

    default:
      throw new Error("Unsupported storage request.");
  }
}

async function dispatchStorageRequest(request) {
  if (!(await storageAccessReady)) {
    throw new Error("Extension storage is unavailable.");
  }

  return enqueueWorkspace(request.workspaceKey, () =>
    executeStorageRequest(request)
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedNotionSender(sender, chrome.runtime.id)) {
    sendResponse({ ok: false, error: "Storage request was not sent by a Notion content script." });
    return false;
  }

  let request;
  let dispatch;
  try {
    if (Object.values(PROFILE_CATALOG_MESSAGE_TYPES).includes(message?.type)) {
      request = validateProfileCatalogRequest(message);
      dispatch = dispatchProfileCatalogRequest;
    } else {
      request = validateStorageRequest(message);
      dispatch = dispatchStorageRequest;
    }
  } catch (error) {
    sendResponse(errorResponse(error));
    return false;
  }

  dispatch(request)
    .then(sendResponse)
    .catch((error) => sendResponse(errorResponse(error)));

  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (
    port.name !== "NFS_WORKSPACE_SYNC" ||
    !isTrustedNotionSender(port.sender, chrome.runtime.id)
  ) {
    port.disconnect();
    return;
  }

  workspaceSyncPorts.add(port);
  port.onDisconnect.addListener(() => {
    workspaceSyncPorts.delete(port);
  });
});
