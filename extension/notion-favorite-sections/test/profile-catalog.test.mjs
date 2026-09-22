import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

await import("../src/profile-catalog.js");

const {
  PROFILE_CATALOG_MESSAGE_TYPES,
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
} = globalThis.NotionFavoriteSections.profileCatalog;

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROFILE_ID = "22222222-2222-4222-8222-222222222222";

test("loads as a classic content script and publishes the global catalog API", async () => {
  const source = await readFile(
    new URL("../src/profile-catalog.js", import.meta.url),
    "utf8"
  );
  const context = {};
  vm.runInNewContext(source, context, { filename: "profile-catalog.js" });

  assert.equal(
    typeof context.NotionFavoriteSections.profileCatalog.createProfileCatalog,
    "function"
  );
  assert.equal(
    context.NotionFavoriteSections.profileCatalog.PROFILE_CATALOG_SCHEMA_VERSION,
    1
  );
});

test("creates an explicit local profile and binds its workspace to a canonical tree key", () => {
  const empty = createProfileCatalog();
  assert.deepEqual(empty, {
    schemaVersion: 1,
    profiles: [],
    bindings: [],
    selections: []
  });

  const { catalog: withProfile, profile } = addLocalProfile(empty, "업무 계정", {
    profileId: PROFILE_ID
  });
  const bound = bindWorkspace(withProfile, {
    profileId: profile.id,
    workspaceKey: "workspace:id:team-alpha"
  });

  assert.deepEqual(profile, { id: PROFILE_ID, label: "업무 계정" });
  assert.deepEqual(bound.bindings, [
    { profileId: PROFILE_ID, workspaceKey: "workspace:id:team-alpha" }
  ]);
  assert.equal(
    canonicalTreeKey(PROFILE_ID, "workspace:id:team-alpha"),
    `profile:${PROFILE_ID}:workspace:workspace:id:team-alpha`
  );
  assert.deepEqual(empty, {
    schemaVersion: 1,
    profiles: [],
    bindings: [],
    selections: []
  });
});

test("rejects malformed catalogs and duplicate profile identities", () => {
  const empty = createProfileCatalog();

  assert.throws(
    () => addLocalProfile(empty, " ", { profileId: PROFILE_ID }),
    ProfileCatalogError
  );
  assert.throws(
    () => addLocalProfile(empty, "개인", { profileId: "not-a-uuid" }),
    ProfileCatalogError
  );

  const { catalog } = addLocalProfile(empty, "개인", { profileId: PROFILE_ID });
  assert.throws(
    () => addLocalProfile(catalog, "다른 이름", { profileId: PROFILE_ID }),
    /already exists/u
  );
  assert.throws(
    () => validateProfileCatalog({ ...catalog, unsupported: true }),
    /unsupported or missing fields/u
  );
});

test("keeps two explicit profiles isolated when they bind the same workspace", () => {
  const first = addLocalProfile(createProfileCatalog(), "업무 계정", {
    randomUUID: () => PROFILE_ID
  });
  const second = addLocalProfile(first.catalog, "개인 계정", {
    randomUUID: () => OTHER_PROFILE_ID
  });
  const firstBound = bindWorkspace(second.catalog, {
    profileId: PROFILE_ID,
    workspaceKey: "workspace:id:shared-team"
  });
  const bothBound = bindWorkspace(firstBound, {
    profileId: OTHER_PROFILE_ID,
    workspaceKey: "workspace:id:shared-team"
  });

  assert.equal(bothBound.profiles.length, 2);
  assert.equal(bothBound.bindings.length, 2);
  assert.notEqual(
    canonicalTreeKey(PROFILE_ID, "workspace:id:shared-team"),
    canonicalTreeKey(OTHER_PROFILE_ID, "workspace:id:shared-team")
  );
});

test("persists one explicit profile selection for a workspace with multiple profiles", () => {
  const first = addLocalProfile(createProfileCatalog(), "업무 계정", {
    profileId: PROFILE_ID
  });
  const second = addLocalProfile(first.catalog, "개인 계정", {
    profileId: OTHER_PROFILE_ID
  });
  const firstBound = bindWorkspace(second.catalog, {
    profileId: PROFILE_ID,
    workspaceKey: "workspace:id:shared-team"
  });
  const firstBoundAgain = bindWorkspace(firstBound, {
    profileId: PROFILE_ID,
    workspaceKey: "workspace:id:shared-team"
  });
  const bothBound = bindWorkspace(firstBoundAgain, {
    profileId: OTHER_PROFILE_ID,
    workspaceKey: "workspace:id:shared-team"
  });

  assert.equal(firstBoundAgain.bindings.length, 1);
  assert.deepEqual(
    profilesForWorkspace(bothBound, "workspace:id:shared-team").map(
      (profile) => profile.id
    ),
    [PROFILE_ID, OTHER_PROFILE_ID]
  );
  assert.equal(
    selectedProfileForWorkspace(bothBound, "workspace:id:shared-team"),
    null
  );

  const selected = selectProfileForWorkspace(bothBound, {
    profileId: OTHER_PROFILE_ID,
    workspaceKey: "workspace:id:shared-team"
  });
  assert.deepEqual(selected.selections, [
    { workspaceKey: "workspace:id:shared-team", profileId: OTHER_PROFILE_ID }
  ]);
  assert.deepEqual(
    selectedProfileForWorkspace(
      JSON.parse(JSON.stringify(selected)),
      "workspace:id:shared-team"
    ),
    { id: OTHER_PROFILE_ID, label: "개인 계정" }
  );
  assert.throws(
    () =>
      selectProfileForWorkspace(firstBound, {
        profileId: OTHER_PROFILE_ID,
        workspaceKey: "workspace:id:shared-team"
      }),
    /must be bound/u
  );
});

test("validates revisioned profile catalog storage messages and legacy raw catalogs", () => {
  const { catalog } = addLocalProfile(createProfileCatalog(), "업무 계정", {
    profileId: PROFILE_ID
  });

  assert.equal(PROFILE_CATALOG_STORAGE_KEY, "nfs:profile-catalog");
  assert.deepEqual(
    validateProfileCatalogRequest({
      type: PROFILE_CATALOG_MESSAGE_TYPES.GET,
      payload: {}
    }),
    { type: PROFILE_CATALOG_MESSAGE_TYPES.GET }
  );
  assert.deepEqual(
    validateProfileCatalogRequest({
      type: PROFILE_CATALOG_MESSAGE_TYPES.SET,
      payload: { catalog, expectedRevision: 3 }
    }),
    {
      type: PROFILE_CATALOG_MESSAGE_TYPES.SET,
      catalog,
      expectedRevision: 3
    }
  );
  assert.deepEqual(decodeStoredProfileCatalog(catalog), {
    revision: 0,
    catalog,
    legacy: true
  });
  assert.deepEqual(
    validateProfileCatalogEnvelope({ revision: 4, catalog }),
    { revision: 4, catalog }
  );
  assert.throws(
    () =>
      validateProfileCatalogRequest({
        type: PROFILE_CATALOG_MESSAGE_TYPES.GET,
        payload: { unsupported: true }
      }),
    ProfileCatalogError
  );
  assert.throws(
    () => validateProfileCatalogEnvelope({ revision: -1, catalog }),
    ProfileCatalogError
  );
});

test("plans but never executes or merges a v1 tree migration", () => {
  const { catalog: withProfile } = addLocalProfile(
    createProfileCatalog(),
    "이전 기본 프로필 확인",
    { profileId: PROFILE_ID }
  );
  const bound = bindWorkspace(withProfile, {
    profileId: PROFILE_ID,
    workspaceKey: "workspace:profile:default"
  });
  const selected = selectProfileForWorkspace(bound, {
    profileId: PROFILE_ID,
    workspaceKey: "workspace:profile:default"
  });
  const before = structuredClone(selected);

  assert.deepEqual(
    planV1TreeMigration(selected, {
      profileId: PROFILE_ID,
      workspaceKey: "workspace:profile:default"
    }),
    {
      fromSchemaVersion: 1,
      sourceTreeKey: "workspace:profile:default",
      targetTreeKey: `profile:${PROFILE_ID}:workspace:workspace:profile:default`,
      strategy: "copy-if-target-empty",
      merge: false,
      removeSource: false,
      requiresExplicitConfirmation: true,
      ambiguousLegacyDefault: true
    }
  );
  assert.deepEqual(selected, before);
  assert.throws(
    () =>
      planV1TreeMigration(bound, {
        profileId: PROFILE_ID,
        workspaceKey: "workspace:profile:default"
      }),
    /must be selected/u
  );
});
