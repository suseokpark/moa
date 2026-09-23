import { createPlatform } from "../src/favmoa-platform.js";
import { identifyUrl, validateCatalog, SYSTEM_GROUP_ID, flattenGroups, MAX_GROUP_DEPTH } from "../src/link-library.js";
import { prepareLinkInput } from "../src/link-entry.js";
import { findSavedPage } from "../src/link-navigation.js";
import { createGroupColorEditor } from "../src/group-colors.js";
import { createTreeDrag } from "../src/tree-drag.js";
import { createInteractionGuard } from "../src/interaction-guard.js";

const $ = (id) => document.getElementById(id);
const platform = createPlatform();
let state = null;
let libraryId = "";
let currentPage = null;
let openTabs = [];
let openTabKeys = new Set();
const openingUrls = new Set();
const openingCounts = new Map();
const urlKeys = new Map();
let pageKey = "";
let suppressedFolds = new Set();
let dialogSubmit = null;
let dialogOrigin = null;
let dialogReturnKeys = [];
let dialogBusy = false;
let mutationBusy = false;
let refreshGeneration = 0;
let deferredRender = false;
let pendingTreeEffect = null;
let pendingTabSnapshot = null;
const interactionGuard = createInteractionGuard({ onIdle: flushPendingUI });
const treeDrag = createTreeDrag({
  getContext: () => ({ library: library(), libraryId, catalogRevision: state?.revision, busy: mutationBusy || dialogBusy || Boolean($("dialog")?.open || $("theme-dialog")?.open) }),
  onMove: async (action, revision) => {
    await dispatch(action, revision, "이동했습니다. 되돌리기로 취소할 수 있어요.");
    runAfterTreeRender(() => {
      const movedId = action.linkId || action.groupId;
      const selector = action.linkId ? "[data-link-id]" : "[data-group-id]";
      const target = [...document.querySelectorAll(selector)].find(item => (action.linkId ? item.dataset.linkId : item.dataset.groupId) === movedId);
      const destinationId = action.targetGroupId || action.targetParentGroupId;
      const destination = [...document.querySelectorAll("[data-group-id]")].find(item => item.dataset.groupId === destinationId);
      const control = target?.querySelector(action.linkId ? "a" : ".fold") || destination?.querySelector(".fold");
      control?.focus(); control?.scrollIntoView({ block: "nearest" });
    });
  },
  announce,
  onEnd: flushPendingUI
});

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function uiIcon(name) {
  const icon = node("span", undefined, `ui-icon icon-${name}`);
  icon.setAttribute("aria-hidden", "true");
  return icon;
}
function button(text, callback, className = "") {
  const result = node("button", text, className);
  result.type = "button";
  result.addEventListener("click", () => { Promise.resolve().then(callback).catch(error => announce(error.message, true)); });
  return result;
}
function announce(message = "", error = false) { $("status").textContent = message; $("status").dataset.error = String(error); }
function library() { return state?.catalog.libraries.find(item => item.id === libraryId); }
function linksOf(value) { return flattenGroups(value).flatMap(({ group }) => group.links); }
function allLinkCount(catalog) { return catalog.libraries.reduce((sum, item) => sum + linksOf(item).length, 0); }
function safeKey(url) {
  if (urlKeys.has(url)) return urlKeys.get(url);
  let key = "";
  try { key = identifyUrl(url).key; } catch { /* Unsupported addresses are not links. */ }
  if (urlKeys.size >= 4096) urlKeys.clear();
  urlKeys.set(url, key);
  return key;
}
function adopt(result) {
  if (result.catalog && Number.isSafeInteger(result.revision)) {
    if (state && result.revision < state.revision) return;
    state = { ...result, canUndo: result.canUndo ?? state?.canUndo ?? false };
    if (!library()) libraryId = state.catalog.libraries[0]?.id || "";
    render();
  }
}
async function requireResult(promise) {
  const result = await promise;
  if (!result.ok) {
    if (result.conflict) adopt(result);
    const error = new Error(result.error || "작업을 완료하지 못했습니다.");
    error.code = result.code;
    error.stage = result.stage;
    throw error;
  }
  return result;
}
async function dispatch(action, expectedRevision = state?.revision, message = "이 브라우저에 저장했습니다.") {
  if (mutationBusy) throw new Error("이전 변경을 저장하고 있습니다. 잠시 뒤 다시 시도해 주세요.");
  mutationBusy = true;
  try {
    const result = await requireResult(platform.dispatch({ libraryId, ...action }, expectedRevision));
    adopt(result);
    announce(message);
    return true;
  } finally { mutationBusy = false; }
}

function closeDialog() {
  if (dialogBusy) return;
  $("dialog").close();
  dialogSubmit = null;
  restoreDialogFocus();
}
function restoreDialogFocus() {
  if (dialogOrigin?.isConnected && !dialogOrigin.disabled) { dialogOrigin.focus(); return; }
  const controls = [...document.querySelectorAll("[data-focus-key]")];
  for (const key of dialogReturnKeys) {
    const target = controls.find(control => control.dataset.focusKey === key && !control.disabled);
    if (target) { target.focus(); return; }
  }
  $("add-group").focus();
}
function showDialog(title, submitText, populate, onSubmit) {
  if ($("dialog").open) $("dialog").close();
  dialogOrigin = document.activeElement;
  dialogReturnKeys = dialogOrigin?.dataset.focusKey ? [dialogOrigin.dataset.focusKey] : [];
  for (let group = dialogOrigin?.closest("[data-group-id]"); group; group = group.parentElement?.closest("[data-group-id]")) {
    dialogReturnKeys.push(`g:${libraryId}:${group.dataset.groupId}`);
  }
  $("dialog-title").textContent = title;
  $("dialog-submit").textContent = submitText;
  $("dialog-error").textContent = "";
  $("dialog-body").replaceChildren();
  dialogSubmit = onSubmit;
  populate($("dialog-body"));
  $("dialog").showModal();
  $("dialog-body").querySelector("input,select,button")?.focus();
}
function field(parent, label, value = "", { type = "text", required = true, maxLength = 300, readOnly = false } = {}) {
  const wrapper = node("label", undefined, "field");
  const input = node("input");
  input.type = type; input.value = value; input.required = required; input.maxLength = maxLength; input.readOnly = readOnly;
  wrapper.append(node("span", label), input); parent.append(wrapper); return input;
}
function selectField(parent, label) {
  const wrapper = node("label", undefined, "field");
  const input = node("select"); wrapper.append(node("span", label), input); parent.append(wrapper); return input;
}
function option(select, label, value, selected = false) {
  const item = node("option", label); item.value = value; item.selected = selected; select.append(item);
}
function destinationFields(parent, groupId) {
  const group = selectField(parent, "저장할 그룹");
  for (const value of flattenGroups(library())) {
    option(group, value.path.map(item => item.name).join(" › "), value.group.id, value.group.id === groupId);
  }
  return { group };
}
function nameDialog(title, action, current = "") {
  const revision = state.revision;
  let name;
  showDialog(title, "저장", body => { name = field(body, "이름", current, { maxLength: 80 }); }, () => dispatch({ ...action, name: name.value.trim() }, revision));
}
function confirmDialog(title, description, submit, callback) {
  showDialog(title, submit, body => body.append(node("p", description, "form-note")), callback);
}
function groupColorDialog(group) {
  const revision = state.revision;
  const targetLibrary = libraryId;
  let editor;
  showDialog("그룹 색상", "저장", body => {
    editor = createGroupColorEditor({ documentRef: document, group });
    body.append(editor.element);
  }, async () => {
    const color = editor.getColor();
    editor.setBusy(true);
    try { return await dispatch({ type: "setGroupColor", libraryId: targetLibrary, groupId: group.id, color }, revision, "그룹 색상을 저장했습니다. 되돌리기로 취소할 수 있어요."); }
    finally { editor.setBusy(false); }
  });
}
function linkDialog(link = null, destination = {}) {
  const revision = state.revision;
  const targetLibrary = libraryId;
  let title, url, to;
  showDialog(link?.id ? "링크 수정" : "링크 담기", link?.id ? "수정" : "담기", body => {
    url = field(body, "웹 주소", link?.url || "", { maxLength: 4096 });
    url.inputMode = "url"; url.autocapitalize = "off"; url.spellcheck = false;
    url.placeholder = "example.com 또는 https://…";
    title = field(body, "이름 (선택)", link?.title || "", { required: false, maxLength: 300 });
    title.placeholder = "비워두면 사이트 주소로 저장";
    if (!link?.id) {
      const location = node("details", undefined, "destination-picker");
      const summary = node("summary");
      const fields = node("div");
      location.append(summary, fields); body.append(location);
      to = destinationFields(fields, destination.groupId);
      const updateLocation = () => { summary.textContent = `저장 위치 · ${to.group.selectedOptions[0]?.textContent}`; };
      to.group.addEventListener("change", updateLocation);
      updateLocation();
    }
    body.append(node("p", "이 브라우저에 저장합니다. 인증용·일회성 주소는 저장하지 마세요.", "form-note"));
  }, () => {
    const input = prepareLinkInput({ title: title.value, url: url.value });
    return dispatch(link?.id
      ? { type: "updateLink", libraryId: targetLibrary, linkId: link.id, ...input }
      : { type: "addLink", libraryId: targetLibrary, groupId: to.group.value, link: input }, revision, link?.id ? "링크를 수정했습니다." : "링크를 담았습니다. 잘못 담았다면 되돌리기를 누르세요.");
  });
}
function moveDialog(link) {
  const revision = state.revision;
  let to;
  const currentGroup = flattenGroups(library()).find(({ group }) => group.links.some(item => item.id === link.id))?.group;
  showDialog("링크 이동", "이동", body => { body.append(node("p", link.title, "form-note")); to = destinationFields(body, currentGroup?.id); }, () => dispatch({ type: "moveLink", linkId: link.id, targetGroupId: to.group.value }, revision));
}
function groupMoveTargets(selectedLibrary, groupId) {
  return flattenGroups(selectedLibrary).filter(({ path }) => !path.some(group => group.id === groupId));
}
function moveGroupDialog(group) {
  const revision = state.revision;
  const currentParent = flattenGroups(library()).find(item => item.group.id === group.id)?.parent;
  let target;
  showDialog("그룹 이동", "이동", body => {
    body.append(node("p", `${group.name} 안의 링크와 하위 그룹을 함께 옮깁니다.`, "form-note"));
    target = selectField(body, "옮길 그룹");
    option(target, "보관함 맨 위", "", !currentParent);
    for (const value of groupMoveTargets(library(), group.id)) {
      option(target, value.path.map(item => item.name).join(" › "), value.group.id, value.group.id === currentParent?.id);
    }
    body.append(node("p", "자기 자신과 하위 그룹은 이동 위치에서 제외됩니다.", "form-note"));
  }, () => dispatch({ type: "moveGroup", groupId: group.id, targetParentGroupId: target.value || null }, revision));
}
function positionMenu(details) {
  if (!details.open) return;
  const summary = details.querySelector("summary");
  const body = details.querySelector(".menu-items");
  const rect = summary.getBoundingClientRect();
  const below = Math.max(0, window.innerHeight - rect.bottom - 12);
  const above = Math.max(0, rect.top - 12);
  const openAbove = below < Math.min(body.scrollHeight, 320) && above > below;
  details.dataset.side = openAbove ? "above" : "below";
  body.style.maxHeight = `${Math.min(320, openAbove ? above : below)}px`;
}
function menu(label, actions, iconName = "more", focusKey = "") {
  const details = node("details", undefined, "row-menu");
  const summary = node("summary"); summary.setAttribute("aria-label", `${label} 메뉴`); summary.title = `${label} 메뉴`;
  if (focusKey) summary.dataset.focusKey = focusKey;
  summary.append(uiIcon(iconName));
  const body = node("div", undefined, "menu-items");
  for (const [text, action, danger] of actions) body.append(button(text, () => { details.open = false; summary.focus(); return action(); }, danger ? "danger" : ""));
  details.addEventListener("toggle", () => positionMenu(details));
  details.append(summary, body); return details;
}
function projectGroup(group, query, ancestorMatches = false) {
  const matches = value => String(value).toLocaleLowerCase().includes(query);
  const groupMatches = !query || ancestorMatches || matches(group.name);
  const children = group.groups.map(child => projectGroup(child, query, groupMatches)).filter(Boolean);
  const links = group.links.filter(link => groupMatches || matches(link.title) || matches(link.url));
  if (query && !groupMatches && !children.length && !links.length) return null;
  return { group, children, links, count: links.length + children.reduce((sum, child) => sum + child.count, 0),
    hasCurrent: Boolean(pageKey && group.links.some(link => safeKey(link.url) === pageKey)) || children.some(child => child.hasCurrent) };
}
function isExpanded(key, item, hasCurrent) { return !item.collapsed || (hasCurrent && !suppressedFolds.has(key)); }
async function toggleFold(key, item, expanded, action) {
  suppressedFolds.add(key);
  if (item.collapsed !== expanded) await dispatch(action, state.revision, "");
  else render();
  [...document.querySelectorAll("[data-fold]")].find(element => element.dataset.fold === key)?.focus();
}
function foldedHeader(label, count, key, item, hasCurrent, searching, action) {
  const expanded = searching || isExpanded(key, item, hasCurrent);
  const control = button("", () => searching ? undefined : toggleFold(key, item, expanded, action), "fold");
  control.disabled = searching;
  control.dataset.fold = key; control.dataset.focusKey = key; control.setAttribute("aria-expanded", String(expanded));
  control.append(uiIcon(expanded ? "caret-down" : "caret-right"));
  const mark = node("span", undefined, "group-color-dot");
  mark.setAttribute("aria-hidden", "true");
  control.append(mark);
  control.append(node("span", label, "label"), node("span", String(count), "count"));
  return { control, expanded };
}
function setLinkOpening(anchor, busy) {
  anchor.setAttribute("aria-busy", String(busy));
  let indicator = anchor.querySelector(".open-indicator");
  if (busy) {
    if (!indicator) { indicator = node("span", "", "open-indicator"); anchor.append(indicator); }
    if (indicator.dataset.idleText === undefined) indicator.dataset.idleText = indicator.textContent;
    indicator.textContent = "여는 중";
  } else if (indicator?.dataset.idleText !== undefined) {
    indicator.textContent = indicator.dataset.idleText;
    delete indicator.dataset.idleText;
    if (!indicator.textContent) indicator.remove();
  }
}
function updateOpeningLinks(url, busy) {
  for (const anchor of document.querySelectorAll("#tree .link-anchor")) {
    if (anchor.getAttribute("href") === url) setLinkOpening(anchor, busy);
  }
}
async function openSavedLink(link, options = {}) {
  if (!options.newTab && openingUrls.has(link.url)) return;
  openingUrls.add(link.url);
  openingCounts.set(link.url, (openingCounts.get(link.url) || 0) + 1);
  updateOpeningLinks(link.url, true);
  announce(`‘${link.title}’ 여는 중…`);
  try {
    const result = await platform.openLink(link.url, options);
    if (!result.ok) announce(result.error, true);
    else {
      announce(result.reused ? "이미 열린 탭으로 이동했습니다." : "새 탭에서 열었습니다.");
      refreshTabs().catch(error => announce(error.message, true));
    }
  } catch (error) { announce(error.message || "탭을 열지 못했습니다. 다시 눌러 주세요.", true); }
  finally {
    const remaining = openingCounts.get(link.url) - 1;
    if (remaining) openingCounts.set(link.url, remaining);
    else { openingCounts.delete(link.url); openingUrls.delete(link.url); updateOpeningLinks(link.url, false); }
  }
}
function renderLink(link) {
  const linkKey = safeKey(link.url);
  const active = linkKey === pageKey && pageKey;
  const row = node("div", undefined, `link-row${active ? " current" : ""}`);
  row.dataset.linkId = link.id;
  const anchor = node("a", undefined, "link-anchor");
  anchor.href = link.url; anchor.rel = "noopener noreferrer"; anchor.title = `${link.title}\n${link.url}`;
  anchor.dataset.focusKey = `open:${libraryId}:${link.id}`;
  anchor.setAttribute("aria-describedby", "drag-help");
  if (active) anchor.setAttribute("aria-current", "page");
  const icon = link.icon || "";
  const iconHolder = node("span", undefined, "link-icon");
  iconHolder.setAttribute("aria-hidden", "true");
  if (icon && icon.length <= 12 && !/https?:|[<>]/i.test(icon)) iconHolder.textContent = icon;
  else iconHolder.append(uiIcon("arrow-up-right"));
  anchor.append(iconHolder, node("span", link.title, "link-title"));
  const isOpen = openTabKeys.has(linkKey);
  if (isOpen) anchor.append(node("span", active ? "현재" : "열림", "open-indicator"));
  if (openingUrls.has(link.url)) setLinkOpening(anchor, true);
  anchor.addEventListener("click", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    openSavedLink(link, { newTab: event.ctrlKey || event.metaKey || event.shiftKey });
  });
  row.append(anchor, menu(link.title, [
    ["새 탭에서 열기", () => openSavedLink(link, { newTab: true })],
    ["이름·주소 수정", () => linkDialog(link)], ["다른 그룹으로 이동", () => moveDialog(link)],
    ["위로 이동", () => dispatch({ type: "reorderLink", linkId: link.id, direction: "up" })],
    ["아래로 이동", () => dispatch({ type: "reorderLink", linkId: link.id, direction: "down" })],
    ["팹모아에서 제거", () => { const revision = state.revision; confirmDialog("링크를 제거할까요?", `${link.title}\n원본 문서와 저장한 백업 파일은 그대로 둡니다.`, "제거", () => dispatch({ type: "removeLink", linkId: link.id }, revision)); }, true]
  ], "more", `link:${libraryId}:${link.id}`));
  treeDrag.bindSource(row, { kind: "link", id: link.id });
  return row;
}
function renderGroup(view, searching, path = []) {
  const { group, children, links, count, hasCurrent } = view;
  const currentPath = [...path, group];
  const wrapper = node("section", undefined, "group");
  wrapper.dataset.groupId = group.id;
  wrapper.dataset.deep = String(path.length >= 4);
  // Explicit fallback on every group prevents a child inheriting its parent's color.
  wrapper.style.setProperty("--group-color", group.color || "var(--muted)");
  wrapper.style.setProperty("--group-line", group.color || "var(--line)");
  const heading = node("div", undefined, "group-heading");
  const key = `g:${libraryId}:${group.id}`;
  const fold = foldedHeader(group.name, count, key, group, hasCurrent, searching, { type: "toggleGroup", groupId: group.id });
  fold.control.title = currentPath.map(item => item.name).join(" › ") + (searching ? " · 검색 중에는 하위 그룹까지 펼쳐 표시합니다." : "");
  if (group.id !== SYSTEM_GROUP_ID) {
    fold.control.title += " · 끌어서 다른 그룹으로 이동";
    fold.control.setAttribute("aria-describedby", "drag-help");
    treeDrag.bindSource(fold.control, { kind: "group", id: group.id });
  }
  treeDrag.bindTarget(wrapper, { groupId: group.id });
  const addActions = [["여기에 링크 추가", () => linkDialog(null, { groupId: group.id })]];
  if (currentPath.length < MAX_GROUP_DEPTH) addActions.push(["하위 그룹 추가", () => nameDialog("하위 그룹 만들기", { type: "addGroup", parentGroupId: group.id })]);
  heading.append(fold.control, menu(`${group.name}에 추가`, addActions, "plus", `add:${libraryId}:${group.id}`));
  const groupActions = [["그룹 색상", () => groupColorDialog(group)]];
  if (group.id !== SYSTEM_GROUP_ID) groupActions.push(
    ["그룹 이름 변경", () => nameDialog("그룹 이름 변경", { type: "renameGroup", groupId: group.id }, group.name)],
    ["다른 그룹으로 이동", () => moveGroupDialog(group)],
    ["위로 이동", () => dispatch({ type: "reorderGroup", groupId: group.id, direction: "up" })],
    ["아래로 이동", () => dispatch({ type: "reorderGroup", groupId: group.id, direction: "down" })],
    ["그룹만 제거", () => {
      const revision = state.revision;
      const destination = path.length ? `상위 그룹 ‘${path.at(-1).name}’` : "미분류 그룹";
      confirmDialog("그룹만 제거할까요?", `‘${group.name}’의 링크와 하위 그룹은 ${destination}으로 옮겨 보존합니다. 원본 문서는 바뀌지 않습니다.`, "그룹만 제거", () => dispatch({ type: "removeGroup", groupId: group.id }, revision));
    }, true]
  );
  heading.append(menu(group.name, groupActions, "more", `menu:${libraryId}:${group.id}`));
  wrapper.append(heading);
  if (fold.expanded) {
    const content = node("div", undefined, "group-children");
    for (const link of links) content.append(renderLink(link));
    for (const child of children) content.append(renderGroup(child, searching, currentPath));
    if (!links.length && !children.length) content.append(node("p", "링크나 하위 그룹을 추가해 보세요", "empty-group"));
    wrapper.append(content);
  }
  return wrapper;
}
function render() {
  if (!state) return;
  // Keep the exact pressed element alive through pointerup AND native click.
  // Catalog broadcasts and tab refreshes must not detach that event target.
  if (interactionGuard.isActive() || treeDrag.isDragging()) { deferredRender = true; return; }
  deferredRender = false;
  treeDrag.reset();
  openTabKeys = new Set(openTabs.map(tab => safeKey(tab.url)));
  const focusKey = !$("dialog").open ? document.activeElement?.dataset.focusKey : null;
  const selectedLibrary = library();
  $("library-picker").replaceChildren();
  for (const value of state.catalog.libraries) option($("library-picker"), value.name, value.id, value.id === libraryId);
  const query = $("search").value.trim().toLocaleLowerCase();
  $("clear-search").hidden = !query;
  renderSavedLocation();
  $("tree").replaceChildren();
  const total = linksOf(selectedLibrary).length;
  const visibleGroups = selectedLibrary.groups.map(group => projectGroup(group, query)).filter(Boolean);
  const shown = visibleGroups.reduce((sum, view) => sum + view.count, 0);
  for (const view of visibleGroups) {
    if (!query && !total && selectedLibrary.groups.length === 1 && view.group.id === SYSTEM_GROUP_ID && !view.children.length) continue;
    $("tree").append(renderGroup(view, Boolean(query)));
  }
  $("link-count").textContent = query ? `검색 결과 ${shown}개 / 전체 ${total}개` : `내 링크 ${total}개`;
  if ((!total && !query) || (query && !visibleGroups.length)) {
    const empty = node("div", undefined, "empty-state");
    const mark = node("div", undefined, "empty-mark"); mark.append(uiIcon(query ? "search" : "arrow-up-right"));
    empty.append(mark, node("h2", query ? "일치하는 링크가 없어요" : "자주 찾는 곳부터 담아보세요"), node("p", query ? "다른 이름이나 주소로 검색해 보세요." : "Notion, Drive, 어디든 같은 트리에 모을 수 있어요."));
    if (!query) {
      empty.append(button(currentPage ? "현재 페이지 담기" : "주소로 링크 담기", () => linkDialog(currentPage ? { title: currentPage.title, url: currentPage.url } : null), "primary small"));
      empty.append(button("북마크에서 가져오기", chooseBookmarks, "text-button"));
      empty.append(node("p", "로그인 없이 이 브라우저에 저장됩니다.", "form-note"));
    } else empty.append(button("검색 지우고 전체 보기", clearSearch, "text-button"));
    $("tree").append(empty);
  }
  $("undo").disabled = !state.canUndo;
  $("restore-previous-backup").disabled = !state.hasRestorePoint;
  $("restore-point-status").textContent = state.hasRestorePoint ? "복원 직전 목록을 이 브라우저에 보관하고 있습니다. 일반 편집 후에도 복구할 수 있어요." : "백업을 불러오면 바꾸기 직전 목록을 별도로 보관합니다.";
  $("backup-summary").textContent = `전체 보관함 ${state.catalog.libraries.length}개 · 링크 ${allLinkCount(state.catalog)}개를 파일로 보관합니다.`;
  restoreRenderedFocus(focusKey);
  if (pendingTreeEffect) {
    const effect = pendingTreeEffect; pendingTreeEffect = null;
    effect();
  }
}
function runAfterTreeRender(effect) {
  if (deferredRender) pendingTreeEffect = effect;
  else effect();
}
function restoreRenderedFocus(key) {
  if (!key || $("dialog").open) return;
  const target = [...document.querySelectorAll("[data-focus-key]")].find(control => control.dataset.focusKey === key && !control.disabled);
  target?.focus();
}
function clearSearch() { $("search").value = ""; render(); $("search").focus(); }
function renderSavedLocation() {
  const saved = findSavedPage(state?.catalog, currentPage?.url, libraryId);
  $("saved-location").hidden = !saved;
  $("saved-location").textContent = saved ? `담아둔 위치 · ${saved.library.name} › ${saved.path.map(group => group.name).join(" › ")}` : "";
  $("save-current").replaceChildren(uiIcon(saved ? "arrow-up-right" : "plus"), node("span", saved ? "저장 위치 보기" : "이 페이지 담기"));
}
function revealCurrentPage() {
  const saved = findSavedPage(state?.catalog, currentPage?.url, libraryId);
  if (!saved) { if (currentPage) linkDialog({ title: currentPage.title, url: currentPage.url }); return; }
  libraryId = saved.library.id; $("search").value = "";
  for (const group of saved.path) suppressedFolds.delete(`g:${libraryId}:${group.id}`);
  render();
  runAfterTreeRender(() => {
    const row = [...document.querySelectorAll("[data-link-id]")].find(item => item.dataset.linkId === saved.link.id);
    row?.querySelector("a")?.focus(); row?.scrollIntoView({ block: "nearest", behavior: "auto" });
  });
  announce("이미 담은 페이지의 저장 위치로 이동했습니다.");
}
function applyTabSnapshot({ page, tabs }) {
  const nextKey = safeKey(page?.url);
  const nextOpenKeys = new Set(tabs.map(tab => safeKey(tab.url)));
  const treeChanged = nextKey !== pageKey || nextOpenKeys.size !== openTabKeys.size
    || [...nextOpenKeys].some(key => !openTabKeys.has(key));
  currentPage = page; openTabs = tabs;
  if (nextKey !== pageKey) { pageKey = nextKey; suppressedFolds = new Set(); }
  $("current-page").replaceChildren(node("strong", page?.title || "저장할 웹페이지를 열어주세요"));
  if (page?.url) $("current-page").append(node("small", page.url));
  else $("current-page").append(node("small", "Chrome 설정 등 내부 페이지는 저장하지 않습니다."));
  $("save-current").disabled = !page;
  // Saved link titles do not change when a browser tab finishes loading.
  // Focus/visibility notifications with the same URL set need no tree rebuild.
  if (treeChanged) render();
  else renderSavedLocation();
}
function flushPendingUI() {
  if (interactionGuard.isActive() || treeDrag.isDragging()) return;
  if (pendingTabSnapshot) {
    const snapshot = pendingTabSnapshot;
    pendingTabSnapshot = null;
    applyTabSnapshot(snapshot);
  }
  if (deferredRender) render();
}
async function refreshTabs() {
  const generation = ++refreshGeneration;
  const [page, tabs] = await Promise.all([platform.getCurrentPage(), platform.getOpenTabs()]);
  if (generation !== refreshGeneration) return;
  pendingTabSnapshot = { page, tabs };
  flushPendingUI();
}
function openBackupSettings() {
  $("settings").open = true;
  $("backup-section").focus();
  $("backup-section").scrollIntoView({ block: "start" });
}
function backupPayload() { return { format: "favmoa-backup", version: 1, createdAt: new Date().toISOString(), catalog: state.catalog }; }
function exportBackup() {
  const data = new Blob([JSON.stringify(backupPayload())], { type: "application/json" });
  const url = URL.createObjectURL(data);
  const anchor = node("a"); anchor.href = url; anchor.download = `favmoa-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce("JSON 백업 파일 저장을 요청했습니다. 다운로드를 확인하고, 제목·URL이 담긴 파일을 안전하게 보관하세요.");
}
function restoreDialog(catalog, source) {
  const normalized = validateCatalog(catalog);
  const revision = state.revision;
  showDialog("백업으로 전체 목록을 바꿀까요?", "전체 목록 바꾸기", body => {
    body.append(node("p", source, "form-note"));
    const comparison = node("dl", undefined, "backup-comparison");
    comparison.append(node("dt", "현재 목록"), node("dd", `보관함 ${state.catalog.libraries.length}개 · 링크 ${allLinkCount(state.catalog)}개`), node("dt", "가져올 목록"), node("dd", `보관함 ${normalized.libraries.length}개 · 링크 ${allLinkCount(normalized)}개`));
    body.append(comparison, node("p", "링크를 합치는 기능이 아닙니다. 모든 보관함이 파일의 내용으로 바뀝니다. 바꾸기 직전 목록은 이 브라우저에 별도 안전 사본으로 보관합니다.", "form-note"));
    if (state.hasRestorePoint) body.append(node("p", "실제로 목록이 바뀌면 기존 안전 사본 1개를 교체 직전 목록으로 바꿉니다. 같은 목록이면 기존 사본을 유지합니다.", "form-note"));
    body.append(button("현재 목록을 먼저 JSON으로 저장", exportBackup, "quiet-button"));
  }, async () => {
    const result = await requireResult(platform.importBackup(normalized, revision));
    adopt(result);
    announce(result.revision === revision
      ? "현재 목록과 같아 변경하지 않았습니다. 기존 안전 사본도 유지됩니다."
      : "백업으로 목록을 바꿨습니다. 백업 메뉴의 ‘복원 전 목록 복구’로 이전 목록을 되찾을 수 있어요.");
    return true;
  });
}
async function chooseBookmarks() {
  const result = await requireResult(platform.getBookmarkCandidates());
  const existing = new Set(linksOf(library()).map(link => safeKey(link.url)));
  const seen = new Set();
  const candidates = result.candidates.filter(link => { const key = safeKey(link.url); if (!key || existing.has(key) || seen.has(key)) return false; seen.add(key); return true; });
  if (!candidates.length) { announce("새로 가져올 북마크가 없습니다. 이미 저장한 주소와 지원하지 않는 주소는 제외했습니다."); return; }
  const revision = state.revision;
  const targetLibrary = libraryId;
  let to;
  const selection = new Set();
  showDialog("북마크 선택 가져오기", "선택한 링크 담기", body => {
    body.append(node("p", "선택한 항목만 복사합니다. 원본 북마크는 바뀌지 않습니다. 한 번에 최대 1,000개를 선택할 수 있습니다.", "form-note"));
    const filter = field(body, "북마크 검색", "", { type: "search", required: false });
    const list = node("div", undefined, "check-list");
    const renderCandidates = () => {
      list.replaceChildren();
      const query = filter.value.toLocaleLowerCase();
      const shown = candidates.filter(item => `${item.title} ${item.url} ${item.folderPath}`.toLocaleLowerCase().includes(query)).slice(0, 300);
      for (const item of shown) {
        const row = node("label", undefined, "check-row");
        const check = node("input"); check.type = "checkbox"; check.checked = selection.has(item);
        check.addEventListener("change", () => { if (check.checked) selection.add(item); else selection.delete(item); $("dialog-submit").textContent = `선택한 ${selection.size}개 담기`; });
        const text = node("span", item.title); text.append(node("small", item.folderPath || item.url)); row.append(check, text); list.append(row);
      }
      if (!shown.length) list.append(node("p", "검색 결과가 없습니다.", "form-note"));
      if (candidates.length > 300) list.append(node("p", "한 번에 최대 300개를 표시합니다. 검색으로 범위를 좁혀주세요.", "form-note"));
    };
    filter.addEventListener("input", renderCandidates); renderCandidates(); body.append(list); to = destinationFields(body);
  }, () => {
    if (!selection.size) throw new Error("가져올 북마크를 선택해 주세요.");
    return dispatch({ type: "addLinks", libraryId: targetLibrary, groupId: to.group.value, links: [...selection].map(({ title, url }) => ({ title, url })) }, revision, `${selection.size}개 링크를 가져왔습니다.`);
  });
}

$("dialog-form").addEventListener("submit", async event => {
  event.preventDefault(); if (dialogBusy || !dialogSubmit) return;
  const activeHandler = dialogSubmit;
  dialogBusy = true; $("dialog-submit").disabled = true; $("dialog-error").textContent = "";
  try {
    const shouldClose = await activeHandler();
    dialogBusy = false;
    if (shouldClose !== false && dialogSubmit === activeHandler) closeDialog();
  } catch (error) {
    $("dialog-error").textContent = error.message;
  }
  finally { dialogBusy = false; $("dialog-submit").disabled = false; }
});
treeDrag.bindTarget($("root-drop"), { groupId: null });
document.addEventListener("dragstart", () => { for (const menu of document.querySelectorAll(".row-menu[open]")) menu.open = false; }, true);
$("dialog-close").addEventListener("click", closeDialog);
$("dialog-cancel").addEventListener("click", closeDialog);
$("dialog").addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
$("add-group").addEventListener("click", () => nameDialog("그룹 만들기", { type: "addGroup" }));
$("add-library").addEventListener("click", () => nameDialog("보관함 만들기", { type: "addLibrary" }));
$("rename-library").addEventListener("click", () => nameDialog("보관함 이름 변경", { type: "renameLibrary", libraryId }, library().name));
$("add-link").addEventListener("click", () => linkDialog());
$("save-current").addEventListener("click", revealCurrentPage);
$("clear-search").addEventListener("click", clearSearch);
$("backup-shortcut").addEventListener("click", openBackupSettings);
$("library-picker").addEventListener("change", event => { libraryId = event.target.value; suppressedFolds.clear(); render(); });
$("search").addEventListener("input", render);
$("undo").addEventListener("click", async () => { try { adopt(await requireResult(platform.undo(state.revision))); announce("직전 변경을 되돌렸습니다."); } catch (error) { announce(error.message, true); } });
$("import-legacy").addEventListener("click", () => {
  const revision = state.revision;
  confirmDialog("기존 Moa 목록을 가져올까요?", "이 확장에 남아 있는 기존 Notion 워크스페이스별 목록을 새 보관함으로 복사합니다. Notion 내부 메뉴는 종료되었지만 원본 저장 데이터는 삭제하지 않습니다. 자동 이전이나 동기화는 하지 않습니다.", "가져오기", async () => {
    const result = await requireResult(platform.importLegacy(revision)); adopt(result);
    announce(result.importedLibraries ? `${result.importedLibraries}개 보관함 · ${result.importedLinks}개 링크를 가져왔습니다.${result.warnings?.length ? ` 확인이 필요한 항목 ${result.warnings.length}개가 있습니다.` : ""}` : "이 확장에 가져올 새 Moa 목록이 없습니다. 이전 ID의 목록은 기존 0.1.10에서 JSON으로 내보낸 뒤 ‘JSON 백업 불러오기’로 옮겨주세요. 기존 확장을 삭제하지 마세요.");
    return true;
  });
});
$("import-bookmarks").addEventListener("click", () => chooseBookmarks().catch(error => announce(error.message, true)));
$("export-backup").addEventListener("click", exportBackup);
$("restore-previous-backup").addEventListener("click", () => {
  const revision = state.revision;
  confirmDialog("복원 전 목록으로 돌아갈까요?", "현재 전체 보관함을 마지막 JSON 복원 직전의 목록으로 바꿉니다. 안전 사본은 한 번 복구하면 사용 완료됩니다. 이 복구 자체는 다음 변경 전까지 ‘되돌리기’로 취소할 수 있습니다.", "이전 목록 복구", async () => {
    adopt(await requireResult(platform.restorePreviousBackup(revision)));
    announce("백업을 불러오기 직전 목록을 복구했습니다."); return true;
  });
});
$("import-backup").addEventListener("click", () => $("backup-file").click());
$("backup-file").addEventListener("change", async event => {
  const file = event.target.files[0]; event.target.value = ""; if (!file) return;
  try {
    // Allow the maximum 5 MiB catalog plus its backup envelope. The validated
    // catalog bound still applies after parsing.
    if (file.size > 6 * 1024 * 1024) throw new Error("6MiB 이하의 팹모아 백업 파일을 선택해 주세요.");
    const parsed = JSON.parse(await file.text());
    if (parsed.format !== "favmoa-backup" || parsed.version !== 1) throw new Error("지원하는 팹모아 백업 형식이 아닙니다.");
    restoreDialog(parsed.catalog, file.name);
  } catch (error) { announce(`백업을 가져오지 못했습니다. ${error.message}`, true); }
});
$("reset-library").addEventListener("click", () => {
  const selected = library(); const revision = state.revision;
  confirmDialog("현재 보관함을 초기화할까요?", `${selected.name} · 링크 ${linksOf(selected).length}개\n이 보관함의 그룹·하위 그룹·링크만 비웁니다. 다른 보관함, 원본 문서와 저장한 백업 파일은 그대로 둡니다.`, "초기화", () => dispatch({ type: "resetLibrary", libraryId: selected.id }, revision, "현재 보관함을 비웠습니다. 되돌리기로 복구할 수 있습니다."));
});
document.addEventListener("keydown", event => {
  if ($("theme-dialog")?.open) return;
  if (event.key === "/" && !$("dialog").open && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) { event.preventDefault(); $("search").focus(); }
  if (event.key === "Escape" && !$("dialog").open && document.activeElement === $("search") && $("search").value) { event.preventDefault(); clearSearch(); return; }
  if (event.key === "Escape" && !$("dialog").open) for (const value of document.querySelectorAll(".row-menu[open]")) { value.open = false; value.querySelector("summary").focus(); }
});
document.addEventListener("click", event => { for (const value of document.querySelectorAll(".row-menu[open]")) if (!value.contains(event.target)) value.open = false; });
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshTabs(); });
window.addEventListener("focus", refreshTabs);
$("demo-notice").hidden = platform.mode !== "demo";
platform.subscribe(event => {
  if (event.type === "tabs-changed") { refreshTabs(); return; }
  if (event.catalog && (!state || event.revision > state.revision)) {
    adopt(event);
    if ($("dialog").open) $("dialog-error").textContent = "다른 화면에서 목록이 변경되었습니다. 저장 시 최신 상태를 다시 확인합니다.";
  }
});
try { adopt(await requireResult(platform.load())); await refreshTabs(); }
catch (error) { announce(error.message, true); for (const id of ["add-link", "add-group", "add-library", "save-current", "import-legacy", "import-backup", "reset-library"]) $(id).disabled = true; }
