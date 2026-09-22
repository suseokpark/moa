export const STORAGE_MESSAGE_TYPES = Object.freeze({
  GET: "NFS_STORAGE_GET",
  SET: "NFS_STORAGE_SET",
  RESET: "NFS_STORAGE_RESET"
});

export const METADATA_MESSAGE_TYPES = Object.freeze({
  GET: "NFS_METADATA_GET",
  MERGE: "NFS_METADATA_MERGE"
});

export const STORAGE_KEY_PREFIX = "nfs:workspace:";
export const METADATA_KEY_PREFIX = "nfs:metadata:";

const WORKSPACE_KEYS = ["schemaVersion", "groups"];
const GROUP_KEYS = [
  "id",
  "name",
  "color",
  "emoji",
  "collapsed",
  "order",
  "system",
  "sections"
];
const SECTION_KEYS = [
  "id",
  "name",
  "color",
  "emoji",
  "collapsed",
  "order",
  "system",
  "favorites"
];
const FAVORITE_KEYS = ["pageId", "order", "dormant", "updatedAt"];
const STORAGE_ENVELOPE_KEYS = ["revision", "workspace"];

const MAX_WORKSPACE_KEY_LENGTH = 256;
const MAX_GROUPS = 100;
const MAX_SECTIONS_PER_GROUP = 100;
const MAX_FAVORITES_PER_SECTION = 500;
const MAX_TOTAL_FAVORITES = 10_000;
const MAX_SERIALIZED_WORKSPACE_BYTES = 5 * 1024 * 1024;
const MAX_SERIALIZED_METADATA_BYTES = 5 * 1024 * 1024;

export class StorageContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageContractError";
  }
}

function fail(message) {
  throw new StorageContractError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expectedKeys, path) {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    fail(`${path} contains unsupported or missing fields.`);
  }
}

function assertString(value, path, { min = 0, max, pattern } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail(`${path} must be a string between ${min} and ${max} characters.`);
  }

  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${path} must not contain control characters.`);
  }

  if (pattern && !pattern.test(value)) {
    fail(`${path} has an unsupported format.`);
  }
}

function assertDisplayName(value, path) {
  assertString(value, path, { min: 1, max: 80 });
  if (value.trim() !== value) {
    fail(`${path} must not start or end with whitespace.`);
  }
}

function assertOrder(value, path) {
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
    fail(`${path} must be a non-negative integer.`);
  }
}

function assertBoolean(value, path) {
  if (typeof value !== "boolean") {
    fail(`${path} must be a boolean.`);
  }
}

export function validateRevision(revision, path = "revision") {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    fail(`${path} must be a non-negative safe integer.`);
  }

  return revision;
}

function assertId(value, path) {
  assertString(value, path, {
    min: 1,
    max: 160
  });

  if (value.trim() !== value) {
    fail(`${path} must not start or end with whitespace.`);
  }
}

function assertFavorite(value, path, seenPageIds) {
  if (!isPlainObject(value)) {
    fail(`${path} must be an object.`);
  }

  assertExactKeys(value, FAVORITE_KEYS, path);
  assertId(value.pageId, `${path}.pageId`);
  assertOrder(value.order, `${path}.order`);
  assertBoolean(value.dormant, `${path}.dormant`);
  assertString(value.updatedAt, `${path}.updatedAt`, { min: 20, max: 40 });

  if (!Number.isFinite(Date.parse(value.updatedAt))) {
    fail(`${path}.updatedAt must be an ISO-compatible date string.`);
  }

  if (seenPageIds.has(value.pageId)) {
    fail(`Favorite pageId ${value.pageId} appears more than once.`);
  }
  seenPageIds.add(value.pageId);
}

function assertSection(value, path, seenSectionIds, seenPageIds, counters) {
  if (!isPlainObject(value)) {
    fail(`${path} must be an object.`);
  }

  assertExactKeys(value, SECTION_KEYS, path);
  assertId(value.id, `${path}.id`);
  assertDisplayName(value.name, `${path}.name`);
  assertString(value.color, `${path}.color`, { max: 32 });
  assertString(value.emoji, `${path}.emoji`, { max: 16 });
  assertBoolean(value.collapsed, `${path}.collapsed`);
  assertOrder(value.order, `${path}.order`);
  assertBoolean(value.system, `${path}.system`);

  if (seenSectionIds.has(value.id)) {
    fail(`Section id ${value.id} appears more than once.`);
  }
  seenSectionIds.add(value.id);

  if (!Array.isArray(value.favorites)) {
    fail(`${path}.favorites must be an array.`);
  }
  if (value.favorites.length > MAX_FAVORITES_PER_SECTION) {
    fail(`${path}.favorites exceeds the supported item count.`);
  }

  value.favorites.forEach((favorite, index) => {
    counters.favoriteCount += 1;
    if (counters.favoriteCount > MAX_TOTAL_FAVORITES) {
      fail("Workspace exceeds the supported Favorite count.");
    }
    assertFavorite(favorite, `${path}.favorites[${index}]`, seenPageIds);
  });
}

function assertGroup(value, path, seenGroupIds, seenSectionIds, seenPageIds, counters) {
  if (!isPlainObject(value)) {
    fail(`${path} must be an object.`);
  }

  assertExactKeys(value, GROUP_KEYS, path);
  assertId(value.id, `${path}.id`);
  assertDisplayName(value.name, `${path}.name`);
  assertString(value.color, `${path}.color`, { max: 32 });
  assertString(value.emoji, `${path}.emoji`, { max: 16 });
  assertBoolean(value.collapsed, `${path}.collapsed`);
  assertOrder(value.order, `${path}.order`);
  assertBoolean(value.system, `${path}.system`);

  if (seenGroupIds.has(value.id)) {
    fail(`Group id ${value.id} appears more than once.`);
  }
  seenGroupIds.add(value.id);

  if (!Array.isArray(value.sections)) {
    fail(`${path}.sections must be an array.`);
  }
  if (value.sections.length > MAX_SECTIONS_PER_GROUP) {
    fail(`${path}.sections exceeds the supported item count.`);
  }

  value.sections.forEach((section, index) => {
    assertSection(
      section,
      `${path}.sections[${index}]`,
      seenSectionIds,
      seenPageIds,
      counters
    );
  });
}

export function validateWorkspaceKey(workspaceKey) {
  assertString(workspaceKey, "payload.workspaceKey", {
    min: 1,
    max: MAX_WORKSPACE_KEY_LENGTH
  });

  if (workspaceKey.trim() !== workspaceKey) {
    fail("payload.workspaceKey must not start or end with whitespace.");
  }

  return workspaceKey;
}

export function validateWorkspace(workspace) {
  if (!isPlainObject(workspace)) {
    fail("payload.workspace must be an object.");
  }

  assertExactKeys(workspace, WORKSPACE_KEYS, "payload.workspace");
  if (workspace.schemaVersion !== 1) {
    fail("payload.workspace.schemaVersion must be 1.");
  }
  if (!Array.isArray(workspace.groups)) {
    fail("payload.workspace.groups must be an array.");
  }
  if (workspace.groups.length > MAX_GROUPS) {
    fail("payload.workspace.groups exceeds the supported item count.");
  }

  const seenGroupIds = new Set();
  const seenSectionIds = new Set();
  const seenPageIds = new Set();
  const counters = { favoriteCount: 0 };

  workspace.groups.forEach((group, index) => {
    assertGroup(
      group,
      `payload.workspace.groups[${index}]`,
      seenGroupIds,
      seenSectionIds,
      seenPageIds,
      counters
    );
  });

  const serializedBytes = new TextEncoder().encode(JSON.stringify(workspace)).byteLength;
  if (serializedBytes > MAX_SERIALIZED_WORKSPACE_BYTES) {
    fail("payload.workspace exceeds the supported storage size.");
  }

  return workspace;
}

export function validateStorageEnvelope(envelope) {
  if (!isPlainObject(envelope)) {
    fail("Stored workspace envelope must be an object.");
  }

  assertExactKeys(envelope, STORAGE_ENVELOPE_KEYS, "stored envelope");
  return {
    revision: validateRevision(envelope.revision, "stored envelope.revision"),
    workspace: validateWorkspace(envelope.workspace)
  };
}

export function decodeStoredWorkspace(value) {
  if (
    isPlainObject(value) &&
    Object.prototype.hasOwnProperty.call(value, "revision")
  ) {
    const envelope = validateStorageEnvelope(value);
    return { ...envelope, legacy: false };
  }

  return {
    revision: 0,
    workspace: validateWorkspace(value),
    legacy: true
  };
}

export function validateMetadataEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_TOTAL_FAVORITES) {
    fail("Metadata entries must be an array within the supported Favorite count.");
  }
  const seenPageIds = new Set();
  entries.forEach((entry, index) => {
    const path = `metadata[${index}]`;
    if (!isPlainObject(entry)) fail(`${path} must be an object.`);
    assertExactKeys(entry, ["pageId", "title", "icon"], path);
    assertString(entry.pageId, `${path}.pageId`, { min: 32, max: 32, pattern: /^[0-9a-f]{32}$/u });
    assertString(entry.title, `${path}.title`, { min: 1, max: 300 });
    assertString(entry.icon, `${path}.icon`, { max: 64 });
    if (!entry.title.trim() || /[\u0080-\u009f]/u.test(entry.title + entry.icon)) {
      fail(`${path} must contain a nonblank title and no control characters.`);
    }
    if (seenPageIds.has(entry.pageId)) fail(`${path}.pageId appears more than once.`);
    seenPageIds.add(entry.pageId);
  });
  if (new TextEncoder().encode(JSON.stringify(entries)).byteLength > MAX_SERIALIZED_METADATA_BYTES) {
    fail("Metadata exceeds the supported storage size.");
  }
  return entries;
}

export function validateStorageRequest(message) {
  if (!isPlainObject(message)) {
    fail("Message must be an object.");
  }
  assertExactKeys(message, ["type", "payload"], "message");

  if (![...Object.values(STORAGE_MESSAGE_TYPES), ...Object.values(METADATA_MESSAGE_TYPES)].includes(message.type)) {
    fail("Message type is not supported.");
  }
  if (!isPlainObject(message.payload)) {
    fail("message.payload must be an object.");
  }

  const isSet = message.type === STORAGE_MESSAGE_TYPES.SET;
  const isMetadataMerge = message.type === METADATA_MESSAGE_TYPES.MERGE;
  assertExactKeys(
    message.payload,
    isSet
      ? ["workspaceKey", "workspace", "expectedRevision"]
      : isMetadataMerge ? ["workspaceKey", "entries"] : ["workspaceKey"],
    "message.payload"
  );

  const request = {
    type: message.type,
    workspaceKey: validateWorkspaceKey(message.payload.workspaceKey)
  };

  if (isSet) {
    request.workspace = validateWorkspace(message.payload.workspace);
    request.expectedRevision = validateRevision(
      message.payload.expectedRevision,
      "message.payload.expectedRevision"
    );
  }
  if (isMetadataMerge) {
    request.entries = validateMetadataEntries(message.payload.entries);
  }

  return request;
}

export function workspaceStorageKey(workspaceKey) {
  return `${STORAGE_KEY_PREFIX}${validateWorkspaceKey(workspaceKey)}`;
}

export function metadataStorageKey(workspaceKey) {
  return `${METADATA_KEY_PREFIX}${validateWorkspaceKey(workspaceKey)}`;
}

export function isTrustedNotionSender(sender, extensionId) {
  if (!sender || sender.id !== extensionId || !sender.tab) {
    return false;
  }

  const candidateUrl = sender.url || sender.tab.url;
  if (typeof candidateUrl !== "string") {
    return false;
  }

  try {
    const url = new URL(candidateUrl);
    return url.protocol === "https:" && url.hostname === "app.notion.com";
  } catch {
    return false;
  }
}
