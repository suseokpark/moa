(function initializeProfileCatalog(globalScope) {
  "use strict";

  const namespace = globalScope.NotionFavoriteSections || {};
  if (namespace.profileCatalog) {
    return;
  }

  const PROFILE_CATALOG_SCHEMA_VERSION = 1;
  const PROFILE_CATALOG_STORAGE_KEY = "nfs:profile-catalog";
  const LEGACY_DEFAULT_WORKSPACE_KEY = "workspace:profile:default";
  const PROFILE_CATALOG_MESSAGE_TYPES = Object.freeze({
    GET: "NFS_PROFILE_CATALOG_GET",
    SET: "NFS_PROFILE_CATALOG_SET"
  });
  const CATALOG_KEYS = ["schemaVersion", "profiles", "bindings", "selections"];
  const PROFILE_KEYS = ["id", "label"];
  const BINDING_KEYS = ["profileId", "workspaceKey"];
  const SELECTION_KEYS = ["workspaceKey", "profileId"];
  const CATALOG_ENVELOPE_KEYS = ["revision", "catalog"];
  const PROFILE_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const MAX_PROFILES = 100;
  const MAX_BINDINGS = 1_000;
  const MAX_PROFILE_LABEL_LENGTH = 80;
  const MAX_WORKSPACE_KEY_LENGTH = 256;

  class ProfileCatalogError extends Error {
    constructor(message) {
      super(message);
      this.name = "ProfileCatalogError";
    }
  }

  function fail(message) {
    throw new ProfileCatalogError(message);
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function assertExactKeys(value, expectedKeys, path) {
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (
      actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])
    ) {
      fail(`${path} contains unsupported or missing fields.`);
    }
  }

  function assertString(value, path, { min = 0, max } = {}) {
    if (typeof value !== "string" || value.length < min || value.length > max) {
      fail(`${path} must be a string between ${min} and ${max} characters.`);
    }
    if (/[\u0000-\u001f\u007f]/u.test(value)) {
      fail(`${path} must not contain control characters.`);
    }
  }

  function validateProfileId(profileId, path = "profileId") {
    if (typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId)) {
      fail(`${path} must be a canonical UUID v4.`);
    }
    return profileId;
  }

  function validateProfileLabel(label, path = "profile.label") {
    assertString(label, path, { min: 1, max: MAX_PROFILE_LABEL_LENGTH });
    if (label.trim() !== label) {
      fail(`${path} must not start or end with whitespace.`);
    }
    return label;
  }

  function validateWorkspaceKey(workspaceKey, path = "workspaceKey") {
    assertString(workspaceKey, path, { min: 1, max: MAX_WORKSPACE_KEY_LENGTH });
    if (workspaceKey.trim() !== workspaceKey) {
      fail(`${path} must not start or end with whitespace.`);
    }
    return workspaceKey;
  }

  function validateRevision(revision, path = "revision") {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      fail(`${path} must be a non-negative safe integer.`);
    }
    return revision;
  }

  function validateProfile(profile, path) {
    if (!isPlainObject(profile)) {
      fail(`${path} must be an object.`);
    }
    assertExactKeys(profile, PROFILE_KEYS, path);
    validateProfileId(profile.id, `${path}.id`);
    validateProfileLabel(profile.label, `${path}.label`);
    return profile;
  }

  function validateProfileCatalog(catalog) {
    if (!isPlainObject(catalog)) {
      fail("catalog must be an object.");
    }
    assertExactKeys(catalog, CATALOG_KEYS, "catalog");
    if (catalog.schemaVersion !== PROFILE_CATALOG_SCHEMA_VERSION) {
      fail(`catalog.schemaVersion must be ${PROFILE_CATALOG_SCHEMA_VERSION}.`);
    }
    if (!Array.isArray(catalog.profiles) || catalog.profiles.length > MAX_PROFILES) {
      fail("catalog.profiles must be a supported array.");
    }
    if (!Array.isArray(catalog.bindings) || catalog.bindings.length > MAX_BINDINGS) {
      fail("catalog.bindings must be a supported array.");
    }
    if (
      !Array.isArray(catalog.selections) ||
      catalog.selections.length > MAX_BINDINGS
    ) {
      fail("catalog.selections must be a supported array.");
    }

    const profileIds = new Set();
    for (const [index, profile] of catalog.profiles.entries()) {
      validateProfile(profile, `catalog.profiles[${index}]`);
      if (profileIds.has(profile.id)) {
        fail(`Profile id ${profile.id} already exists.`);
      }
      profileIds.add(profile.id);
    }

    const bindingKeys = new Set();
    for (const [index, binding] of catalog.bindings.entries()) {
      const path = `catalog.bindings[${index}]`;
      if (!isPlainObject(binding)) {
        fail(`${path} must be an object.`);
      }
      assertExactKeys(binding, BINDING_KEYS, path);
      validateProfileId(binding.profileId, `${path}.profileId`);
      validateWorkspaceKey(binding.workspaceKey, `${path}.workspaceKey`);
      if (!profileIds.has(binding.profileId)) {
        fail(`${path}.profileId must reference an existing profile.`);
      }
      const key = `${binding.profileId}\u0000${binding.workspaceKey}`;
      if (bindingKeys.has(key)) {
        fail(`${path} duplicates an existing workspace binding.`);
      }
      bindingKeys.add(key);
    }

    const selectedWorkspaces = new Set();
    for (const [index, selection] of catalog.selections.entries()) {
      const path = `catalog.selections[${index}]`;
      if (!isPlainObject(selection)) {
        fail(`${path} must be an object.`);
      }
      assertExactKeys(selection, SELECTION_KEYS, path);
      validateWorkspaceKey(selection.workspaceKey, `${path}.workspaceKey`);
      validateProfileId(selection.profileId, `${path}.profileId`);
      if (selectedWorkspaces.has(selection.workspaceKey)) {
        fail(`${path}.workspaceKey already has a selected profile.`);
      }
      if (!bindingKeys.has(`${selection.profileId}\u0000${selection.workspaceKey}`)) {
        fail(`${path}.profileId must be bound to its workspace.`);
      }
      selectedWorkspaces.add(selection.workspaceKey);
    }

    return catalog;
  }

  function createProfileCatalog() {
    return {
      schemaVersion: PROFILE_CATALOG_SCHEMA_VERSION,
      profiles: [],
      bindings: [],
      selections: []
    };
  }

  function validateProfileCatalogEnvelope(envelope) {
    if (!isPlainObject(envelope)) {
      fail("Stored profile catalog envelope must be an object.");
    }
    assertExactKeys(envelope, CATALOG_ENVELOPE_KEYS, "stored catalog envelope");
    return {
      revision: validateRevision(
        envelope.revision,
        "stored catalog envelope.revision"
      ),
      catalog: validateProfileCatalog(envelope.catalog)
    };
  }

  function decodeStoredProfileCatalog(value) {
    if (
      isPlainObject(value) &&
      Object.prototype.hasOwnProperty.call(value, "revision")
    ) {
      return {
        ...validateProfileCatalogEnvelope(value),
        legacy: false
      };
    }
    return {
      revision: 0,
      catalog: validateProfileCatalog(value),
      legacy: true
    };
  }

  function validateProfileCatalogRequest(message) {
    if (!isPlainObject(message)) {
      fail("Message must be an object.");
    }
    assertExactKeys(message, ["type", "payload"], "message");
    if (!Object.values(PROFILE_CATALOG_MESSAGE_TYPES).includes(message.type)) {
      fail("Message type is not supported by the profile catalog.");
    }
    if (!isPlainObject(message.payload)) {
      fail("message.payload must be an object.");
    }

    if (message.type === PROFILE_CATALOG_MESSAGE_TYPES.GET) {
      assertExactKeys(message.payload, [], "message.payload");
      return { type: message.type };
    }

    assertExactKeys(
      message.payload,
      ["catalog", "expectedRevision"],
      "message.payload"
    );
    return {
      type: message.type,
      catalog: validateProfileCatalog(message.payload.catalog),
      expectedRevision: validateRevision(
        message.payload.expectedRevision,
        "message.payload.expectedRevision"
      )
    };
  }

  function generateProfileId(randomUUID) {
    if (typeof randomUUID === "function") {
      return randomUUID();
    }
    if (typeof globalScope.crypto?.randomUUID === "function") {
      return globalScope.crypto.randomUUID();
    }
    fail("A secure UUID generator is required to create a local profile.");
  }

  function addLocalProfile(catalog, label, { profileId, randomUUID } = {}) {
    validateProfileCatalog(catalog);
    const resolvedProfileId =
      profileId === undefined ? generateProfileId(randomUUID) : profileId;
    validateProfileId(resolvedProfileId);
    validateProfileLabel(label);
    if (catalog.profiles.some((profile) => profile.id === resolvedProfileId)) {
      fail(`Profile id ${resolvedProfileId} already exists.`);
    }
    const profile = { id: resolvedProfileId, label };
    return {
      profile,
      catalog: {
        ...catalog,
        profiles: [...catalog.profiles, profile],
        bindings: [...catalog.bindings],
        selections: [...catalog.selections]
      }
    };
  }

  function bindWorkspace(catalog, { profileId, workspaceKey }) {
    validateProfileCatalog(catalog);
    validateProfileId(profileId);
    validateWorkspaceKey(workspaceKey);
    if (!catalog.profiles.some((profile) => profile.id === profileId)) {
      fail(`Profile id ${profileId} does not exist.`);
    }
    if (
      catalog.bindings.some(
        (binding) =>
          binding.profileId === profileId && binding.workspaceKey === workspaceKey
      )
    ) {
      return {
        ...catalog,
        profiles: [...catalog.profiles],
        bindings: [...catalog.bindings],
        selections: [...catalog.selections]
      };
    }
    return {
      ...catalog,
      profiles: [...catalog.profiles],
      bindings: [...catalog.bindings, { profileId, workspaceKey }],
      selections: [...catalog.selections]
    };
  }

  function profilesForWorkspace(catalog, workspaceKey) {
    validateProfileCatalog(catalog);
    validateWorkspaceKey(workspaceKey);
    const profileIds = new Set(
      catalog.bindings
        .filter((binding) => binding.workspaceKey === workspaceKey)
        .map((binding) => binding.profileId)
    );
    return catalog.profiles.filter((profile) => profileIds.has(profile.id));
  }

  function selectProfileForWorkspace(catalog, { profileId, workspaceKey }) {
    validateProfileCatalog(catalog);
    validateProfileId(profileId);
    validateWorkspaceKey(workspaceKey);
    if (
      !catalog.bindings.some(
        (binding) =>
          binding.profileId === profileId && binding.workspaceKey === workspaceKey
      )
    ) {
      fail("Selected profile must be bound to the workspace.");
    }

    const selection = { workspaceKey, profileId };
    const existingIndex = catalog.selections.findIndex(
      (candidate) => candidate.workspaceKey === workspaceKey
    );
    const selections = [...catalog.selections];
    if (existingIndex === -1) {
      selections.push(selection);
    } else {
      selections[existingIndex] = selection;
    }

    return {
      ...catalog,
      profiles: [...catalog.profiles],
      bindings: [...catalog.bindings],
      selections
    };
  }

  function selectedProfileForWorkspace(catalog, workspaceKey) {
    validateProfileCatalog(catalog);
    validateWorkspaceKey(workspaceKey);
    const selection = catalog.selections.find(
      (candidate) => candidate.workspaceKey === workspaceKey
    );
    if (!selection) {
      return null;
    }
    return (
      catalog.profiles.find((profile) => profile.id === selection.profileId) || null
    );
  }

  function planV1TreeMigration(catalog, { profileId, workspaceKey }) {
    validateProfileCatalog(catalog);
    validateProfileId(profileId);
    validateWorkspaceKey(workspaceKey);
    const selectedProfile = selectedProfileForWorkspace(catalog, workspaceKey);
    if (!selectedProfile || selectedProfile.id !== profileId) {
      fail("Migration target profile must be selected for the workspace.");
    }

    return {
      fromSchemaVersion: 1,
      sourceTreeKey: workspaceKey,
      targetTreeKey: canonicalTreeKey(profileId, workspaceKey),
      strategy: "copy-if-target-empty",
      merge: false,
      removeSource: false,
      requiresExplicitConfirmation: true,
      ambiguousLegacyDefault: workspaceKey === LEGACY_DEFAULT_WORKSPACE_KEY
    };
  }

  function canonicalTreeKey(profileId, workspaceKey) {
    validateProfileId(profileId);
    validateWorkspaceKey(workspaceKey);
    return `profile:${profileId}:workspace:${workspaceKey}`;
  }

  namespace.profileCatalog = Object.freeze({
    LEGACY_DEFAULT_WORKSPACE_KEY,
    PROFILE_CATALOG_MESSAGE_TYPES,
    PROFILE_CATALOG_SCHEMA_VERSION,
    PROFILE_CATALOG_STORAGE_KEY,
    ProfileCatalogError,
    addLocalProfile,
    bindWorkspace,
    canonicalTreeKey,
    createProfileCatalog,
    decodeStoredProfileCatalog,
    planV1TreeMigration,
    profilesForWorkspace,
    selectProfileForWorkspace,
    selectedProfileForWorkspace,
    validateProfileCatalog,
    validateProfileCatalogEnvelope,
    validateProfileCatalogRequest
  });
  globalScope.NotionFavoriteSections = namespace;
})(globalThis);
