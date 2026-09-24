import { createCatalog, flattenGroups, identifyUrl, validateCatalog, SYSTEM_GROUP_ID } from "../../extension/notion-favorite-sections/src/link-library.js";
import { createCatalogService, FAVMOA_STORAGE_KEY } from "../../extension/notion-favorite-sections/src/favmoa-service.js";

export const PRIMARY_LIBRARY = "library-personal";
export const SECONDARY_LIBRARY = "audit-other-library";
export const clone = value => structuredClone(value);
export const allLinks = catalog => catalog.libraries.flatMap(library => flattenGroups(library).flatMap(({ group }) => group.links));
export const groupIn = (catalog, groupId, libraryId = PRIMARY_LIBRARY) => flattenGroups(catalog.libraries.find(item => item.id === libraryId)).find(({ group }) => group.id === groupId)?.group;

/** Synthetic interest-specific data only. Exact collection size is per primary library. */
export function personaCatalog(persona) {
  const size = Math.max(5, Math.min(405, Number(persona.profile.collectionSize) || 25));
  const depth = Math.max(1, Math.min(5, Number(persona.profile.depth) || 1));
  const slug = String(persona.slug).toLowerCase().replace(/[^a-z0-9-]/gu, "-") || `persona-${persona.index}`;
  const interest = String(persona.interest).slice(0, 45);
  const catalog = createCatalog();
  const library = catalog.libraries[0]; library.name = `${interest} 보관함`;
  const root = { id: "audit-root", name: `수집함 ${interest}`, collapsed: false, links: [], groups: [], color: "#2563eb" };
  const destination = { id: "audit-destination", name: `읽을 자료 ${interest}`, collapsed: true, links: [], groups: [] };
  library.groups.push(root, destination);
  const path = [root];
  for (let level = 1; level < depth; level += 1) {
    const group = { id: `audit-depth-${level}`, name: `심화 ${level}단계 ${interest}`, collapsed: true, links: [], groups: [] };
    path.at(-1).groups.push(group); path.push(group);
  }
  const targetUrl = `https://${slug}.example.org/guide/focus?view=outline#reference`;
  const target = { id: "audit-focus", title: `${interest} FOCUS 대표 지침`, url: targetUrl, icon: "", ...identifyUrl(targetUrl) };
  delete target.key;
  path.at(-1).links.push(target);
  for (let index = 1; index < size; index += 1) {
    const url = `https://archive.example.net/${slug}/reference-${index}?view=reading#part-${index}`;
    const identity = identifyUrl(url);
    path[(index - 1) % path.length].links.push({ id: `audit-link-${index}`, title: `${interest} 참고 자료 ${index}`, url: identity.url, icon: "", provider: identity.provider });
  }
  // A separate library has its own copy of the focus URL. This exercises the
  // preferred-library lookup without implying cross-library de-duplication.
  catalog.libraries.push({ id: SECONDARY_LIBRARY, name: "다른 관심사 보관함", groups: [{ id: SYSTEM_GROUP_ID, name: "미분류 그룹", collapsed: false, links: [{ ...target, id: "audit-other-focus", title: "다른 보관함 사본" }], groups: [] }] });
  return { catalog: validateCatalog(catalog), size, depth, rootId: root.id, destinationId: destination.id, leafId: path.at(-1).id, target, pathIds: path.map(item => item.id) };
}

/** Real shipped service, substituted storage only; no Chrome user data. */
export function serviceFixture(catalog) {
  const data = { [FAVMOA_STORAGE_KEY]: { revision: 0, catalog: clone(catalog) } };
  const writes = []; let rejectSave = false;
  const sender = { id: "synthetic-persona-audit", url: "chrome-extension://synthetic-persona-audit/sidepanel/sidepanel.html" };
  const storage = {
    async setAccessLevel() {},
    async get(keys) {
      return keys === null ? clone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(data, key)).map(key => [key, clone(data[key])]));
    },
    async set(values) { if (rejectSave) throw new Error("synthetic storage write failure"); writes.push(clone(values)); Object.assign(data, clone(values)); }
  };
  const service = createCatalogService({ storage, runtimeId: sender.id });
  return {
    data, writes,
    failWrites(value) { rejectSave = value; },
    send: message => service.handle(message, sender),
    action: (action, expectedRevision = data[FAVMOA_STORAGE_KEY].revision) => service.handle({ type: "FAVMOA_ACTION", action: { libraryId: PRIMARY_LIBRARY, ...action }, expectedRevision }, sender),
    current: () => clone(data[FAVMOA_STORAGE_KEY]),
    undo: (expectedRevision = data[FAVMOA_STORAGE_KEY].revision) => service.handle({ type: "FAVMOA_UNDO", expectedRevision }, sender)
  };
}
