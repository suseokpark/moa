import assert from "node:assert/strict";
import test from "node:test";
import { createCatalog, validateCatalog, normalizeLinkUrl, identifyUrl, applyCatalogAction, migrateLegacyStorage, SYSTEM_GROUP_ID, flattenGroups, countGroupLinks } from "../src/link-library.js";

const LIB = "library-personal";
const PAGE_A = "0123456789abcdef0123456789abcdef";
const PAGE_B = "fedcba9876543210fedcba9876543210";
const target = { libraryId: LIB, groupId: SYSTEM_GROUP_ID };
const act = (catalog, action) => applyCatalogAction(catalog, { libraryId: LIB, ...action });
const allLinks = catalog => catalog.libraries.flatMap(library => flattenGroups(library).flatMap(({ group }) => group.links));
function add(catalog, title = "Example", url = "https://example.com", override = {}) {
  return act(catalog, { type: "addLink", ...target, link: { title, url }, ...override });
}
function legacyWorkspace(pageIds = [PAGE_A]) {
  return { schemaVersion: 1, groups: [{
    id: "project", name: "프로젝트", color: "", emoji: "", collapsed: true, order: 1, system: false,
    sections: [{ id: "docs", name: "문서", color: "", emoji: "", collapsed: true, order: 2, system: false,
      favorites: pageIds.map((pageId, order) => ({ pageId, order, dormant: false, updatedAt: "2026-09-21T00:00:00.000Z" }))
    }]
  }] };
}

test("a new catalog is independently cloned and has usable protected destinations", () => {
  const first = createCatalog(), second = createCatalog();
  assert.deepEqual(first, second);
  assert.equal(first.libraries[0].groups[0].id, SYSTEM_GROUP_ID);
  assert.equal(first.schemaVersion, 2);
  assert.deepEqual(first.libraries[0].groups[0].groups, []);
  assert.deepEqual(first.libraries[0].groups[0].links, []);
  const copy = validateCatalog(first);
  copy.libraries[0].name = "Changed";
  assert.equal(first.libraries[0].name, "내 링크");
  assert.notStrictEqual(first.libraries[0].groups, second.libraries[0].groups);
});

test("URLs normalize host/default ports while preserving meaningful queries and hashes", () => {
  assert.equal(normalizeLinkUrl(" HTTPS://Example.COM:443/path?q=x#anchor "), "https://example.com/path?q=x#anchor");
  assert.equal(identifyUrl("https://example.com/?tab=one").provider, "generic");
  assert.notEqual(identifyUrl("https://example.com/?tab=one").key, identifyUrl("https://example.com/?tab=two").key);
  assert.notEqual(identifyUrl("https://example.com/#one").key, identifyUrl("https://example.com/#two").key);
});

test("URLs reject executable, local, credential, control character, malformed and authentication addresses", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,bad", "file:///tmp/foo", "chrome://settings", "mailto:test@example.com", "not-a-url", "//example.com", "https://user:password@example.com", "https://user@example.com", "https://example.com/\nsecret", "https://example.com/\\test", "https://example.com/oauth/callback", "https://example.com/%6fauth2/authorize", "https://example.com/%zz"]) {
    assert.throws(() => normalizeLinkUrl(url), Error, url);
  }
  assert.throws(() => normalizeLinkUrl("https://example.com/" + "x".repeat(4096)));
});

test("URLs refuse secret-bearing query and fragment parameters without changing normal Drive parameters", () => {
  for (const parameter of ["access_token", "refresh-token", "id_token", "token", "oauth_token", "authToken", "password", "secret", "client_secret", "code", "code_verifier", "jwt", "bearer", "authorization", "sessionid", "api_key", "key", "X-Amz-Credential", "X-Goog-Signature", "signature"]) {
    assert.throws(() => normalizeLinkUrl(`https://example.com/?${parameter}=value`), Error, parameter);
    assert.throws(() => normalizeLinkUrl(`https://example.com/#${parameter}=value`), Error, parameter);
    assert.throws(() => normalizeLinkUrl(`https://example.com/#/path?${parameter}=value`), Error, parameter);
  }
  assert.throws(() => normalizeLinkUrl("https://example.com/#access_token%3Dsecret"));
  assert.equal(normalizeLinkUrl("https://drive.google.com/drive/u/0/folders/folder?usp=sharing&authuser=0"), "https://drive.google.com/drive/u/0/folders/folder?usp=sharing&authuser=0");
});

test("Notion slug and UUID variants have one logical identity, excluding lookalike domains", () => {
  const a = identifyUrl(`https://www.notion.so/Title-${PAGE_A}?view=1`);
  const b = identifyUrl("https://app.notion.com/01234567-89ab-cdef-0123-456789abcdef");
  const c = identifyUrl(`https://company.notion.site/${PAGE_A.toUpperCase()}`);
  assert.equal(a.provider, "notion");
  assert.equal(a.resourceId, PAGE_A);
  assert.equal(a.key, b.key);
  assert.equal(a.key, c.key);
  assert.equal(identifyUrl(`https://notion.so.attacker.test/${PAGE_A}`).provider, "generic");
});

test("Notion identity decoding preserves literal percent paths and does not reinterpret encoded separators", () => {
  for (const prefix of ["Progress%25-", "Literal%25E0%25A4-"]) {
    const url = `https://app.notion.com/p/alpha/${prefix}${PAGE_A}`;
    const catalog = add(createCatalog(), "Saved page", url);
    assert.equal(allLinks(validateCatalog(catalog))[0].url, url);
    assert.equal(identifyUrl(url).resourceId, PAGE_A);
  }
  for (const separator of ["%2F", "%5C", "%00"]) {
    const encodedId = `${PAGE_A.slice(0, 16)}%30${PAGE_A.slice(17)}`;
    const url = `https://app.notion.com/p/alpha/Other${separator}${encodedId}`;
    assert.equal(identifyUrl(url).provider, "generic", url);
    const catalog = add(createCatalog(), "Saved route", url);
    assert.equal(allLinks(validateCatalog(catalog))[0].provider, "generic");
  }
  // Malformed path encodings were already rejected by normalizeLinkUrl.
  // Identity detection must not relax that existing storage validation.
  for (const prefix of ["Progress%-", "Malformed%ZZ-", "Malformed%E0%A4-"]) {
    assert.throws(() => identifyUrl(`https://app.notion.com/${prefix}${PAGE_A}`));
  }
});

test("Drive files, docs and folders identify resources without treating other hosts as Drive", () => {
  assert.deepEqual(identifyUrl("https://drive.google.com/drive/u/0/folders/folder_ABC-1"), {
    url: "https://drive.google.com/drive/u/0/folders/folder_ABC-1", key: "google-drive:folder_ABC-1", provider: "google-drive", resourceId: "folder_ABC-1"
  });
  assert.equal(identifyUrl("https://drive.google.com/file/d/abc/view").key, identifyUrl("https://docs.google.com/document/d/abc/edit").key);
  assert.equal(identifyUrl("https://drive.google.com/open?id=abc").key, "google-drive:abc");
  assert.equal(identifyUrl("https://evil.test/folders/abc").provider, "generic");
});

test("adding, renaming and folding library and nested groups does not mutate previous revisions", () => {
  const original = createCatalog();
  let c = act(original, { type: "renameLibrary", name: " 내 작업 " });
  c = act(c, { type: "addLibrary", name: "개인" });
  c = act(c, { type: "addGroup", name: "프로젝트 A" });
  const groupId = c.libraries[0].groups.at(-1).id;
  c = act(c, { type: "renameGroup", groupId, name: "프로젝트 B" });
  c = act(c, { type: "toggleGroup", groupId });
  c = act(c, { type: "addGroup", parentGroupId: groupId, name: "문서" });
  const childId = c.libraries[0].groups.at(-1).groups.at(-1).id;
  c = act(c, { type: "renameGroup", groupId: childId, name: "기획 문서" });
  c = act(c, { type: "toggleGroup", groupId: childId });
  assert.equal(c.libraries[0].name, "내 작업");
  assert.equal(c.libraries[0].groups.at(-1).collapsed, true);
  assert.equal(c.libraries[0].groups.at(-1).groups.at(-1).collapsed, true);
  assert.equal(c.libraries[0].groups.at(-1).groups.at(-1).name, "기획 문서");
  assert.deepEqual(original, createCatalog());
});

test("add and update links derive provider, preserve ID, and reject duplicate logical destinations", () => {
  let c = add(createCatalog(), "Document", `https://notion.so/${PAGE_A}`);
  const linkId = allLinks(c)[0].id;
  assert.equal(allLinks(c)[0].provider, "notion");
  assert.throws(() => add(c, "Same", `https://www.notion.so/New-title-${PAGE_A}`), /이미/u);
  c = act(c, { type: "updateLink", linkId, title: "Drive doc", url: "https://docs.google.com/document/d/abc/edit" });
  assert.equal(allLinks(c)[0].id, linkId);
  assert.equal(allLinks(c)[0].provider, "google-drive");
  assert.equal(allLinks(c)[0].resourceId, "abc");
  c = act(c, { type: "updateLink", linkId, link: { title: "Web", url: "https://example.com", icon: "📄" } });
  assert.equal(allLinks(c)[0].provider, "generic");
  assert.equal(allLinks(c)[0].resourceId, undefined);
  assert.equal(allLinks(c)[0].icon, "📄");
});

test("same link is allowed in another library, but duplicate updates are atomic", () => {
  let c = add(createCatalog(), "A", "https://example.com/a");
  c = add(c, "B", "https://example.com/b");
  const snapshot = structuredClone(c);
  assert.throws(() => act(c, { type: "updateLink", linkId: allLinks(c)[1].id, url: "https://example.com/a" }), /이미/u);
  assert.deepEqual(c, snapshot);
  c = act(c, { type: "addLibrary", name: "다른 목록" });
  c = add(c, "A", "https://example.com/a", { libraryId: c.libraries[1].id });
  assert.equal(allLinks(c).length, 3);
});

test("moving, reordering and explicit link deletion preserve unrelated links", () => {
  let c = add(createCatalog(), "A", "https://example.com/a");
  c = add(c, "B", "https://example.com/b");
  const [a, b] = allLinks(c);
  c = act(c, { type: "reorderLink", linkId: b.id, direction: "up" });
  assert.deepEqual(allLinks(c).map(link => link.id), [b.id, a.id]);
  c = act(c, { type: "reorderLink", linkId: b.id, direction: "up" });
  assert.deepEqual(allLinks(c).map(link => link.id), [b.id, a.id]);
  c = act(c, { type: "addGroup", name: "Destination" });
  const group = c.libraries[0].groups.at(-1);
  c = act(c, { type: "moveLink", linkId: a.id, targetGroupId: group.id });
  assert.equal(c.libraries[0].groups[1].links[0].id, a.id);
  c = act(c, { type: "removeLink", linkId: b.id });
  assert.deepEqual(allLinks(c).map(link => link.id), [a.id]);
});

test("removing a child group rehomes its links without destroying them", () => {
  let c = act(createCatalog(), { type: "addGroup", parentGroupId: SYSTEM_GROUP_ID, name: "Documents" });
  const groupId = c.libraries[0].groups[0].groups[0].id;
  c = add(c, "A", "https://example.com/a", { groupId });
  const link = allLinks(c)[0];
  c = act(c, { type: "removeGroup", groupId });
  assert.equal(c.libraries[0].groups[0].groups.length, 0);
  assert.deepEqual(c.libraries[0].groups[0].links, [link]);
});

test("removing a root group retains child names and folds and merges its direct links", () => {
  let c = act(createCatalog(), { type: "addGroup", name: "Project" });
  const groupId = c.libraries[0].groups[1].id;
  c = add(c, "A", "https://example.com/a", { groupId });
  c = act(c, { type: "addGroup", parentGroupId: groupId, name: "Documents" });
  const childId = c.libraries[0].groups[1].groups[0].id;
  c = act(c, { type: "toggleGroup", groupId: childId });
  c = add(c, "B", "https://example.com/b", { groupId: childId });
  c = act(c, { type: "removeGroup", groupId });
  assert.equal(c.libraries[0].groups.length, 1);
  assert.equal(allLinks(c).length, 2);
  assert.equal(c.libraries[0].groups[0].groups[0].id, childId);
  assert.equal(c.libraries[0].groups[0].groups[0].name, "Documents");
  assert.equal(c.libraries[0].groups[0].groups[0].collapsed, true);
});

test("protected root group cannot be renamed, removed or moved, but can be folded", () => {
  for (const type of ["renameGroup", "removeGroup", "moveGroup"]) {
    assert.throws(() => act(createCatalog(), { ...target, type, name: "Oops" }), /미분류/u);
  }
  assert.equal(act(createCatalog(), { ...target, type: "toggleGroup" }).libraries[0].groups[0].collapsed, true);
});

test("reset changes only selected library and keeps migration markers", () => {
  let c = add(createCatalog());
  c = act(c, { type: "addLibrary", name: "Other" });
  const otherId = c.libraries[1].id;
  c = add(c, "Other", "https://example.com/other", { libraryId: otherId });
  c.migratedLegacyKeys.push("nfs:workspace:alpha");
  c = act(c, { type: "resetLibrary" });
  assert.equal(c.libraries[0].groups[0].links.length, 0);
  assert.equal(allLinks(c).length, 1);
  assert.deepEqual(c.migratedLegacyKeys, ["nfs:workspace:alpha"]);
});

test("failed destinations, malformed names and unsupported operations are atomic", () => {
  const c = add(createCatalog());
  const snapshot = structuredClone(c);
  for (const action of [
    { type: "addGroup", name: " " }, { type: "addGroup", name: "a".repeat(81) }, { type: "addGroup", name: "name\nline" },
    { type: "renameLibrary", libraryId: "missing", name: "X" }, { type: "removeGroup", groupId: "missing" },
    { type: "removeLink", linkId: "missing" }, { type: "moveLink", linkId: allLinks(c)[0].id, targetGroupId: "missing", targetSectionId: "missing" },
    { type: "reorderLink", linkId: allLinks(c)[0].id, direction: "left" }, { type: "unknown" }
  ]) assert.throws(() => act(c, action));
  assert.deepEqual(c, snapshot);
});

test("validation refuses unexpected fields, mismatched resources, duplicate IDs, bad enums and oversized inputs", () => {
  const valid = add(createCatalog());
  const mutations = [
    c => { c.schemaVersion = 3; }, c => { c.accessToken = "secret"; }, c => { c.libraries[0].password = "secret"; },
    c => { c.libraries = []; }, c => { c.libraries.push(structuredClone(c.libraries[0])); },
    c => { c.libraries[0].groups[0].collapsed = "false"; },
    c => { c.libraries[0].groups.push(structuredClone(c.libraries[0].groups[0])); },
    c => { allLinks(c)[0].provider = "notion"; }, c => { allLinks(c)[0].resourceId = PAGE_A; },
    c => { allLinks(c)[0].url = "javascript:alert(1)"; }, c => { allLinks(c)[0].icon = "x".repeat(65); },
    c => { allLinks(c)[0].title = "x\u0085name"; }, c => { c.migratedLegacyKeys = ["unknown:key"]; },
    c => { c.libraries[0].origin = { type: "notion", workspaceKey: "alpha", cookie: "secret" }; }
  ];
  for (const mutate of mutations) { const c = structuredClone(valid); mutate(c); assert.throws(() => validateCatalog(c)); }
  assert.throws(() => validateCatalog(Object.assign(Object.create({}), valid)));
});

test("migration preserves identity scope, names, collapsed state and canonical clickable addresses", () => {
  const storage = {
    "nfs:workspace:alpha": { revision: 4, workspace: legacyWorkspace([PAGE_A, PAGE_B]) },
    "nfs:metadata:alpha": [{ pageId: PAGE_A, title: "기획 문서", icon: "📋" }],
    "nfs:workspace:beta": legacyWorkspace([PAGE_A])
  };
  const original = structuredClone(storage);
  const result = migrateLegacyStorage(createCatalog(), storage);
  assert.equal(result.importedLibraries, 2);
  assert.equal(result.importedLinks, 3);
  assert.deepEqual(result.warnings, []);
  const [alpha, beta] = result.catalog.libraries.slice(1);
  assert.notEqual(alpha.id, beta.id);
  assert.deepEqual(alpha.origin, { type: "notion", workspaceKey: "alpha" });
  assert.equal(alpha.groups[0].id, "project");
  assert.equal(alpha.groups[0].name, "프로젝트");
  assert.equal(alpha.groups[0].collapsed, true);
  assert.equal(alpha.groups[0].groups[0].collapsed, true);
  const [a, b] = alpha.groups[0].groups[0].links;
  assert.equal(a.title, "기획 문서");
  assert.equal(a.icon, "📋");
  assert.equal(a.url, `https://www.notion.so/${PAGE_A}`);
  assert.equal(b.url, `https://www.notion.so/${PAGE_B}`);
  assert.match(b.title, /제목을 불러오지 못한/u);
  assert.deepEqual(storage, original);
});

test("migration is idempotent and does not resurrect reset/deleted migrated links", () => {
  const storage = { "nfs:workspace:alpha": legacyWorkspace() };
  const once = migrateLegacyStorage(createCatalog(), storage);
  const twice = migrateLegacyStorage(once.catalog, storage);
  assert.equal(twice.importedLinks, 0);
  assert.equal(twice.importedLibraries, 0);
  assert.deepEqual(twice.catalog, once.catalog);
  const reset = applyCatalogAction(once.catalog, { type: "resetLibrary", libraryId: once.catalog.libraries[1].id });
  assert.equal(allLinks(migrateLegacyStorage(reset, storage).catalog).length, 0);
});

test("migration preserves verified legacy page routes without mutating or duplicating the source", () => {
  const urls = [
    `https://app.notion.com/p/example-workspace/Plan-${PAGE_A}?pvs=4#notes`,
    `https://app.notion.com/p/another-workspace/Plan_${PAGE_A}?view=timeline#section`,
    `https://app.notion.com/p/another-workspace/Plan-${PAGE_A.slice(0, 16)}%30${PAGE_A.slice(17)}?pvs=4#notes`
  ];
  for (const href of urls) {
    const storage = {
      "nfs:workspace:alpha": legacyWorkspace([PAGE_A, PAGE_B]),
      "nfs:metadata:alpha": [
        { pageId: PAGE_A, title: "기획 문서", icon: "📋", href },
        { pageId: PAGE_B, title: "주소 없는 이전 문서", icon: "" }
      ]
    };
    const originalStorage = structuredClone(storage);
    const catalog = add(createCatalog(), "Local", "https://example.com/local");
    const originalCatalog = structuredClone(catalog);
    const once = migrateLegacyStorage(catalog, storage);
    assert.equal(once.importedLibraries, 1, href);
    assert.equal(once.importedLinks, 2, href);
    assert.deepEqual(once.warnings, [], href);
    const imported = allLinks(once.catalog).slice(1);
    assert.equal(imported[0].url, href);
    assert.equal(imported[0].title, "기획 문서");
    assert.equal(imported[0].resourceId, PAGE_A);
    assert.equal(imported[1].url, `https://www.notion.so/${PAGE_B}`);
    assert.deepEqual(storage, originalStorage);
    assert.deepEqual(catalog, originalCatalog);
    const twice = migrateLegacyStorage(once.catalog, storage);
    assert.equal(twice.importedLibraries, 0);
    assert.equal(twice.importedLinks, 0);
    assert.deepEqual(twice.catalog, once.catalog);
  }
});

test("migration never imports an unsafe cached route or loses its workspace links", () => {
  for (const href of [
    `https://app.notion.com/p/alpha/${PAGE_B}`,
    `https://evil.test/p/alpha/${PAGE_A}`,
    `https://app.notion.com/p/alpha/${PAGE_A}?access_token=secret`,
    `https://app.notion.com/p/alpha/${PAGE_A}#code=secret`
  ]) {
    const storage = {
      "nfs:workspace:alpha": legacyWorkspace([PAGE_A, PAGE_B]),
      "nfs:metadata:alpha": [{ pageId: PAGE_A, title: "기획 문서", icon: "", href }]
    };
    const snapshot = structuredClone(storage);
    const result = migrateLegacyStorage(createCatalog(), storage);
    assert.equal(result.importedLibraries, 1, href);
    assert.equal(result.importedLinks, 2, href);
    assert.equal(allLinks(result.catalog)[0].url, `https://www.notion.so/${PAGE_A}`);
    assert.equal(allLinks(result.catalog)[1].url, `https://www.notion.so/${PAGE_B}`);
    assert.ok(result.warnings.length >= 1, href);
    assert.equal(JSON.stringify(result.catalog).includes("secret"), false);
    assert.deepEqual(storage, snapshot);
  }
});

test("migration orders groups, sections and links by legacy order with stable ties", () => {
  const workspace = legacyWorkspace([PAGE_A, PAGE_B]);
  workspace.groups[0].sections[0].favorites[0].order = 8;
  const second = structuredClone(workspace.groups[0]);
  second.id = "first-group"; second.name = "First"; second.order = 0;
  second.sections = [{ ...second.sections[0], id: "first-section", favorites: [] }];
  workspace.groups.push(second);
  const result = migrateLegacyStorage(createCatalog(), { "nfs:workspace:alpha": workspace });
  const library = result.catalog.libraries[1];
  assert.equal(library.groups[0].id, "first-group");
  assert.deepEqual(library.groups[1].groups[0].links.map(link => link.resourceId), [PAGE_B, PAGE_A]);
});

test("corrupt workspaces are skipped, corrupt metadata is ignored, and other valid workspaces still migrate", () => {
  const result = migrateLegacyStorage(createCatalog(), {
    "nfs:workspace:bad": { revision: "wrong", workspace: legacyWorkspace() },
    "nfs:workspace:good": legacyWorkspace(),
    "nfs:metadata:good": [{ pageId: PAGE_A, title: "Wrong", icon: "", token: "secret" }],
    "unrelated": { password: "ignored" }
  });
  assert.equal(result.importedLibraries, 1);
  assert.equal(result.importedLinks, 1);
  assert.equal(result.warnings.length, 2);
  assert.deepEqual(result.catalog.migratedLegacyKeys, ["nfs:workspace:good"]);
  assert.match(allLinks(result.catalog)[0].title, /제목을 불러오지 못한/u);
  assert.equal(JSON.stringify(result.catalog).includes("secret"), false);
});

test("migration skips invalid page IDs and deduplicates uppercase or hyphenated page IDs safely", () => {
  const duplicate = "01234567-89ab-cdef-0123-456789abcdef";
  const result = migrateLegacyStorage(createCatalog(), { "nfs:workspace:alpha": legacyWorkspace([PAGE_A, duplicate, "invalid-id"]) });
  assert.equal(result.importedLibraries, 1);
  assert.equal(result.importedLinks, 1);
  assert.equal(result.warnings.length, 2);
  assert.equal(allLinks(result.catalog)[0].resourceId, PAGE_A);
});

test("migration keeps an existing generic library unchanged and retries previously corrupt workspaces", () => {
  const catalog = add(createCatalog(), "Local", "https://example.com/local");
  const first = migrateLegacyStorage(catalog, { "nfs:workspace:alpha": "broken" });
  assert.deepEqual(first.catalog, catalog);
  const second = migrateLegacyStorage(first.catalog, { "nfs:workspace:alpha": legacyWorkspace() });
  assert.equal(second.importedLibraries, 1);
  assert.deepEqual(second.catalog.libraries[0], catalog.libraries[0]);
});

test("bulk add preserves selection order and normalizes each service", () => {
  const initial = createCatalog();
  const result = act(initial, { type: "addLinks", ...target, links: [
    { title: "A", url: "https://example.com/a" },
    { title: "B", url: `https://www.notion.so/${PAGE_A}`, icon: "📃" },
    { title: "C", url: "https://drive.google.com/drive/folders/abc" }
  ] });
  assert.deepEqual(allLinks(result).map(link => link.title), ["A", "B", "C"]);
  assert.deepEqual(allLinks(result).map(link => link.provider), ["generic", "notion", "google-drive"]);
  assert.equal(new Set(allLinks(result).map(link => link.id)).size, 3);
  assert.equal(allLinks(initial).length, 0);
});

test("bulk add with a duplicate existing destination is all-or-nothing", () => {
  const c = add(createCatalog(), "Existing", `https://www.notion.so/${PAGE_A}`);
  const snapshot = structuredClone(c);
  assert.throws(() => act(c, { type: "addLinks", ...target, links: [
    { title: "New", url: "https://example.com/new" },
    { title: "Duplicate", url: `https://app.notion.com/Other-title-${PAGE_A}` }
  ] }), /중복/u);
  assert.deepEqual(c, snapshot);
});

test("bulk add detects batch duplicates and later invalid addresses before changing input", () => {
  const c = createCatalog();
  for (const links of [
    [{ title: "A", url: "https://EXAMPLE.com:443" }, { title: "B", url: "https://example.com/" }],
    [{ title: "A", url: "https://example.com/a" }, { title: "B", url: "javascript:alert(1)" }],
    [{ title: "A", url: "https://example.com/a" }, { title: "", url: "https://example.com/b" }]
  ]) assert.throws(() => act(c, { type: "addLinks", ...target, links }));
  assert.deepEqual(c, createCatalog());
});

test("bulk add rejects empty, missing, oversized or wrongly targeted batches", () => {
  for (const extra of [
    { links: [] }, {}, { links: Array(1001).fill({ title: "A", url: "https://example.com" }) },
    { links: [{ title: "A", url: "https://example.com" }], sectionId: "missing" }
  ]) assert.throws(() => act(createCatalog(), { type: "addLinks", ...target, ...extra }));
});

test("group reordering keeps custom group content intact and default position fixed", () => {
  let c = act(createCatalog(), { type: "addGroup", name: "A" });
  c = act(c, { type: "addGroup", name: "B" });
  const [system, a, b] = c.libraries[0].groups;
  c = act(c, { type: "reorderGroup", groupId: b.id, direction: "up" });
  assert.deepEqual(c.libraries[0].groups, [system, b, a]);
  assert.deepEqual(act(c, { type: "reorderGroup", groupId: b.id, direction: "up" }), c);
  c = act(c, { type: "reorderGroup", groupId: b.id, direction: "down" });
  assert.deepEqual(c.libraries[0].groups, [system, a, b]);
  assert.deepEqual(act(c, { type: "reorderGroup", groupId: b.id, direction: "down" }), c);
  assert.throws(() => act(c, { type: "reorderGroup", groupId: system.id, direction: "down" }), /미분류/u);
  assert.throws(() => act(c, { type: "reorderGroup", groupId: a.id, direction: "left" }));
  assert.throws(() => act(c, { type: "reorderGroup", groupId: "missing", direction: "up" }));
});

test("nested group reordering preserves complete subtrees within the same parent", () => {
  let c = act(createCatalog(), { type: "addGroup", parentGroupId: SYSTEM_GROUP_ID, name: "A" });
  c = act(c, { type: "addGroup", parentGroupId: SYSTEM_GROUP_ID, name: "B" });
  const [a, b] = c.libraries[0].groups[0].groups;
  c = act(c, { type: "reorderGroup", groupId: b.id, direction: "up" });
  assert.deepEqual(c.libraries[0].groups[0].groups, [b, a]);
  assert.deepEqual(act(c, { type: "reorderGroup", groupId: b.id, direction: "up" }), c);
  c = act(c, { type: "reorderGroup", groupId: b.id, direction: "down" });
  assert.deepEqual(c.libraries[0].groups[0].groups, [a, b]);
});

test("moving a group preserves identity, links and fold state and supports moving to root", () => {
  let c = act(createCatalog(), { type: "addGroup", parentGroupId: SYSTEM_GROUP_ID, name: "Documents" });
  const groupId = c.libraries[0].groups[0].groups[0].id;
  c = add(c, "A", "https://example.com/a", { groupId });
  c = act(c, { type: "toggleGroup", groupId });
  c = act(c, { type: "addGroup", name: "Destination" });
  const targetGroupId = c.libraries[0].groups[1].id;
  const before = structuredClone(c.libraries[0].groups[0].groups[0]);
  c = act(c, { type: "moveGroup", groupId, targetParentGroupId: targetGroupId });
  assert.equal(c.libraries[0].groups[0].groups.length, 0);
  assert.deepEqual(c.libraries[0].groups[1].groups[0], before);
  assert.deepEqual(act(c, { type: "moveGroup", groupId, targetParentGroupId: targetGroupId }), c);
  c = act(c, { type: "moveGroup", groupId, targetParentGroupId: null });
  assert.deepEqual(c.libraries[0].groups.at(-1), before);
});

test("obsolete section operations are rejected clearly without changing data", () => {
  const c = add(createCatalog());
  const snapshot = structuredClone(c);
  for (const type of ["addSection", "renameSection", "toggleSection", "moveSection", "reorderSection", "removeSection"]) {
    assert.throws(() => act(c, { ...target, type, name: "Old", sectionId: "old", targetGroupId: SYSTEM_GROUP_ID }), /하위 그룹으로 변경/u);
  }
  assert.throws(() => add(c, "New", "https://example.com/new", { sectionId: "old" }), /섹션 대신/u);
  assert.throws(() => act(c, { type: "moveLink", linkId: allLinks(c)[0].id, targetGroupId: SYSTEM_GROUP_ID, targetSectionId: "old" }), /섹션 대신/u);
  assert.deepEqual(c, snapshot);
});

test("catalog enforces aggregate node limit even with many empty nested groups", () => {
  const c = createCatalog();
  c.libraries = Array.from({ length: 3 }, (_, libraryIndex) => ({
    id: `library-${libraryIndex}`, name: "Large", groups: Array.from({ length: 100 }, (_, groupIndex) => ({
      id: `group-${groupIndex}`, name: "Group", collapsed: false,
      links: [], groups: Array.from({ length: 100 }, (_, childIndex) => ({ id: `child-${groupIndex}-${childIndex}`, name: "Child", collapsed: false, groups: [], links: [] }))
    }))
  }));
  assert.throws(() => validateCatalog(c), /20,000/u);
});

test("catalog enforces overall link limit and rejects huge scalar inputs early", () => {
  const c = createCatalog();
  c.libraries[0].groups[0].links = Array.from({ length: 5001 }, (_, index) => ({ id: `link-${index}`, title: "Link", url: `https://example.com/${index}`, icon: "", provider: "generic" }));
  c.libraries.push({ ...structuredClone(c.libraries[0]), id: "other-library" });
  assert.throws(() => validateCatalog(c), /10,000/u);
  assert.throws(() => act(createCatalog(), { type: "addGroup", name: " ".repeat(100_000) + "A" }));
  assert.throws(() => identifyUrl("https://example.com/" + "x".repeat(100_000)));
});

test("sparse arrays cannot produce a saved catalog that becomes invalid on JSON reload", () => {
  for (const mutate of [
    c => { c.libraries = new Array(1); },
    c => { c.libraries[0].groups = new Array(1); },
    c => { c.libraries[0].groups[0].groups = new Array(1); },
    c => { c.libraries[0].groups[0].links = new Array(1); },
    c => { c.migratedLegacyKeys = new Array(1); }
  ]) {
    const c = createCatalog(); mutate(c);
    assert.throws(() => validateCatalog(c), /비어 있는/u);
  }
  assert.throws(() => act(createCatalog(), { type: "addLinks", ...target, links: new Array(1) }), /비어 있는/u);
  const populated = add(createCatalog());
  assert.deepEqual(validateCatalog(JSON.parse(JSON.stringify(populated))), populated);
});

test("an empty library gets a usable default destination without mutating the backup", () => {
  const input = createCatalog();
  input.libraries[0].groups = [];
  const snapshot = structuredClone(input);
  const normalized = validateCatalog(input);
  assert.deepEqual(normalized, createCatalog());
  assert.deepEqual(input, snapshot);
  assert.deepEqual(validateCatalog(normalized), normalized);
  assert.equal(allLinks(add(normalized, "Recovered destination", "https://example.com/recovered")).length, 1);
});

test("empty nested groups preserve identity and fold state without generated containers", () => {
  const input = createCatalog();
  input.libraries[0].groups = [
    { id: "empty-group", name: "기존 빈 그룹", collapsed: true, groups: [], links: [] },
    { id: "another-empty-group", name: "다른 빈 그룹", collapsed: false, groups: [], links: [] }
  ];
  const snapshot = structuredClone(input);
  const result = validateCatalog(input);
  assert.deepEqual(result.libraries[0].groups.map(({ id, name, collapsed }) => ({ id, name, collapsed })), snapshot.libraries[0].groups.map(({ id, name, collapsed }) => ({ id, name, collapsed })));
  assert.deepEqual(result.libraries[0].groups.map(group => group.groups.length), [0, 0]);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(validateCatalog(result), result);
  const withLink = add(result, "A", "https://example.com/a", { groupId: "empty-group" });
  assert.equal(allLinks(withLink).length, 1);
});

test("normal nonempty destination trees are never reordered or supplemented by validation", () => {
  const input = add(createCatalog(), "Existing", "https://example.com/existing");
  const existingGroup = input.libraries[0].groups[0];
  input.libraries[0].groups = [
    { id: "custom-group", name: "사용자 그룹", collapsed: true, links: [], groups: [{ ...existingGroup, id: "custom-child", name: "사용자 하위 그룹" }] }
  ];
  const snapshot = structuredClone(input);
  assert.deepEqual(validateCatalog(input), snapshot);
  assert.deepEqual(input, snapshot);
});

test("nested duplicate group IDs are rejected without overwriting contents", () => {
  const input = createCatalog();
  input.libraries[0].groups = [
    { id: "empty-group", name: "Empty", collapsed: false, groups: [], links: [] },
    { id: "other-group", name: "Other", collapsed: false, links: [], groups: [{ id: "empty-group", name: "Duplicate", collapsed: false, groups: [], links: [] }] }
  ];
  const snapshot = structuredClone(input);
  assert.throws(() => validateCatalog(input), /중복된 그룹 ID/u);
  assert.deepEqual(input, snapshot);
});
