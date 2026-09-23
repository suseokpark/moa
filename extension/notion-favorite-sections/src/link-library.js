import { decodeStoredWorkspace, validateMetadataEntries, validateWorkspaceKey } from "./storage-contract.js";

export const SYSTEM_GROUP_ID = "system-group-uncategorized";
const SECTION_PREFIX = "system-section-uncategorized-";
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_LINKS = 10_000;
const MAX_NODES = 20_000;
export const MAX_GROUP_DEPTH = 32;
let sequence = 0;

function fail(message) { throw new Error(message); }
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function fields(value, required, optional = []) {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    fail("지원하지 않거나 누락된 데이터 항목이 있습니다.");
  }
}
function text(value, label, max = 80, allowEmpty = false) {
  if (typeof value !== "string" || value.length > max + 200 || CONTROL.test(value)) fail(`${label}에 올바른 문자열을 입력해 주세요.`);
  const result = value.trim();
  if ((!result && !allowEmpty) || result.length > max) fail(`${label}은 ${allowEmpty ? 0 : 1}~${max}자로 입력해 주세요.`);
  return result;
}
function id(value) { return text(value, "ID", 320); }
function bool(value) { if (typeof value !== "boolean") fail("접힘 상태가 올바르지 않습니다."); return value; }
function readGroupColor(owner, allowReset = false) {
  // Colors are data, never CSS expressions or coercible objects. Inspect the
  // descriptor so malformed in-memory imports cannot invoke a color getter.
  const descriptor = Object.getOwnPropertyDescriptor(owner, "color");
  if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail("그룹 색상을 확인해 주세요.");
  const value = descriptor.value;
  if (allowReset && value === null) return null;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value)) fail("그룹 색상은 #RRGGBB 형식으로 입력해 주세요.");
  return value.toLowerCase();
}
function array(value, max, label) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}의 개수가 허용 범위를 초과하거나 형식이 올바르지 않습니다.`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${label}에 비어 있는 항목이 있습니다.`);
  }
  return value;
}
function unique(value, set, label) {
  if (set.has(value)) fail(`중복된 ${label}이 있습니다.`);
  set.add(value);
  return value;
}
function newId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${++sequence}`}`;
}

export function getSystemSectionId(groupId) { return `${SECTION_PREFIX}${groupId}`; }
function defaultGroup() {
  return { id: SYSTEM_GROUP_ID, name: "미분류 그룹", collapsed: false, groups: [], links: [] };
}
function makeLibrary(name, libraryId = newId("library")) {
  return { id: libraryId, name, groups: [defaultGroup()] };
}

export function createCatalog() {
  return { schemaVersion: 2, libraries: [makeLibrary("내 링크", "library-personal")], migratedLegacyKeys: [] };
}

function secretParameter(key) {
  const normalized = key.toLowerCase().replace(/[-_.]/g, "");
  return /(?:token|secret|password|credential|signature)$/u.test(normalized)
    || /^(?:passwd|code|codeverifier|authorization|auth|bearer|jwt|session|sessionid|apikey|key|sig|credentials)$/u.test(normalized)
    || /^(?:xamz|xgoog)/u.test(normalized);
}

/** Preserve ordinary query strings and fragments; refuse secret-bearing addresses instead of silently changing them. */
export function normalizeLinkUrl(input) {
  if (typeof input !== "string" || input.length > 4096 || CONTROL.test(input) || /\\/u.test(input)) {
    fail("올바른 웹 주소를 입력해 주세요.");
  }
  let url;
  try { url = new URL(input.trim()); } catch { fail("https://로 시작하는 웹 주소를 입력해 주세요."); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    fail("계정 정보가 없는 HTTP 또는 HTTPS 주소만 저장할 수 있습니다.");
  }
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); } catch { fail("올바른 웹 주소를 입력해 주세요."); }
  if (/(?:^|\/)(?:oauth2?|callback)(?:\/|$)/iu.test(decodedPath)
      || /(?:^|\/)(?:auth|signin|login)\/callback(?:\/|$)/iu.test(decodedPath)) {
    fail("로그인 인증 주소는 저장할 수 없습니다. 로그인 후 실제 페이지 주소를 사용해 주세요.");
  }
  const fragments = url.hash.slice(1);
  let decodedFragments;
  try { decodedFragments = decodeURIComponent(fragments); } catch { fail("올바른 웹 주소를 입력해 주세요."); }
  const fragmentParams = [fragments, decodedFragments].map(fragment => new URLSearchParams(fragment.includes("?") ? fragment.slice(fragment.indexOf("?") + 1) : fragment));
  for (const params of [url.searchParams, ...fragmentParams]) {
    for (const key of params.keys()) if (secretParameter(key)) {
      fail("인증 정보가 포함된 주소는 저장할 수 없습니다. 실제 페이지 주소를 사용해 주세요.");
    }
  }
  return url.href;
}

function notionId(value) {
  const compact = typeof value === "string" ? value.replaceAll("-", "") : "";
  return /^[0-9a-f]{32}$/iu.test(compact) ? compact.toLowerCase() : null;
}

export function identifyUrl(input) {
  const normalized = normalizeLinkUrl(input);
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase();
  const isNotion = ["notion.so", "notion.site", "app.notion.com"].some(domain => host === domain || host.endsWith(`.${domain}`));
  if (isNotion) {
    let lastSegment = url.pathname.split("/").filter(Boolean).at(-1) || "";
    try {
      const decoded = decodeURIComponent(lastSegment);
      // Decode encoded IDs, but never introduce path boundaries or controls.
      // Preserve the raw segment if it cannot be safely decoded.
      if (!/[/\\]/u.test(decoded) && !CONTROL.test(decoded)) lastSegment = decoded;
    } catch { /* Retain the existing raw-segment identity behavior. */ }
    const match = lastSegment.match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu);
    if (match) {
      const resourceId = notionId(match[1]);
      return { url: normalized, key: `notion:${resourceId}`, provider: "notion", resourceId };
    }
  }
  if (["drive.google.com", "docs.google.com"].includes(host)) {
    const match = url.pathname.match(/\/(?:folders|d)\/([A-Za-z0-9_-]+)(?:\/|$)/u);
    const resourceId = match?.[1] || (url.pathname === "/open" ? url.searchParams.get("id") : null);
    if (resourceId && /^[A-Za-z0-9_-]{1,200}$/u.test(resourceId)) {
      return { url: normalized, key: `google-drive:${resourceId}`, provider: "google-drive", resourceId };
    }
  }
  return { url: normalized, key: normalized, provider: "generic" };
}

function normalizeLink(value) {
  fields(value, ["id", "title", "url", "icon", "provider"], ["resourceId"]);
  const identity = identifyUrl(value.url);
  if (identity.provider !== value.provider || value.resourceId !== identity.resourceId) {
    fail("링크 주소와 서비스 정보가 일치하지 않습니다.");
  }
  return {
    id: id(value.id), title: text(value.title, "링크 제목", 300), url: identity.url,
    icon: text(value.icon, "아이콘", 64, true), provider: identity.provider,
    ...(identity.resourceId ? { resourceId: identity.resourceId } : {})
  };
}

/**
 * Strict backup/storage validation. Unknown fields are rejected, not persisted.
 * Version 1 is copied into the recursive version 2 model without modifying the
 * input. Only the exact generated section ID denotes an automatic section.
 * Empty libraries receive one usable default; empty groups stay empty.
 */
export function validateCatalog(input) {
  fields(input, ["schemaVersion", "libraries", "migratedLegacyKeys"]);
  if (![1, 2].includes(input.schemaVersion)) fail("지원하지 않는 데이터 버전입니다.");
  const libraryIds = new Set();
  let count = 0;
  let nodes = 0;
  const countNode = () => { if (++nodes > MAX_NODES) fail("트리 항목은 전체 20,000개를 넘을 수 없습니다."); };
  const libraries = array(input.libraries, 100, "라이브러리").map(rawLibrary => {
    countNode();
    fields(rawLibrary, ["id", "name", "groups"], ["origin"]);
    const library = {
      id: unique(id(rawLibrary.id), libraryIds, "라이브러리 ID"), name: text(rawLibrary.name, "라이브러리 이름"), groups: []
    };
    if (rawLibrary.origin !== undefined) {
      fields(rawLibrary.origin, ["type", "workspaceKey"]);
      if (rawLibrary.origin.type !== "notion") fail("지원하지 않는 원본 서비스입니다.");
      library.origin = { type: "notion", workspaceKey: validateWorkspaceKey(rawLibrary.origin.workspaceKey) };
    }
    const groupIds = new Set(), sectionIds = new Set(), linkIds = new Set(), destinations = new Set();
    const readLinks = value => array(value, MAX_LINKS, "링크").map(rawLink => {
      countNode();
      if (++count > MAX_LINKS) fail("최대 10,000개의 링크를 저장할 수 있습니다.");
      const link = normalizeLink(rawLink);
      unique(link.id, linkIds, "링크 ID");
      unique(identifyUrl(link.url).key, destinations, "링크 주소");
      return link;
    });
    const sourceGroups = array(rawLibrary.groups, input.schemaVersion === 1 ? 100 : MAX_NODES, "그룹");
    if (input.schemaVersion === 1) {
      // Validate old namespaces separately before merging them. Reserving every
      // old ID prevents a replacement ID from stealing a later section's ID.
      const oldGroups = sourceGroups.map(rawGroup => {
        countNode();
        fields(rawGroup, ["id", "name", "collapsed", "sections"]);
        const group = { id: unique(id(rawGroup.id), groupIds, "그룹 ID"), name: text(rawGroup.name, "그룹 이름"), collapsed: bool(rawGroup.collapsed), sections: [] };
        if (group.id.length > 260) fail("그룹 ID가 너무 깁니다.");
        group.sections = array(rawGroup.sections, 100, "섹션").map(rawSection => {
          countNode();
          fields(rawSection, ["id", "name", "collapsed", "links"]);
          return { id: unique(id(rawSection.id), sectionIds, "섹션 ID"), name: text(rawSection.name, "섹션 이름"), collapsed: bool(rawSection.collapsed), links: readLinks(rawSection.links) };
        });
        return group;
      });
      const reserved = new Set([...groupIds, ...sectionIds, SYSTEM_GROUP_ID]);
      let replacement = 0;
      const childId = sectionId => {
        if (!groupIds.has(sectionId) && sectionId !== SYSTEM_GROUP_ID) return sectionId;
        let candidate;
        do { candidate = `migrated-section-${++replacement}`; } while (reserved.has(candidate));
        reserved.add(candidate);
        return candidate;
      };
      library.groups = oldGroups.map(oldGroup => {
        const group = { id: oldGroup.id, name: oldGroup.name, collapsed: oldGroup.collapsed, groups: [], links: [] };
        for (const section of oldGroup.sections) {
          if (section.id === getSystemSectionId(group.id)) group.links.push(...section.links);
          else group.groups.push({ id: childId(section.id), name: section.name, collapsed: section.collapsed, groups: [], links: section.links });
        }
        return group;
      });
    } else {
      const ancestors = new Set();
      const readGroup = (rawGroup, depth) => {
        if (depth > MAX_GROUP_DEPTH) fail(`그룹은 ${MAX_GROUP_DEPTH}단계를 넘게 중첩할 수 없습니다.`);
        if (ancestors.has(rawGroup)) fail("그룹 트리에 순환 참조가 있습니다.");
        countNode();
        fields(rawGroup, ["id", "name", "collapsed", "groups", "links"], ["color"]);
        const group = { id: unique(id(rawGroup.id), groupIds, "그룹 ID"), name: text(rawGroup.name, "그룹 이름"), collapsed: bool(rawGroup.collapsed), groups: [], links: [] };
        if (Object.hasOwn(rawGroup, "color")) group.color = readGroupColor(rawGroup);
        if (group.id === SYSTEM_GROUP_ID && depth !== 1) fail("미분류 그룹은 최상위에 있어야 합니다.");
        ancestors.add(rawGroup);
        group.links = readLinks(rawGroup.links);
        group.groups = array(rawGroup.groups, MAX_NODES, "그룹").map(child => readGroup(child, depth + 1));
        ancestors.delete(rawGroup);
        return group;
      };
      library.groups = sourceGroups.map(group => readGroup(group, 1));
    }
    if (!library.groups.length) { countNode(); library.groups = [defaultGroup()]; }
    return library;
  });
  if (!libraries.length) fail("라이브러리가 한 개 이상 있어야 합니다.");
  const keys = new Set();
  const migratedLegacyKeys = array(input.migratedLegacyKeys, 100, "이전 기록").map(raw => {
    const value = text(raw, "이전 기록", 280);
    if (!value.startsWith("nfs:workspace:")) fail("이전 기록의 형식이 올바르지 않습니다.");
    validateWorkspaceKey(value.slice("nfs:workspace:".length));
    return unique(value, keys, "이전 기록");
  });
  const result = { schemaVersion: 2, libraries, migratedLegacyKeys };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 5 * 1024 * 1024) fail("저장 데이터는 5MB를 넘을 수 없습니다.");
  return result;
}

function ensureDefaultGroup(library) {
  let group = library.groups.find(item => item.id === SYSTEM_GROUP_ID);
  if (!group) { group = defaultGroup(); library.groups.push(group); }
  return group;
}
/** Preorder traversal with complete ancestor paths; links stay owned by a group. */
export function flattenGroups(library) {
  const result = [], seen = new Set();
  const visit = (groups, parent, path) => {
    for (const group of groups) {
      if (seen.has(group)) fail("그룹 트리에 순환 참조가 있습니다.");
      if (path.length >= MAX_GROUP_DEPTH) fail(`그룹은 ${MAX_GROUP_DEPTH}단계를 넘게 중첩할 수 없습니다.`);
      seen.add(group);
      const nextPath = [...path, group];
      result.push({ group, parent, path: nextPath });
      visit(group.groups, group, nextPath);
    }
  };
  visit(library.groups, null, []);
  return result;
}
export function countGroupLinks(group) {
  return flattenGroups({ groups: [group] }).reduce((count, item) => count + item.group.links.length, 0);
}
function findLink(library, linkId) {
  for (const { group } of flattenGroups(library)) {
    const index = group.links.findIndex(link => link.id === linkId);
    if (index >= 0) return { group, index, link: group.links[index] };
  }
  fail("링크를 찾을 수 없습니다. 목록을 다시 확인해 주세요.");
}
function destination(library, groupId) {
  const found = flattenGroups(library).find(item => item.group.id === groupId);
  if (!found) fail("그룹을 찾을 수 없습니다.");
  return found;
}
function assertNotDuplicate(library, url, exceptId) {
  const key = identifyUrl(url).key;
  for (const { group, path } of flattenGroups(library)) for (const link of group.links) {
    if (link.id !== exceptId && identifyUrl(link.url).key === key) fail(`이미 ‘${path.map(item => item.name).join(" > ")}’에 저장한 링크입니다.`);
  }
}
function fromInputLink(input, linkId = newId("link")) {
  if (!record(input)) fail("링크 정보를 입력해 주세요.");
  const identity = identifyUrl(input.url);
  return {
    id: linkId, title: text(input.title, "링크 제목", 300), url: identity.url, icon: text(input.icon ?? "", "아이콘", 64, true),
    provider: identity.provider, ...(identity.resourceId ? { resourceId: identity.resourceId } : {})
  };
}

function reorder(items, itemId, direction, protectedId) {
  if (!["up", "down"].includes(direction)) fail("정렬 방향이 올바르지 않습니다.");
  const index = items.findIndex(item => item.id === itemId);
  if (index < 0) fail("정렬할 항목을 찾을 수 없습니다.");
  if (itemId === protectedId) fail("미분류 항목은 순서를 바꿀 수 없습니다.");
  const next = index + (direction === "up" ? -1 : 1);
  if (next < 0 || next >= items.length || items[next].id === protectedId) return;
  [items[index], items[next]] = [items[next], items[index]];
}

export function applyCatalogAction(input, action) {
  const catalog = validateCatalog(input);
  if (!record(action) || typeof action.type !== "string") fail("지원하지 않는 작업입니다.");
  if (action.type === "addLibrary") {
    catalog.libraries.push(makeLibrary(text(action.name, "라이브러리 이름")));
    return validateCatalog(catalog);
  }
  const library = catalog.libraries.find(item => item.id === action.libraryId);
  if (!library) fail("라이브러리를 찾을 수 없습니다.");
  switch (action.type) {
    case "renameLibrary": library.name = text(action.name, "라이브러리 이름"); break;
    case "reorderGroup": {
      const { parent } = destination(library, action.groupId);
      reorder(parent ? parent.groups : library.groups, action.groupId, action.direction, SYSTEM_GROUP_ID);
      break;
    }
    case "addGroup": {
      const groupId = newId("group");
      const parent = action.parentGroupId == null ? null : destination(library, action.parentGroupId).group;
      (parent ? parent.groups : library.groups).push({ id: groupId, name: text(action.name, "그룹 이름"), collapsed: false, groups: [], links: [] });
      break;
    }
    case "setGroupColor": {
      const { group } = destination(library, action.groupId);
      const color = readGroupColor(action, true);
      if (color === null) delete group.color;
      else group.color = color;
      break;
    }
    case "renameGroup":
    case "toggleGroup":
    case "removeGroup": {
      const { group, parent } = destination(library, action.groupId);
      if (action.type === "toggleGroup") group.collapsed = !group.collapsed;
      else {
        if (group.id === SYSTEM_GROUP_ID) fail("미분류 그룹은 이름을 바꾸거나 삭제할 수 없습니다.");
        if (action.type === "renameGroup") group.name = text(action.name, "그룹 이름");
        else {
          const target = parent || ensureDefaultGroup(library);
          target.links.push(...group.links);
          const siblings = parent ? parent.groups : library.groups;
          const index = siblings.findIndex(item => item.id === group.id);
          // Nested children replace their removed parent at the same sibling
          // position. Top-level contents move together to the protected group.
          if (parent) siblings.splice(index, 1, ...group.groups);
          else { siblings.splice(index, 1); target.groups.push(...group.groups); }
        }
      }
      break;
    }
    case "moveGroup": {
      const { group, parent } = destination(library, action.groupId);
      if (group.id === SYSTEM_GROUP_ID) fail("미분류 그룹은 이동할 수 없습니다.");
      const target = action.targetParentGroupId == null ? null : destination(library, action.targetParentGroupId);
      if (target?.path.some(item => item.id === group.id)) fail("그룹을 자기 자신이나 하위 그룹 안으로 이동할 수 없습니다.");
      if ((target?.group.id ?? null) === (parent?.id ?? null)) break;
      const siblings = parent ? parent.groups : library.groups;
      siblings.splice(siblings.findIndex(item => item.id === group.id), 1);
      (target ? target.group.groups : library.groups).push(group);
      break;
    }
    case "addSection": case "renameSection": case "toggleSection":
    case "removeSection": case "reorderSection": case "moveSection":
      fail("섹션은 하위 그룹으로 변경되었습니다. 최신 화면에서 그룹을 선택해 주세요.");
    case "addLink": {
      if (action.sectionId !== undefined) fail("섹션 대신 저장할 그룹을 선택해 주세요.");
      const { group } = destination(library, action.groupId);
      const link = fromInputLink(action.link);
      assertNotDuplicate(library, link.url);
      group.links.push(link);
      break;
    }
    case "addLinks": {
      if (action.sectionId !== undefined) fail("섹션 대신 저장할 그룹을 선택해 주세요.");
      if (action.revealTarget !== undefined && typeof action.revealTarget !== "boolean") fail("저장 위치 표시 옵션이 올바르지 않습니다.");
      const { group, path } = destination(library, action.groupId);
      const inputs = array(action.links, 1000, "한 번에 추가할 링크");
      if (!inputs.length) fail("추가할 링크를 한 개 이상 선택해 주세요.");
      const keys = new Set(flattenGroups(library).flatMap(item => item.group.links.map(link => identifyUrl(link.url).key)));
      for (const inputLink of inputs) {
        const link = fromInputLink(inputLink);
        const key = identifyUrl(link.url).key;
        if (keys.has(key)) fail("이미 저장했거나 선택 목록에 중복된 링크가 있습니다. 중복을 제외하고 다시 추가해 주세요.");
        keys.add(key);
        group.links.push(link);
      }
      if (action.revealTarget) for (const ancestor of path) ancestor.collapsed = false;
      break;
    }
    case "updateLink": {
      const found = findLink(library, action.linkId);
      const link = fromInputLink({ ...found.link, ...(action.link || {}), ...(action.title !== undefined ? { title: action.title } : {}), ...(action.url !== undefined ? { url: action.url } : {}) }, found.link.id);
      assertNotDuplicate(library, link.url, link.id);
      found.group.links[found.index] = link;
      break;
    }
    case "removeLink": {
      const found = findLink(library, action.linkId);
      found.group.links.splice(found.index, 1);
      break;
    }
    case "moveLink": {
      const found = findLink(library, action.linkId);
      if (action.targetSectionId !== undefined) fail("섹션 대신 이동할 그룹을 선택해 주세요.");
      const { group } = destination(library, action.targetGroupId);
      if (group.id !== found.group.id) { found.group.links.splice(found.index, 1); group.links.push(found.link); }
      break;
    }
    case "moveLinks": {
      if (action.targetSectionId !== undefined) fail("섹션 대신 이동할 그룹을 선택해 주세요.");
      const ids = array(action.linkIds, MAX_LINKS, "이동할 링크");
      if (!ids.length) fail("이동할 링크를 한 개 이상 선택해 주세요.");
      const selected = new Set();
      for (const value of ids) unique(id(value), selected, "링크 ID");
      const { group: target, path } = destination(library, action.targetGroupId);
      const groups = flattenGroups(library);
      const existing = new Set(groups.flatMap(({ group }) => group.links.map(link => link.id)));
      if ([...selected].some(linkId => !existing.has(linkId))) fail("선택한 링크를 찾을 수 없습니다. 목록을 다시 확인해 주세요.");
      // Resolve the complete selection before changing the copied catalog.
      // Tree order wins over checkbox order; existing destination links stay put.
      const incoming = [];
      for (const { group } of groups) {
        if (group === target) continue;
        incoming.push(...group.links.filter(link => selected.has(link.id)));
        group.links = group.links.filter(link => !selected.has(link.id));
      }
      target.links.push(...incoming);
      // A true no-op also preserves folds, the storage revision and prior undo.
      if (incoming.length) for (const group of path) group.collapsed = false;
      break;
    }
    case "reorderLink": {
      if (!["up", "down"].includes(action.direction)) fail("정렬 방향이 올바르지 않습니다.");
      const { group, index } = findLink(library, action.linkId);
      const next = index + (action.direction === "up" ? -1 : 1);
      if (next >= 0 && next < group.links.length) [group.links[index], group.links[next]] = [group.links[next], group.links[index]];
      break;
    }
    case "resetLibrary": library.groups = [defaultGroup()]; break;
    default: fail("지원하지 않는 작업입니다.");
  }
  return validateCatalog(catalog);
}

function byOrder(items) { return items.map((value, index) => ({ value, index })).sort((a, b) => a.value.order - b.value.order || a.index - b.index).map(item => item.value); }

/** One-way, idempotent copy. Never mutates the original catalog or legacy storage. */
export function migrateLegacyStorage(input, storageObject) {
  let catalog = validateCatalog(input);
  if (!record(storageObject)) fail("이전 저장 데이터가 올바르지 않습니다.");
  let importedLibraries = 0, importedLinks = 0;
  const warnings = [];
  for (const [key, raw] of Object.entries(storageObject)) {
    if (!key.startsWith("nfs:workspace:") || catalog.migratedLegacyKeys.includes(key)) continue;
    const workspaceKey = key.slice("nfs:workspace:".length);
    try {
      validateWorkspaceKey(workspaceKey);
      const workspace = decodeStoredWorkspace(raw).workspace;
      const metadata = new Map();
      const entries = storageObject[`nfs:metadata:${workspaceKey}`];
      if (entries !== undefined) {
        if (!Array.isArray(entries) || entries.length > MAX_LINKS) warnings.push(`${workspaceKey}: 제목 캐시 형식을 확인할 수 없어 페이지 주소만 이전합니다.`);
        else for (const entry of entries) {
          try {
            const [validated] = validateMetadataEntries([entry]);
            metadata.set(validated.pageId, validated);
          }
          catch { warnings.push(`${workspaceKey}: 일부 제목 캐시를 읽지 못했습니다.`); }
        }
      }
      const library = { id: newId("legacy"), name: `Notion · ${workspaceKey}`.slice(0, 80), origin: { type: "notion", workspaceKey }, groups: [] };
      let linkCount = 0;
      const seen = new Set();
      library.groups = byOrder(workspace.groups).map(group => ({
        id: group.id, name: group.name, collapsed: group.collapsed,
        sections: byOrder(group.sections).map(section => ({
          id: section.id, name: section.name, collapsed: section.collapsed,
          links: byOrder(section.favorites).flatMap(favorite => {
            const resourceId = notionId(favorite.pageId);
            if (!resourceId || seen.has(resourceId)) { warnings.push(`${workspaceKey}: 올바르지 않거나 중복된 페이지 ID를 건너뛰었습니다.`); return []; }
            seen.add(resourceId);
            const cached = metadata.get(resourceId);
            let url = `https://www.notion.so/${resourceId}`;
            if (cached?.href) {
              try { url = normalizeLinkUrl(cached.href); }
              catch { warnings.push(`${workspaceKey}: 저장할 수 없는 페이지 주소가 있어 기존 ID 기반 주소로 이전합니다.`); }
            }
            linkCount += 1;
            return [{ id: `notion-${resourceId}`, title: cached?.title || `제목을 불러오지 못한 페이지 · ${resourceId.slice(-6)}`, icon: cached?.icon || "", url, provider: "notion", resourceId }];
          })
        }))
      }));
      const migrated = validateCatalog({ schemaVersion: 1, libraries: [library], migratedLegacyKeys: [] }).libraries[0];
      ensureDefaultGroup(migrated);
      const candidate = validateCatalog({ ...catalog, libraries: [...catalog.libraries, migrated], migratedLegacyKeys: [...catalog.migratedLegacyKeys, key] });
      catalog = candidate;
      importedLibraries += 1;
      importedLinks += linkCount;
    } catch {
      warnings.push(`${workspaceKey || "이름 없는 워크스페이스"}: 저장 데이터가 손상되었거나 한도를 초과해 이전하지 않았습니다. 기존 데이터는 유지됩니다.`);
    }
  }
  return { catalog, importedLibraries, importedLinks, warnings };
}
