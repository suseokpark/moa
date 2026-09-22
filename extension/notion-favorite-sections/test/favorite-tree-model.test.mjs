import assert from "node:assert/strict";
import test from "node:test";

await import("../src/favorite-tree-model.js");

const model = globalThis.NotionFavoriteSections.model;
const {
  DEFAULT_DORMANT_RETENTION_MS,
  MAX_NAME_LENGTH,
  SYSTEM_GROUP_ID,
  addFavorite,
  addFavorites,
  assertValidWorkspace,
  createGroup,
  createSection,
  createWorkspace,
  deleteGroup,
  deleteSection,
  getCounts,
  getSystemSectionId,
  moveFavorite,
  moveGroup,
  moveSection,
  normalizeWorkspace,
  reconcileFavorites,
  reconcileManagedFavorites,
  removeFavorite,
  renameGroup,
  renameSection,
  toggleGroup,
  toggleSection,
} = model;

function systemGroup(workspace) {
  return workspace.groups.find((group) => group.id === SYSTEM_GROUP_ID);
}

function group(workspace, groupId) {
  return workspace.groups.find((candidate) => candidate.id === groupId);
}

function section(workspace, sectionId) {
  return workspace.groups
    .flatMap((candidate) => candidate.sections)
    .find((candidate) => candidate.id === sectionId);
}

function favoriteLocations(workspace, pageId) {
  const locations = [];
  for (const candidateGroup of workspace.groups) {
    for (const candidateSection of candidateGroup.sections) {
      candidateSection.favorites.forEach((favorite, index) => {
        if (favorite.pageId === pageId) {
          locations.push({
            groupId: candidateGroup.id,
            sectionId: candidateSection.id,
            index,
            favorite,
          });
        }
      });
    }
  }
  return locations;
}

function withWorkStructure() {
  let workspace = createWorkspace();
  workspace = createGroup(workspace, {
    id: "work",
    name: "업무",
    color: "purple",
    emoji: "💼",
  });
  workspace = createSection(workspace, "work", {
    id: "doing",
    name: "지금 하는 일",
    color: "red",
  });
  workspace = createSection(workspace, "work", {
    id: "reference",
    name: "참고 자료",
  });
  return workspace;
}

test("IIFE installs the model API without ES module exports", () => {
  assert.equal(typeof globalThis.NotionFavoriteSections, "object");
  assert.equal(typeof model.createWorkspace, "function");
  assert.equal(Object.isFrozen(model), true);
});

test("createWorkspace creates the protected unclassified path", () => {
  const workspace = createWorkspace();
  const fallbackGroup = systemGroup(workspace);

  assert.equal(workspace.schemaVersion, 1);
  assert.equal(workspace.groups.length, 1);
  assert.deepEqual(
    {
      id: fallbackGroup.id,
      name: fallbackGroup.name,
      system: fallbackGroup.system,
      order: fallbackGroup.order,
    },
    {
      id: SYSTEM_GROUP_ID,
      name: "미분류 그룹",
      system: true,
      order: 0,
    },
  );
  assert.deepEqual(
    fallbackGroup.sections.map(({ id, name, system, order }) => ({
      id,
      name,
      system,
      order,
    })),
    [
      {
        id: getSystemSectionId(SYSTEM_GROUP_ID),
        name: "미분류 섹션",
        system: true,
        order: 0,
      },
    ],
  );
  assert.equal(assertValidWorkspace(workspace), true);
});

test("group operations return immutable clones and preserve system placement", () => {
  const original = createWorkspace();
  let workspace = createGroup(original, {
    id: "work",
    name: "업무",
    collapsed: false,
  });
  workspace = createGroup(workspace, { id: "personal", name: "개인" });

  assert.equal(original.groups.length, 1);
  assert.notEqual(workspace, original);
  assert.deepEqual(
    workspace.groups.map(({ id }) => id),
    ["work", "personal", SYSTEM_GROUP_ID],
  );
  assert.equal(group(workspace, "work").sections.at(-1).system, true);

  const beforeRename = workspace;
  workspace = renameGroup(workspace, "work", "핵심 업무");
  workspace = toggleGroup(workspace, "work");
  workspace = moveGroup(workspace, "personal", 0);

  assert.equal(group(beforeRename, "work").name, "업무");
  assert.equal(group(beforeRename, "work").collapsed, false);
  assert.equal(group(workspace, "work").name, "핵심 업무");
  assert.equal(group(workspace, "work").collapsed, true);
  assert.deepEqual(
    workspace.groups.map(({ id, order }) => [id, order]),
    [
      ["personal", 0],
      ["work", 1],
      [SYSTEM_GROUP_ID, 2],
    ],
  );
  assert.equal(assertValidWorkspace(workspace), true);
});

test("group and section collapse independently", () => {
  let workspace = withWorkStructure();
  workspace = toggleGroup(workspace, "work", true);
  workspace = toggleSection(workspace, "doing", true);

  assert.equal(group(workspace, "work").collapsed, true);
  assert.equal(section(workspace, "doing").collapsed, true);
  assert.equal(section(workspace, "reference").collapsed, false);

  workspace = toggleGroup(workspace, "work", false);
  assert.equal(group(workspace, "work").collapsed, false);
  assert.equal(section(workspace, "doing").collapsed, true);
});

test("sections can be renamed, reordered, and moved between groups with state intact", () => {
  let workspace = withWorkStructure();
  workspace = createGroup(workspace, { id: "personal", name: "개인" });
  workspace = renameSection(workspace, "reference", "자료실");
  workspace = toggleSection(workspace, "reference", true);
  workspace = moveSection(workspace, "reference", "work", 0);

  assert.deepEqual(
    group(workspace, "work").sections.map(({ id }) => id),
    ["reference", "doing", getSystemSectionId("work")],
  );

  workspace = moveSection(workspace, "reference", "personal", 0);
  assert.deepEqual(
    group(workspace, "personal").sections.map(({ id }) => id),
    ["reference", getSystemSectionId("personal")],
  );
  assert.equal(section(workspace, "reference").name, "자료실");
  assert.equal(section(workspace, "reference").collapsed, true);
  assert.equal(group(workspace, "work").sections.at(-1).system, true);
  assert.equal(assertValidWorkspace(workspace), true);
});

test("beforeId positions stay correct when the source starts before the target", () => {
  let workspace = withWorkStructure();
  workspace = createGroup(workspace, { id: "personal", name: "개인" });
  workspace = createGroup(workspace, { id: "archive", name: "보관" });
  workspace = moveGroup(workspace, "work", { beforeId: "archive" });
  assert.deepEqual(
    workspace.groups.map(({ id }) => id),
    ["personal", "work", "archive", SYSTEM_GROUP_ID],
  );

  workspace = createSection(workspace, "work", { id: "later", name: "나중" });
  workspace = moveSection(workspace, "doing", "work", { beforeId: "later" });
  assert.deepEqual(
    group(workspace, "work").sections.map(({ id }) => id),
    ["reference", "doing", "later", getSystemSectionId("work")],
  );

  workspace = reconcileFavorites(workspace, ["page-a", "page-b", "page-c"], {
    now: "2026-08-31T00:00:00.000Z",
  });
  for (const pageId of ["page-a", "page-b", "page-c"]) {
    workspace = moveFavorite(workspace, pageId, "doing");
  }
  workspace = moveFavorite(workspace, "page-a", "doing", { beforeId: "page-c" });
  assert.deepEqual(
    section(workspace, "doing").favorites.map(({ pageId }) => pageId),
    ["page-b", "page-a", "page-c"],
  );
});

test("addFavorite explicitly adds one immutable Favorite to the system fallback", () => {
  const original = createWorkspace();
  const added = addFavorite(original, "page-a", {
    now: "2026-08-31T02:00:00.000Z",
  });
  const duplicate = addFavorite(added, "page-a", {
    now: "2026-08-31T03:00:00.000Z",
  });

  assert.equal(favoriteLocations(original, "page-a").length, 0);
  assert.notEqual(added, original);
  assert.notEqual(duplicate, added);
  assert.deepEqual(
    systemGroup(duplicate).sections.at(-1).favorites.map(({ pageId }) => pageId),
    ["page-a"],
  );
  assert.equal(favoriteLocations(duplicate, "page-a").at(0).favorite.dormant, false);
  assert.equal(assertValidWorkspace(duplicate), true);
});

test("addFavorite can place a newly managed Favorite in a selected section", () => {
  const original = withWorkStructure();
  const workspace = addFavorite(original, "page-a", {
    sectionId: "doing",
    now: "2026-08-31T04:00:00.000Z",
  });

  assert.equal(favoriteLocations(original, "page-a").length, 0);
  assert.deepEqual(favoriteLocations(workspace, "page-a").map(({ sectionId }) => sectionId), [
    "doing",
  ]);
  assert.equal(
    favoriteLocations(workspace, "page-a").at(0).favorite.updatedAt,
    "2026-08-31T04:00:00.000Z",
  );
});

test("addFavorites atomically adds normalized unique Favorites to an explicit section", () => {
  const original = withWorkStructure();
  const workspace = addFavorites(
    original,
    [" page-a ", "page-b", "page-a"],
    {
      sectionId: "doing",
      now: "2026-08-31T05:00:00.000Z",
    },
  );

  assert.equal(favoriteLocations(original, "page-a").length, 0);
  assert.notEqual(workspace, original);
  assert.deepEqual(
    section(workspace, "doing").favorites.map(
      ({ pageId, updatedAt, dormant }) => ({ pageId, updatedAt, dormant }),
    ),
    [
      {
        pageId: "page-a",
        updatedAt: "2026-08-31T05:00:00.000Z",
        dormant: false,
      },
      {
        pageId: "page-b",
        updatedAt: "2026-08-31T05:00:00.000Z",
        dormant: false,
      },
    ],
  );
  assert.equal(assertValidWorkspace(workspace), true);
});

test("addFavorites rejects an empty pageIds array without mutating the workspace", () => {
  const original = withWorkStructure();
  const snapshot = structuredClone(original);

  assert.throws(
    () => addFavorites(original, [], { sectionId: "doing" }),
    (error) => error.code === "EMPTY_PAGE_IDS",
  );
  assert.deepEqual(original, snapshot);
});

test("addFavorites requires pageIds to be an array", () => {
  const workspace = withWorkStructure();

  assert.throws(
    () => addFavorites(workspace, "page-a", { sectionId: "doing" }),
    (error) => error.code === "INVALID_PAGE_IDS",
  );
});

test("addFavorites rejects every invalid pageId before adding any Favorite", () => {
  const original = withWorkStructure();
  const snapshot = structuredClone(original);

  assert.throws(
    () =>
      addFavorites(original, ["page-a", "  "], {
        sectionId: "doing",
      }),
    (error) => error.code === "INVALID_PAGE_ID",
  );
  assert.deepEqual(original, snapshot);
  assert.equal(favoriteLocations(original, "page-a").length, 0);
});

test("addFavorites requires an explicit non-empty sectionId", () => {
  const original = withWorkStructure();

  for (const options of [{}, { sectionId: "  " }]) {
    assert.throws(
      () => addFavorites(original, ["page-a"], options),
      (error) => error.code === "INVALID_SECTION_ID",
    );
  }
  assert.equal(favoriteLocations(original, "page-a").length, 0);
});

test("addFavorites leaves the original untouched when its destination section is missing", () => {
  const original = withWorkStructure();
  const snapshot = structuredClone(original);

  assert.throws(
    () =>
      addFavorites(original, ["page-a", "page-b"], {
        sectionId: "missing-section",
      }),
    (error) => error.code === "SECTION_NOT_FOUND",
  );
  assert.deepEqual(original, snapshot);
  assert.equal(favoriteLocations(original, "page-a").length, 0);
  assert.equal(favoriteLocations(original, "page-b").length, 0);
});

test("addFavorites reactivates an existing Favorite in place and adds only new IDs to the destination", () => {
  let original = withWorkStructure();
  original = addFavorite(original, "page-a", {
    sectionId: "doing",
    now: "2026-08-29T00:00:00.000Z",
  });
  original = reconcileManagedFavorites(original, [], {
    now: "2026-08-30T00:00:00.000Z",
    dormantRetentionMs: Infinity,
  });

  const workspace = addFavorites(original, ["page-a", "page-b"], {
    sectionId: "reference",
    now: "2026-08-31T06:00:00.000Z",
  });

  assert.deepEqual(
    favoriteLocations(workspace, "page-a").map(({ sectionId, favorite }) => ({
      sectionId,
      dormant: favorite.dormant,
      updatedAt: favorite.updatedAt,
    })),
    [
      {
        sectionId: "doing",
        dormant: false,
        updatedAt: "2026-08-31T06:00:00.000Z",
      },
    ],
  );
  assert.deepEqual(
    favoriteLocations(workspace, "page-b").map(({ sectionId }) => sectionId),
    ["reference"],
  );
  assert.equal(favoriteLocations(workspace, "page-a").length, 1);
});

test("addFavorites expands the explicit destination group and section", () => {
  let original = withWorkStructure();
  original = toggleGroup(original, "work", true);
  original = toggleSection(original, "doing", true);

  const workspace = addFavorites(original, ["page-a"], {
    sectionId: "doing",
  });

  assert.equal(group(original, "work").collapsed, true);
  assert.equal(section(original, "doing").collapsed, true);
  assert.equal(group(workspace, "work").collapsed, false);
  assert.equal(section(workspace, "doing").collapsed, false);
});

test("addFavorite reactivates an existing Favorite in place instead of duplicating it", () => {
  let dormant = withWorkStructure();
  dormant = addFavorite(dormant, "page-a", {
    sectionId: "doing",
    now: "2026-08-29T00:00:00.000Z",
  });
  dormant = reconcileManagedFavorites(dormant, [], {
    now: "2026-08-30T00:00:00.000Z",
    dormantRetentionMs: Infinity,
  });

  const reactivated = addFavorite(dormant, "page-a", {
    sectionId: "reference",
    now: "2026-08-31T00:00:00.000Z",
  });

  assert.equal(favoriteLocations(dormant, "page-a").at(0).favorite.dormant, true);
  assert.deepEqual(
    favoriteLocations(reactivated, "page-a").map(({ sectionId, favorite }) => ({
      sectionId,
      dormant: favorite.dormant,
      updatedAt: favorite.updatedAt,
    })),
    [
      {
        sectionId: "doing",
        dormant: false,
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
    ],
  );
});

test("removeFavorite explicitly removes one managed Favorite without mutating input", () => {
  let original = withWorkStructure();
  original = addFavorite(original, "page-a", { sectionId: "doing" });
  original = addFavorite(original, "page-b", { sectionId: "doing" });

  const removed = removeFavorite(original, "page-a");

  assert.equal(favoriteLocations(original, "page-a").length, 1);
  assert.equal(favoriteLocations(removed, "page-a").length, 0);
  assert.deepEqual(
    section(removed, "doing").favorites.map(({ pageId, order }) => [pageId, order]),
    [["page-b", 0]],
  );
  assert.equal(assertValidWorkspace(removed), true);
});

test("reconcileManagedFavorites updates only managed Favorites without auto-adding source IDs", () => {
  let original = withWorkStructure();
  original = addFavorite(original, "page-a", {
    sectionId: "doing",
    now: "2026-08-30T00:00:00.000Z",
  });
  original = addFavorite(original, "page-b", {
    sectionId: "reference",
    now: "2026-08-30T00:00:00.000Z",
  });

  const reconciled = reconcileManagedFavorites(
    original,
    ["page-a", "page-new", "page-a"],
    { now: "2026-08-31T00:00:00.000Z", dormantRetentionMs: Infinity },
  );

  assert.equal(favoriteLocations(original, "page-b").at(0).favorite.dormant, false);
  assert.equal(favoriteLocations(reconciled, "page-new").length, 0);
  assert.deepEqual(
    favoriteLocations(reconciled, "page-a").map(({ sectionId, favorite }) => ({
      sectionId,
      dormant: favorite.dormant,
      updatedAt: favorite.updatedAt,
    })),
    [
      {
        sectionId: "doing",
        dormant: false,
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
    ],
  );
  assert.deepEqual(
    favoriteLocations(reconciled, "page-b").map(({ sectionId, favorite }) => ({
      sectionId,
      dormant: favorite.dormant,
      updatedAt: favorite.updatedAt,
    })),
    [
      {
        sectionId: "reference",
        dormant: true,
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
    ],
  );
  assert.equal(assertValidWorkspace(reconciled), true);
});

test("managed Favorites restore in place and honor immediate dormant pruning", () => {
  let workspace = withWorkStructure();
  workspace = addFavorite(workspace, "page-a", {
    sectionId: "doing",
    now: "2026-08-29T00:00:00.000Z",
  });
  workspace = reconcileManagedFavorites(workspace, [], {
    now: "2026-08-30T00:00:00.000Z",
    dormantRetentionMs: Infinity,
  });
  assert.equal(favoriteLocations(workspace, "page-a").at(0).favorite.dormant, true);

  workspace = reconcileManagedFavorites(workspace, ["page-a", "unmanaged-page"], {
    now: "2026-08-31T00:00:00.000Z",
  });
  assert.equal(favoriteLocations(workspace, "page-a").at(0).sectionId, "doing");
  assert.equal(favoriteLocations(workspace, "page-a").at(0).favorite.dormant, false);
  assert.equal(favoriteLocations(workspace, "unmanaged-page").length, 0);

  workspace = reconcileManagedFavorites(workspace, [], {
    now: "2026-09-01T00:00:00.000Z",
    dormantRetentionMs: 0,
  });
  assert.equal(favoriteLocations(workspace, "page-a").length, 0);
});

test("managed Favorite APIs reject invalid sources and missing targets", () => {
  const workspace = createWorkspace();

  assert.throws(
    () => addFavorite(workspace, " "),
    (error) => error.code === "INVALID_PAGE_ID",
  );
  assert.throws(
    () => addFavorite(workspace, "page-a", { sectionId: "missing-section" }),
    (error) => error.code === "SECTION_NOT_FOUND",
  );
  assert.throws(
    () => removeFavorite(workspace, "page-a"),
    (error) => error.code === "FAVORITE_NOT_FOUND",
  );
  assert.throws(
    () => reconcileManagedFavorites(workspace, "page-a"),
    (error) => error.code === "INVALID_SOURCE",
  );
  assert.throws(
    () =>
      reconcileManagedFavorites(workspace, [], {
        dormantRetentionMs: -1,
      }),
    (error) => error.code === "INVALID_RETENTION",
  );
});

test("reconcile adds new Favorites once and moveFavorite enforces single ownership", () => {
  let workspace = withWorkStructure();
  workspace = reconcileFavorites(
    workspace,
    ["page-a", "page-b", "page-a", { pageId: "page-c" }],
    { now: "2026-08-31T01:00:00.000Z" },
  );

  assert.deepEqual(
    systemGroup(workspace).sections.at(-1).favorites.map(({ pageId }) => pageId),
    ["page-a", "page-b", "page-c"],
  );

  const beforeMove = workspace;
  workspace = moveFavorite(workspace, "page-a", "doing", 0);
  workspace = moveFavorite(workspace, "page-b", "doing", 0);
  workspace = moveFavorite(workspace, "page-a", "reference", 0);

  assert.equal(favoriteLocations(beforeMove, "page-a").at(0).sectionId, getSystemSectionId(SYSTEM_GROUP_ID));
  assert.equal(favoriteLocations(workspace, "page-a").length, 1);
  assert.equal(favoriteLocations(workspace, "page-a").at(0).sectionId, "reference");
  assert.deepEqual(
    section(workspace, "doing").favorites.map(({ pageId }) => pageId),
    ["page-b"],
  );
  assert.equal(assertValidWorkspace(workspace), true);
});

test("reconcile marks missing Favorites dormant and restores their prior location", () => {
  let workspace = withWorkStructure();
  workspace = reconcileFavorites(workspace, ["page-a", "page-b"], {
    now: "2026-08-31T01:00:00.000Z",
  });
  workspace = moveFavorite(workspace, "page-a", "doing", 0);
  workspace = reconcileFavorites(workspace, ["page-b"], {
    now: "2026-09-01T01:00:00.000Z",
  });

  let location = favoriteLocations(workspace, "page-a").at(0);
  assert.equal(location.sectionId, "doing");
  assert.equal(location.favorite.dormant, true);
  assert.equal(location.favorite.updatedAt, "2026-09-01T01:00:00.000Z");

  workspace = reconcileFavorites(workspace, ["page-a", "page-b"], {
    now: "2026-09-02T01:00:00.000Z",
  });
  location = favoriteLocations(workspace, "page-a").at(0);
  assert.equal(location.sectionId, "doing");
  assert.equal(location.favorite.dormant, false);
  assert.equal(location.favorite.updatedAt, "2026-09-02T01:00:00.000Z");
});

test("reconcile prunes dormant Favorites after the retention period", () => {
  let workspace = createWorkspace({
    favorites: ["old-page"],
    now: "2026-08-01T00:00:00.000Z",
  });
  workspace = reconcileFavorites(workspace, [], {
    now: "2026-08-02T00:00:00.000Z",
  });
  assert.equal(favoriteLocations(workspace, "old-page").length, 1);

  workspace = reconcileFavorites(workspace, [], {
    now: new Date(
      new Date("2026-08-02T00:00:00.000Z").valueOf() +
        DEFAULT_DORMANT_RETENTION_MS,
    ),
  });
  assert.equal(favoriteLocations(workspace, "old-page").length, 0);
});

test("deleting a section moves all Favorites to that group's unclassified section", () => {
  let workspace = withWorkStructure();
  workspace = reconcileFavorites(workspace, ["page-a", "page-b"], {
    now: "2026-08-31T00:00:00.000Z",
  });
  workspace = moveFavorite(workspace, "page-a", "doing", 0);
  workspace = moveFavorite(workspace, "page-b", "doing", 1);
  workspace = deleteSection(workspace, "doing");

  assert.equal(section(workspace, "doing"), undefined);
  assert.deepEqual(
    group(workspace, "work").sections.at(-1).favorites.map(({ pageId }) => pageId),
    ["page-a", "page-b"],
  );
  assert.equal(assertValidWorkspace(workspace), true);
});

test("deleting a group preserves user sections and merges its unclassified Favorites", () => {
  let workspace = withWorkStructure();
  workspace = reconcileFavorites(workspace, ["page-a", "page-b"], {
    now: "2026-08-31T00:00:00.000Z",
  });
  workspace = moveFavorite(workspace, "page-a", "doing", 0);
  workspace = moveFavorite(
    workspace,
    "page-b",
    getSystemSectionId("work"),
    0,
  );
  workspace = deleteGroup(workspace, "work");

  assert.equal(group(workspace, "work"), undefined);
  assert.equal(section(workspace, "doing").favorites.at(0).pageId, "page-a");
  assert.equal(section(workspace, "reference").favorites.length, 0);
  assert.equal(
    systemGroup(workspace).sections.at(-1).favorites.at(0).pageId,
    "page-b",
  );
  assert.deepEqual(
    systemGroup(workspace).sections.map(({ id }) => id),
    [
      "doing",
      "reference",
      getSystemSectionId(SYSTEM_GROUP_ID),
    ],
  );
  assert.equal(assertValidWorkspace(workspace), true);
});

test("normalize repairs ordering, IDs, system paths, and duplicate ownership", () => {
  const normalized = normalizeWorkspace({
    schemaVersion: 999,
    groups: [
      {
        id: "duplicate",
        name: "  업무  ",
        order: 5,
        sections: [
          {
            id: "same-section",
            name: "A",
            order: 9,
            favorites: [
              {
                pageId: "01234567-89AB-CDEF-0123-456789ABCDEF",
                dormant: true,
                updatedAt: "not-a-date",
              },
            ],
          },
        ],
      },
      {
        id: "duplicate",
        name: "개인",
        order: 1,
        sections: [
          {
            id: "same-section",
            name: "B",
            favorites: [
              {
                pageId: "0123456789abcdef0123456789abcdef",
                dormant: false,
                updatedAt: "2026-08-31T00:00:00.000Z",
              },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(normalized.schemaVersion, 1);
  assert.deepEqual(
    normalized.groups.map(({ id, order }) => [id, order]),
    [
      ["duplicate", 0],
      ["duplicate-2", 1],
      [SYSTEM_GROUP_ID, 2],
    ],
  );
  assert.equal(new Set(normalized.groups.flatMap((item) => item.sections.map(({ id }) => id))).size, 5);
  assert.equal(
    favoriteLocations(normalized, "0123456789abcdef0123456789abcdef").length,
    1,
  );
  assert.equal(
    favoriteLocations(normalized, "0123456789abcdef0123456789abcdef").at(0).favorite.dormant,
    false,
  );
  assert.equal(assertValidWorkspace(normalized), true);
});

test("assertValidWorkspace rejects broken orders and duplicate Favorites", () => {
  const workspace = createWorkspace({ favorites: ["page-a"] });
  const badOrder = structuredClone(workspace);
  badOrder.groups[0].order = 4;
  assert.throws(
    () => assertValidWorkspace(badOrder),
    (error) => error.code === "INVALID_WORKSPACE" && /order/.test(error.message),
  );

  const duplicate = structuredClone(workspace);
  duplicate.groups[0].sections[0].favorites.push({
    ...duplicate.groups[0].sections[0].favorites[0],
    order: 1,
  });
  assert.throws(
    () => assertValidWorkspace(duplicate),
    (error) => error.code === "INVALID_WORKSPACE" && /중복 Favorite/.test(error.message),
  );
});

test("protected entities and invalid user strings are rejected", () => {
  let workspace = createWorkspace();
  workspace = createGroup(workspace, { id: "work", name: "업무" });

  assert.throws(
    () => renameGroup(workspace, SYSTEM_GROUP_ID, "기타"),
    (error) => error.code === "SYSTEM_PROTECTED",
  );
  assert.throws(
    () => deleteGroup(workspace, SYSTEM_GROUP_ID),
    (error) => error.code === "SYSTEM_PROTECTED",
  );
  assert.throws(
    () => deleteSection(workspace, getSystemSectionId("work")),
    (error) => error.code === "SYSTEM_PROTECTED",
  );
  assert.throws(
    () => createGroup(workspace, { name: " ", id: "empty" }),
    (error) => error.code === "INVALID_NAME",
  );
  assert.throws(
    () => createSection(workspace, "work", {
      id: "too-long",
      name: "가".repeat(MAX_NAME_LENGTH + 1),
    }),
    (error) => error.code === "INVALID_NAME",
  );
  assert.throws(
    () => createGroup(workspace, { id: "unsafe", name: "업무\n개인" }),
    (error) => error.code === "INVALID_NAME",
  );
  assert.throws(
    () => createGroup(workspace, { id: "g".repeat(132), name: "긴 ID" }),
    (error) => error.code === "INVALID_ID",
  );
});

test("getCounts reports active and dormant totals at workspace, group, and section levels", () => {
  let workspace = withWorkStructure();
  workspace = reconcileFavorites(workspace, ["page-a", "page-b"], {
    now: "2026-08-31T00:00:00.000Z",
  });
  workspace = moveFavorite(workspace, "page-a", "doing", 0);
  workspace = reconcileFavorites(workspace, ["page-a"], {
    now: "2026-09-01T00:00:00.000Z",
  });

  const all = getCounts(workspace);
  assert.deepEqual(
    {
      groups: all.groups,
      sections: all.sections,
      total: all.total,
      active: all.active,
      dormant: all.dormant,
    },
    { groups: 2, sections: 4, total: 2, active: 1, dormant: 1 },
  );
  assert.deepEqual(getCounts(workspace, "doing"), {
    total: 1,
    active: 1,
    dormant: 0,
  });
  assert.deepEqual(
    {
      total: getCounts(workspace, SYSTEM_GROUP_ID).total,
      active: getCounts(workspace, SYSTEM_GROUP_ID).active,
      dormant: getCounts(workspace, SYSTEM_GROUP_ID).dormant,
    },
    { total: 1, active: 0, dormant: 1 },
  );
});
