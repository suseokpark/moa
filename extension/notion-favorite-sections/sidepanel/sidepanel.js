import { createPlatform } from "../src/favmoa-platform.js";
import { identifyUrl, validateCatalog, SYSTEM_GROUP_ID, flattenGroups, MAX_GROUP_DEPTH } from "../src/link-library.js";
import { prepareLinkInput } from "../src/link-entry.js";
import { findSavedPage } from "../src/link-navigation.js";
import { createGroupColorEditor } from "../src/group-colors.js";
import { createTreeDrag } from "../src/tree-drag.js";
import { createInteractionGuard } from "../src/interaction-guard.js";
import { createLinkSelection } from "../src/link-selection.js";
import { prepareOpenTabCandidates, prepareBookmarkCandidates } from "../src/open-tab-candidates.js";

const $ = (id) => document.getElementById(id);
const platform = createPlatform();
const linkSelection = createLinkSelection();
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
const dialogDisabledStates = new Map();
let dialogBusyFocus = null;
let mutationBusy = false;
let refreshGeneration = 0;
let deferredRender = false;
let pendingTreeEffect = null;
let pendingTabSnapshot = null;
const interactionGuard = createInteractionGuard({ onIdle: flushPendingUI });
const treeDrag = createTreeDrag({
  getContext: () => ({ library: library(), libraryId, catalogRevision: state?.revision, busy: linkSelection.isActive() || mutationBusy || dialogBusy || Boolean($("dialog")?.open || $("theme-dialog")?.open) }),
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
function announceNavigation(message = "", error = false) {
  const status = $("navigation-status");
  status.classList.toggle("sr-only", !error);
  status.dataset.error = String(error);
  status.textContent = message;
}
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

function setDialogBusy(value) {
  if (value === dialogBusy) return;
  dialogBusy = value;
  $("dialog-form").setAttribute("aria-busy", String(value));
  if (value) {
    dialogBusyFocus = document.activeElement;
    for (const control of $("dialog-form").querySelectorAll("input,select,button")) {
      dialogDisabledStates.set(control, control.disabled);
      control.disabled = true;
    }
  } else {
    for (const [control, disabled] of dialogDisabledStates) control.disabled = disabled;
    if (dialogDisabledStates.has(dialogBusyFocus) && dialogBusyFocus.isConnected && !dialogBusyFocus.disabled) dialogBusyFocus.focus();
    dialogBusyFocus = null;
    dialogDisabledStates.clear();
  }
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
  $("dialog-submit").disabled = false;
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
  showDialog(title, "저장", body => { name = field(body, "이름", current, { maxLength: 80 }); }, async () => {
    const previousIds = action.type === "addLibrary" ? new Set(state.catalog.libraries.map(item => item.id)) : null;
    const saved = await dispatch({ ...action, name: name.value.trim() }, revision);
    if (saved && previousIds) {
      const created = state.catalog.libraries.filter(item => !previousIds.has(item.id));
      // Only follow the one library created by this successful operation.
      // Failed/conflicting saves must not select another screen's new library.
      if (created.length === 1) {
        libraryId = created[0].id;
        $("search").value = "";
        suppressedFolds.clear();
        dialogOrigin = $("library-picker");
        dialogReturnKeys = [];
        render();
      }
    }
    return saved;
  });
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
function linkDialog(link = null, destination = {}, { move = false } = {}) {
  let revision = state.revision;
  let targetLibrary = libraryId;
  let catalog = state.catalog;
  let needsReview = false, reviewing = false, needsAcknowledgement = false;
  let title, url, to, location, locationSummary, reviewBox, reviewNote, comparison, acknowledge, reviewButton, reviewLibrary;
  const target = () => catalog.libraries.find(item => item.id === targetLibrary);
  const entry = () => target() && flattenGroups(target()).find(({ group }) => group.links.some(item => item.id === link?.id));
  const pathText = value => value ? value.path.map(group => group.name).join(" › ") : "";
  const pathIdentity = value => JSON.stringify(value?.path.map(group => group.id) || []);
  const originalEntry = entry();
  const original = link?.id ? { title: link.title, url: link.url, path: pathText(originalEntry), pathId: pathIdentity(originalEntry), groupId: originalEntry?.group.id } : null;
  const validTarget = () => !!target() && (!link?.id || !!entry()) &&
    (!to || flattenGroups(target()).some(({ group }) => group.id === to.group.value));
  const updateLocation = () => {
    if (locationSummary) locationSummary.textContent = `저장 위치 · ${to.group.selectedOptions[0]?.textContent || "그룹을 선택해 주세요"}`;
  };
  const updateControls = () => {
    $("dialog-submit").disabled = needsReview || reviewing || !validTarget() || (needsAcknowledgement && !acknowledge.checked);
    reviewButton.disabled = reviewing;
    acknowledge.disabled = reviewing;
    reviewLibrary.disabled = reviewing;
    if (to) to.group.disabled = reviewing || !target();
    updateLocation();
  };
  const refreshGroups = groupId => {
    if (!to) return;
    const groups = target() ? flattenGroups(target()) : [];
    const retained = groups.some(({ group }) => group.id === groupId);
    to.group.replaceChildren();
    if (!retained) option(to.group, target() ? "저장할 그룹을 선택해 주세요" : "먼저 보관함을 선택해 주세요", "", true);
    for (const value of groups) option(to.group, pathText(value), value.group.id, retained && value.group.id === groupId);
    if (location) location.open = true;
    updateLocation();
  };
  const describeReview = () => {
    comparison.replaceChildren(); needsAcknowledgement = false; acknowledge.checked = false; acknowledge.parentElement.hidden = true;
    let pathChanged = false;
    if (!target() || (link?.id && !entry())) {
      reviewNote.textContent = link?.id
        ? "기존 링크 또는 보관함이 삭제되어 수정·이동할 수 없습니다. 입력은 유지했습니다. 취소 후 최신 목록을 확인해 주세요. 자동으로 다시 만들지 않습니다."
        : "기존 보관함이 삭제됐습니다. 입력은 유지했습니다. 저장할 보관함과 그룹을 직접 선택해 주세요.";
      return;
    }
    if (link?.id) {
      const latestEntry = entry();
      const latest = latestEntry.group.links.find(item => item.id === link.id);
      const latestPath = pathText(latestEntry);
      pathChanged = pathIdentity(latestEntry) !== original.pathId || latestPath !== original.path;
      needsAcknowledgement = latest.title !== original.title || latest.url !== original.url || pathChanged;
      for (const [label, value] of [
        ["처음 열었을 때", `${original.title}\n${original.url}\n${original.path}`],
        ["최신 저장 내용", `${latest.title}\n${latest.url}\n${latestPath}`]
      ]) comparison.append(node("dt", label), node("dd", value));
      if (pathChanged && latestPath === original.path) comparison.append(node("dt", "위치 변경"), node("dd", "표시 이름은 같지만 다른 상위 그룹으로 이동했습니다."));
      acknowledge.parentElement.hidden = !needsAcknowledgement;
    }
    reviewNote.textContent = `보관함 · ${target().name}\n` + (needsAcknowledgement
      ? "다른 화면에서 링크의 내용이나 위치가 바뀌었습니다. 아래 비교 내용을 확인하고 직접 동의한 뒤 저장해 주세요. 내 입력은 그대로입니다."
      : "최신 목록을 확인했습니다. 입력과 저장할 위치를 검토한 뒤 아래 저장 버튼을 눌러 주세요. 확인만으로는 저장하지 않습니다.");
    if (pathChanged) reviewNote.textContent += " 그룹 경로가 바뀌었습니다.";
    if (to && !to.group.value) reviewNote.textContent += " 기존 목적지가 없어졌습니다. 그룹을 직접 선택해 주세요.";
  };
  const clearFieldError = control => {
    if (control.getAttribute("aria-invalid") !== "true") return;
    control.removeAttribute("aria-invalid");
    const descriptions = (control.getAttribute("aria-describedby") || "").split(/\s+/u).filter(id => id && id !== "dialog-error");
    if (descriptions.length) control.setAttribute("aria-describedby", descriptions.join(" "));
    else control.removeAttribute("aria-describedby");
    if ($("dialog-error").textContent === control.dataset.validationError) $("dialog-error").textContent = "";
    delete control.dataset.validationError;
  };
  const validateField = (control, input) => {
    try { return prepareLinkInput(input); }
    catch (error) {
      control.setAttribute("aria-invalid", "true");
      const descriptions = new Set((control.getAttribute("aria-describedby") || "").split(/\s+/u).filter(Boolean));
      descriptions.add("dialog-error"); control.setAttribute("aria-describedby", [...descriptions].join(" "));
      control.dataset.validationError = error.message;
      error.focusTarget = control;
      throw error;
    }
  };
  const submit = async () => {
    if (needsReview || reviewing || !validTarget() || (needsAcknowledgement && !acknowledge.checked)) return false;
    let action;
    if (move) action = { type: "moveLink", libraryId: targetLibrary, linkId: link.id, targetGroupId: to.group.value };
    else {
      for (const control of [url, title]) clearFieldError(control);
      // Validate the address first so an optional title error never blames it.
      validateField(url, { url: url.value });
      const input = validateField(title, { title: title.value, url: url.value });
      action = link?.id
        ? { type: "updateLink", libraryId: targetLibrary, linkId: link.id, ...input }
        : { type: "addLink", libraryId: targetLibrary, groupId: to.group.value, link: input };
    }
    try {
      const saved = await dispatch(action, revision, move ? "링크를 이동했습니다." : link?.id ? "링크를 수정했습니다." : "링크를 담았습니다. 잘못 담았다면 되돌리기를 누르세요.");
      if (saved && libraryId !== targetLibrary) { libraryId = targetLibrary; render(); }
      return saved;
    } catch (error) {
      if (error.code === "CONFLICT") {
        needsReview = true; acknowledge.checked = false; reviewBox.hidden = false;
        reviewNote.textContent = "다른 화면에서 목록이 바뀌었습니다. 입력은 유지했습니다. 최신 내용과 저장할 위치를 먼저 검토해 주세요.";
      }
      throw error;
    }
  };
  // The shared busy handler restores old disabled flags before this callback.
  submit.afterSubmit = () => { updateControls(); if (needsReview && !reviewing) reviewButton.focus(); };
  const reviewLatest = async () => {
    if (reviewing || dialogBusy || !$("dialog").open || dialogSubmit !== submit) return;
    reviewing = true; needsReview = true; acknowledge.checked = false;
    const disabled = new Map();
    for (const control of $("dialog-body").querySelectorAll("input,select,button")) { disabled.set(control, control.disabled); control.disabled = true; }
    reviewBox.setAttribute("aria-busy", "true");
    reviewNote.textContent = "입력은 유지하고 최신 저장 목록을 확인하고 있어요…";
    $("dialog-error").textContent = ""; updateControls();
    try {
      const result = await platform.load();
      if (!$("dialog").open || dialogSubmit !== submit) return;
      if (!result?.ok || !Number.isSafeInteger(result.revision) || result.revision < Math.max(revision, state.revision)) throw new Error("Invalid review snapshot");
      const latest = validateCatalog(result.catalog);
      const groupId = to?.group.value;
      catalog = latest; revision = result.revision;
      // Bind the edit/move to its original library even when adopt() falls back.
      adopt({ ...result, catalog });
      if (!target() && !link?.id) { targetLibrary = ""; reviewLibrary.parentElement.hidden = false; }
      reviewLibrary.replaceChildren();
      option(reviewLibrary, "저장할 보관함을 선택해 주세요", "", !targetLibrary);
      for (const value of catalog.libraries) option(reviewLibrary, value.name, value.id, value.id === targetLibrary);
      refreshGroups(groupId); describeReview(); needsReview = false;
    } catch {
      if (!$("dialog").open || dialogSubmit !== submit) return;
      reviewNote.textContent = "최신 목록을 확인하지 못했습니다. 입력은 유지했습니다. 다시 검토해 주세요.";
    } finally {
      if ($("dialog").open && dialogSubmit === submit) {
        for (const [control, wasDisabled] of disabled) control.disabled = wasDisabled;
        reviewing = false; reviewBox.setAttribute("aria-busy", "false"); updateControls();
        if (needsReview || (link?.id && !entry())) reviewButton.focus();
        else if (!target()) reviewLibrary.focus();
        else if (needsAcknowledgement) acknowledge.focus();
        else (to?.group || title).focus();
      }
    }
  };
  showDialog(move ? "링크 이동" : link?.id ? "링크 수정" : "링크 담기", move ? "이동" : link?.id ? "수정" : "담기", body => {
    if (move) body.append(node("p", link.title, "form-note"));
    else {
      url = field(body, "웹 주소", link?.url || "", { maxLength: 4096 });
      url.inputMode = "url"; url.autocapitalize = "off"; url.spellcheck = false;
      url.placeholder = "example.com 또는 https://…";
      title = field(body, "이름 (선택)", link?.title || "", { required: false, maxLength: 300 });
      title.placeholder = "비워두면 사이트 주소로 저장";
      for (const control of [url, title]) control.addEventListener("input", () => clearFieldError(control));
    }
    if (move) to = destinationFields(body, original.groupId);
    else if (!link?.id) {
      location = node("details", undefined, "destination-picker");
      locationSummary = node("summary");
      const fields = node("div");
      location.append(locationSummary, fields); body.append(location);
      to = destinationFields(fields, destination.groupId);
    }
    if (to) { to.group.classList.add("edit-target-group"); to.group.addEventListener("change", updateControls); updateLocation(); }
    reviewBox = node("div", undefined, "edit-review"); reviewBox.hidden = true;
    reviewNote = node("p", "", "form-note edit-review-note"); reviewNote.setAttribute("role", "status"); reviewNote.setAttribute("aria-atomic", "true");
    reviewButton = button("입력 유지하고 최신 목록 검토", reviewLatest, "quiet-button edit-review-button");
    comparison = node("dl", undefined, "edit-review-comparison");
    const acknowledgement = node("label", undefined, "edit-review-acknowledgement"); acknowledgement.hidden = true;
    acknowledge = node("input"); acknowledge.type = "checkbox"; acknowledge.classList.add("edit-review-ack");
    acknowledge.addEventListener("change", updateControls);
    acknowledgement.append(acknowledge, node("span", move ? "최신 링크를 확인했고, 선택한 그룹으로 이동합니다." : "최신 링크를 확인했고, 내 입력으로 수정합니다."));
    reviewBox.append(reviewNote, reviewButton, comparison, acknowledgement);
    reviewLibrary = selectField(reviewBox, "저장할 보관함"); reviewLibrary.classList.add("edit-target-library"); reviewLibrary.parentElement.hidden = true;
    reviewLibrary.addEventListener("change", () => {
      if (reviewing || needsReview || link?.id) return;
      targetLibrary = reviewLibrary.value; refreshGroups(""); describeReview(); updateControls();
    });
    body.append(reviewBox);
    body.append(node("p", "이 브라우저에 저장합니다. 인증용·일회성 주소는 저장하지 마세요.", "form-note"));
  }, submit);
}
function moveDialog(link) {
  return linkDialog(link, {}, { move: true });
}
function visibleSelectionIds() {
  return [...document.querySelectorAll("#tree .link-row")].map(row => row.dataset.linkId);
}
function renderSelectionControls() {
  const active = linkSelection.isActive();
  const visibleIds = visibleSelectionIds();
  const selectedVisible = visibleIds.filter(id => linkSelection.has(id)).length;
  const count = linkSelection.count();
  const hiddenCount = count - selectedVisible;
  $("selection-bar").hidden = !active;
  $("select-mode").textContent = active ? "선택 종료" : "선택";
  $("select-mode").setAttribute("aria-pressed", String(active));
  $("select-mode").disabled = !active && !linksOf(library()).length;
  $("add-group").hidden = active;
  $("add-link").hidden = active;
  $("selection-count").textContent = `${count}개 선택${hiddenCount > 0 ? ` · 화면 밖 ${hiddenCount}개 포함` : ""}`;
  $("select-visible").checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  $("select-visible").indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  $("select-visible").disabled = !visibleIds.length;
  $("move-selected").disabled = !count;
  $("drag-help").textContent = active ? "링크를 눌러 선택하세요. 검색·접힘으로 숨겨진 선택도 유지됩니다." : "끌어서 그룹으로 이동 · 메뉴에서도 이동 가능";
}
function toggleSelectionMode() {
  if (linkSelection.isActive()) linkSelection.stop();
  else linkSelection.start(libraryId, linksOf(library()).map(link => link.id));
  render();
}
function bulkMoveDialog() {
  const ids = linkSelection.selected();
  if (!ids.length || !linkSelection.isActive()) return;
  const revision = state.revision;
  const targetLibrary = libraryId;
  const selected = new Set(ids);
  const entries = flattenGroups(library());
  const visible = new Set(visibleSelectionIds());
  const hidden = ids.filter(id => !visible.has(id)).length;
  let to, hint;
  const countIncoming = () => entries.filter(({ group }) => group.id !== to.group.value)
    .reduce((sum, { group }) => sum + group.links.filter(link => selected.has(link.id)).length, 0);
  const updateHint = () => {
    const incoming = countIncoming();
    hint.textContent = incoming ? `${incoming}개 이동 · 이미 이 그룹에 있는 ${ids.length - incoming}개는 그대로 둡니다.` : "선택한 링크가 모두 이 그룹에 있습니다. 다른 그룹을 선택하세요.";
    $("dialog-submit").disabled = !incoming;
  };
  showDialog("선택한 링크 이동", "이동", body => {
    body.append(node("p", `${ids.length}개 링크를 함께 옮깁니다.${hidden ? ` 검색·접힘으로 화면 밖에 있는 ${hidden}개도 포함됩니다.` : ""} 원본 페이지는 바뀌지 않습니다.`, "form-note"));
    to = destinationFields(body);
    hint = node("p", "", "form-note"); hint.setAttribute("aria-live", "polite");
    body.append(hint);
    to.group.addEventListener("change", updateHint);
    updateHint();
  }, async () => {
    const count = countIncoming();
    if (!count) return false;
    const targetGroupId = to.group.value;
    await dispatch({ type: "moveLinks", libraryId: targetLibrary, linkIds: ids, targetGroupId }, revision, `${count}개 링크를 이동했습니다. 한 번의 되돌리기로 복구할 수 있어요.`);
    linkSelection.stop();
    $("search").value = "";
    dialogOrigin = $("select-mode"); dialogReturnKeys = [];
    render();
    runAfterTreeRender(() => {
      const target = [...document.querySelectorAll("[data-group-id]")].find(group => group.dataset.groupId === targetGroupId)?.querySelector(".fold");
      if (!target) return;
      if ($("dialog").open) dialogOrigin = target;
      else target.focus();
      target.scrollIntoView({ block: "nearest" });
    });
    return true;
  });
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
  // Keep the title and current/open badge in place, even during slow opens.
  // Inserting temporary text here squeezed the title and flashed on fast APIs.
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
  try {
    const result = await platform.openLink(link.url, options);
    if (!result.ok) announceNavigation(result.error || "페이지를 열지 못했습니다. 다시 눌러 주세요.", true);
    else {
      announceNavigation(result.reused ? "이미 열린 탭으로 이동했습니다." : "새 탭에서 열었습니다.");
      refreshTabs().catch(error => announce(error.message, true));
    }
  } catch (error) { announceNavigation(error.message || "탭을 열지 못했습니다. 다시 눌러 주세요.", true); }
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
  const selecting = linkSelection.isActive();
  const anchor = node(selecting ? "label" : "a", undefined, selecting ? "link-choice" : "link-anchor");
  anchor.title = `${link.title}\n${link.url}`;
  if (selecting) {
    const checkbox = node("input", undefined, "link-checkbox");
    checkbox.type = "checkbox"; checkbox.checked = linkSelection.has(link.id);
    checkbox.setAttribute("aria-label", `${link.title} 선택`);
    checkbox.dataset.focusKey = `select:${libraryId}:${link.id}`;
    if (checkbox.checked) row.classList.add("selected");
    checkbox.addEventListener("change", () => {
      linkSelection.toggle(link.id);
      checkbox.checked = linkSelection.has(link.id);
      row.classList.toggle("selected", checkbox.checked);
      renderSelectionControls();
    });
    anchor.append(checkbox);
  } else {
    anchor.href = link.url; anchor.rel = "noopener noreferrer";
    anchor.dataset.focusKey = `open:${libraryId}:${link.id}`;
  }
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
  if (selecting) { row.append(anchor); return row; }
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
  if (group.id !== SYSTEM_GROUP_ID && !linkSelection.isActive()) {
    fold.control.title += " · 끌어서 다른 그룹으로 이동";
    fold.control.setAttribute("aria-describedby", "drag-help");
    treeDrag.bindSource(fold.control, { kind: "group", id: group.id });
  }
  if (!linkSelection.isActive()) treeDrag.bindTarget(wrapper, { groupId: group.id });
  const addActions = [["여기에 링크 추가", () => linkDialog(null, { groupId: group.id })]];
  if (currentPath.length < MAX_GROUP_DEPTH) addActions.push(["하위 그룹 추가", () => nameDialog("하위 그룹 만들기", { type: "addGroup", parentGroupId: group.id })]);
  heading.append(fold.control);
  if (!linkSelection.isActive()) heading.append(menu(`${group.name}에 추가`, addActions, "plus", `add:${libraryId}:${group.id}`));
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
  if (!linkSelection.isActive()) heading.append(menu(group.name, groupActions, "more", `menu:${libraryId}:${group.id}`));
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
  linkSelection.reconcile(libraryId, linksOf(selectedLibrary).map(link => link.id));
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
  renderSelectionControls();
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
function chooseOpenTabs() { return chooseCandidateLinks(); }
function chooseBookmarks() { return chooseCandidateLinks({ bookmarks: true }); }
function chooseCandidateLinks({ bookmarks = false } = {}) {
  let revision = state.revision;
  let targetLibrary = libraryId;
  let destinationCatalog = state.catalog;
  let savedLinks = linksOf(library());
  const selection = new Set();
  let candidates = [], shown = [], loaded = false, limit = 200;
  let sourceResult, needsReview = false, reviewing = false;
  const itemName = bookmarks ? "북마크" : "탭";
  let filter, list, count, summary, selectVisible, clearSelection, more, retry, to, reviewBox, reviewNote, reviewButton, reviewLibrary;
  const destination = () => destinationCatalog.libraries.find(item => item.id === targetLibrary);
  const validDestination = () => !!destination() && flattenGroups(destination()).some(({ group }) => group.id === to.group.value);
  const updateSelection = () => {
    const visibleCount = shown.filter(item => selection.has(item.key)).length;
    const hidden = selection.size - visibleCount;
    count.textContent = `${selection.size}개 선택${hidden ? ` · 화면 밖 ${hidden}개 포함` : ""}`;
    selectVisible.checked = shown.length > 0 && visibleCount === shown.length;
    selectVisible.indeterminate = visibleCount > 0 && visibleCount < shown.length;
    selectVisible.disabled = reviewing || !loaded || !shown.length;
    clearSelection.disabled = reviewing || !selection.size;
    filter.disabled = reviewing || !loaded;
    more.disabled = reviewing;
    to.group.disabled = reviewing || !loaded || !candidates.length || !destination();
    reviewButton.disabled = reviewing;
    reviewLibrary.disabled = reviewing;
    for (const check of list.querySelectorAll("input")) check.disabled = reviewing;
    $("dialog-submit").disabled = needsReview || reviewing || !loaded || !selection.size || !validDestination();
    $("dialog-submit").textContent = selection.size ? `선택한 ${selection.size}개 담기` : "선택한 링크 담기";
  };
  const renderCandidates = () => {
    const query = filter.value.trim().toLocaleLowerCase();
    const matched = candidates.filter(item => `${item.title} ${item.url} ${item.folderPath || ""}`.toLocaleLowerCase().includes(query));
    shown = matched.slice(0, limit);
    list.replaceChildren();
    for (const item of shown) {
      const row = node("label", undefined, "check-row");
      const check = node("input"); check.type = "checkbox"; check.checked = selection.has(item.key);
      check.setAttribute("aria-label", `${item.title} 선택`);
      check.addEventListener("change", () => {
        if (check.checked && selection.size >= 1000) {
          check.checked = false; $("dialog-error").textContent = "한 번에 최대 1,000개까지 담을 수 있어요. 선택을 줄여 주세요.";
        } else {
          if (check.checked) selection.add(item.key); else selection.delete(item.key);
          $("dialog-error").textContent = "";
        }
        updateSelection();
      });
      const text = node("span", item.title); text.append(node("small", item.url));
      if (bookmarks && item.folderPath) text.append(node("small", `폴더 · ${item.folderPath}`));
      row.append(check, text); list.append(row);
    }
    if (!shown.length) list.append(node("p", candidates.length ? "검색 결과가 없습니다." : `새로 담을 ${itemName}${bookmarks ? "가" : "이"} 없습니다. 이미 저장한 페이지와 지원하지 않는 주소는 제외했어요.`, "form-note"));
    more.hidden = shown.length >= matched.length;
    more.textContent = `더 보기 (${shown.length}/${matched.length})`;
    updateSelection();
  };
  const prepareCandidates = () => {
    const prepared = bookmarks ? prepareBookmarkCandidates(sourceResult.candidates, savedLinks) : prepareOpenTabCandidates(sourceResult.tabs, savedLinks);
    candidates = prepared.candidates;
    const available = new Set(candidates.map(item => item.key));
    const previousCount = selection.size;
    for (const key of selection) if (!available.has(key)) selection.delete(key);
    summary.textContent = bookmarks
      ? `${sourceResult.demo ? "예시 북마크 · " : "Chrome 북마크 · "}새 링크 ${candidates.length}개 · 이미 저장 ${prepared.savedCount}개 · 중복 ${prepared.duplicateCount}개 제외. 지원하지 않는 주소는 표시하지 않습니다.`
      : `${sourceResult.demo ? "예시 탭 · " : "모든 Chrome 창 · "}새 링크 ${candidates.length}개 · 이미 저장 ${prepared.savedCount}개 · 중복 탭 ${prepared.duplicateCount}개 · 지원하지 않거나 비공개인 탭 ${(sourceResult.excludedCount || 0) + prepared.unsupportedCount}개 제외`;
    return previousCount - selection.size;
  };
  const refreshDestination = groupId => {
    const target = destination();
    const groups = target ? flattenGroups(target) : [];
    const retained = groups.some(({ group }) => group.id === groupId);
    to.group.replaceChildren();
    if (!retained) option(to.group, target ? "저장할 그룹을 선택해 주세요" : "먼저 보관함을 선택해 주세요", "", true);
    for (const value of groups) option(to.group, value.path.map(item => item.name).join(" › "), value.group.id, retained && value.group.id === groupId);
    if (target) {
      savedLinks = linksOf(target);
      const excluded = prepareCandidates();
      reviewNote.textContent = `최신 목록 확인 완료 · 이미 저장된 선택 ${excluded}개 제외 · ${selection.size}개 유지. ${retained ? "저장할 그룹을 검토한 뒤 아래 담기 버튼을 눌러 주세요." : "기존 목적지를 사용할 수 없습니다. 저장할 그룹을 직접 선택해 주세요."}`;
    } else {
      reviewNote.textContent = "기존 보관함이 없어졌습니다. 선택은 유지했습니다. 저장할 보관함과 그룹을 직접 선택해 주세요.";
    }
    renderCandidates();
  };
  const submit = async () => {
    if (needsReview || reviewing || !loaded || !selection.size || !validDestination()) return false;
    const links = candidates.filter(item => selection.has(item.key)).map(({ title, url }) => ({ title, url }));
    const targetGroupId = to.group.value;
    try {
      await dispatch({ type: "addLinks", libraryId: targetLibrary, groupId: targetGroupId, links, revealTarget: true }, revision, `${links.length}개 링크를 담았습니다. 한 번의 되돌리기로 취소할 수 있어요.`);
    } catch (error) {
      if (error.code === "CONFLICT") {
        needsReview = true; reviewBox.hidden = false;
        reviewNote.textContent = "다른 화면에서 목록이 바뀌었습니다. 선택을 유지한 채 최신 목록과 저장할 그룹을 먼저 검토해 주세요. 검토만으로는 저장하지 않습니다.";
      }
      throw error;
    }
    libraryId = targetLibrary;
    linkSelection.stop(); $("search").value = "";
    render();
    runAfterTreeRender(() => {
      const target = [...document.querySelectorAll("[data-group-id]")].find(group => group.dataset.groupId === targetGroupId)?.querySelector(".fold");
      if (target) {
        if ($("dialog").open) { dialogOrigin = target; dialogReturnKeys = []; }
        else target.focus();
        target.scrollIntoView({ block: "nearest" });
      }
    });
    return true;
  };
  // The shared form restores pre-save disabled flags. Reapply the conflict gate
  // afterwards so neither another click nor a direct submit can retry stale data.
  submit.afterSubmit = () => { updateSelection(); if (needsReview && !reviewing) reviewButton.focus(); };
  const reviewLatest = async () => {
    if (reviewing || dialogBusy || !$("dialog").open || dialogSubmit !== submit) return;
    reviewing = true; needsReview = true;
    reviewBox.setAttribute("aria-busy", "true");
    reviewNote.textContent = "선택은 유지하고 저장된 최신 목록을 확인하고 있어요…";
    $("dialog-error").textContent = ""; updateSelection();
    const groupId = to.group.value;
    try {
      const result = await platform.load();
      // One read at a time; handler identity also rejects a cancelled/replaced
      // dialog's late response. No browser source/permission is requested here.
      if (!$("dialog").open || dialogSubmit !== submit) return;
      if (!result?.ok || !Number.isSafeInteger(result.revision) || result.revision < Math.max(revision, state.revision)) throw new Error("Invalid review snapshot");
      const catalog = validateCatalog(result.catalog);
      destinationCatalog = catalog; revision = result.revision;
      adopt({ ...result, catalog });
      if (!destination()) {
        targetLibrary = "";
        reviewLibrary.parentElement.hidden = false;
      }
      reviewLibrary.replaceChildren();
      option(reviewLibrary, "저장할 보관함을 선택해 주세요", "", !targetLibrary);
      for (const value of catalog.libraries) option(reviewLibrary, value.name, value.id, value.id === targetLibrary);
      refreshDestination(groupId);
      needsReview = false;
    } catch {
      if (!$("dialog").open || dialogSubmit !== submit) return;
      reviewNote.textContent = "최신 목록을 확인하지 못했습니다. 선택은 유지했습니다. 다시 검토해 주세요.";
    } finally {
      if ($("dialog").open && dialogSubmit === submit) {
        reviewing = false; reviewBox.setAttribute("aria-busy", "false"); updateSelection();
        if (needsReview) reviewButton.focus();
        else if (!destination()) reviewLibrary.focus();
        else to.group.focus();
      }
    }
  };
  const loadCandidates = async () => {
    retry.hidden = true; summary.textContent = bookmarks ? "북마크를 확인하고 있어요. 권한 요청이 나타나면 허용 여부를 선택해 주세요." : "열린 탭을 확인하고 있어요…";
    let result;
    try { result = await (bookmarks ? platform.getBookmarkCandidates() : platform.getOpenTabCandidates()); }
    catch { result = { ok: false, error: `${bookmarks ? "북마크를" : "탭을"} 읽지 못했습니다. 다시 시도해 주세요.` }; }
    // Cancelled/older requests must never overwrite a newly opened dialog.
    if (!$("dialog").open || dialogSubmit !== submit) return;
    if (!result?.ok) {
      summary.textContent = result?.error || "목록을 읽지 못했습니다. 다시 시도해 주세요."; retry.hidden = false; return;
    }
    sourceResult = result; prepareCandidates(); loaded = true;
    renderCandidates();
    if (candidates.length && document.activeElement === $("dialog-close")) filter.focus();
  };
  showDialog(bookmarks ? "북마크 선택 가져오기" : "열린 탭 담기", "선택한 링크 담기", body => {
    body.append(node("p", bookmarks
      ? "선택한 북마크를 현재 보관함에 복사합니다. 원본은 그대로 유지됩니다. 인증용·일회성 주소는 제외하세요."
      : "현재 보관함에 선택한 페이지의 이름·주소만 복사합니다. 탭은 닫지 않습니다. 인증용·일회성 주소는 선택하지 마세요.", "form-note"));
    summary = node("p", "", "form-note"); summary.setAttribute("role", "status"); body.append(summary);
    reviewBox = node("div", undefined, "candidate-review"); reviewBox.hidden = true;
    reviewNote = node("p", "", "form-note"); reviewNote.setAttribute("role", "status"); reviewNote.setAttribute("aria-atomic", "true");
    reviewButton = button("선택 유지하고 최신 목록 검토", reviewLatest, "quiet-button candidate-review-button");
    reviewBox.append(reviewNote, reviewButton);
    reviewLibrary = selectField(reviewBox, "저장할 보관함"); reviewLibrary.classList.add("candidate-review-library"); reviewLibrary.parentElement.hidden = true;
    reviewLibrary.addEventListener("change", () => {
      if (reviewing || needsReview) return;
      targetLibrary = reviewLibrary.value; refreshDestination("");
    });
    filter = field(body, `${itemName} 검색`, "", { type: "search", required: false }); filter.disabled = true;
    if (bookmarks) filter.placeholder = "이름, 주소 또는 원본 폴더";
    filter.addEventListener("input", () => { limit = 200; renderCandidates(); });
    const controls = node("div", undefined, "tab-selection-controls");
    count = node("p", "0개 선택", "form-note"); count.setAttribute("role", "status"); count.setAttribute("aria-atomic", "true");
    clearSelection = button("선택 해제", () => {
      selection.clear(); $("dialog-error").textContent = ""; renderCandidates(); filter.focus();
    }, "text-button small"); clearSelection.disabled = true;
    const selectionHeader = node("div", undefined, "candidate-selection-header"); selectionHeader.append(count, clearSelection);
    const all = node("label", undefined, "select-visible-label"); selectVisible = node("input"); selectVisible.type = "checkbox"; selectVisible.disabled = true;
    selectVisible.addEventListener("change", () => {
      const adding = shown.some(item => !selection.has(item.key));
      const size = new Set([...selection, ...shown.map(item => item.key)]).size;
      if (adding && size > 1000) { $("dialog-error").textContent = "한 번에 최대 1,000개까지 담을 수 있어요. 검색으로 범위를 줄여 주세요."; updateSelection(); return; }
      for (const item of shown) { if (adding) selection.add(item.key); else selection.delete(item.key); }
      $("dialog-error").textContent = ""; renderCandidates();
    });
    all.append(selectVisible, node("span", `보이는 ${itemName} 모두 선택`)); controls.append(selectionHeader, all); body.append(controls);
    list = node("div", undefined, "check-list tab-candidates"); body.append(list);
    more = button("더 보기", () => { limit += 200; renderCandidates(); }, "text-button"); more.hidden = true; body.append(more);
    // Keep optional bookmark permission requests directly on the retry gesture.
    retry = node("button", "다시 불러오기"); retry.type = "button";
    retry.addEventListener("click", loadCandidates); retry.hidden = true; body.append(retry);
    to = destinationFields(body); to.group.disabled = true; to.group.classList.add("candidate-target-group");
    to.group.addEventListener("change", updateSelection);
    body.append(reviewBox);
    body.append(node("p", bookmarks
      ? "최대 1,000개 · 숨겨진 선택도 함께 담습니다. 원본 북마크가 바뀌었다면 이 창을 닫았다 다시 열어 주세요."
      : "검색으로 숨겨진 선택도 함께 담습니다. 한 번에 최대 1,000개. 목록은 이 창을 연 시점 기준이며, 새 탭을 포함하려면 닫았다 다시 열어 주세요.", "form-note"));
    $("dialog-submit").disabled = true;
  }, submit);
  return loadCandidates();
}
$("dialog-form").addEventListener("submit", async event => {
  event.preventDefault(); if (dialogBusy || !dialogSubmit) return;
  const activeHandler = dialogSubmit;
  setDialogBusy(true); $("dialog-error").textContent = "";
  try {
    const shouldClose = await activeHandler();
    setDialogBusy(false);
    if (shouldClose !== false && dialogSubmit === activeHandler) closeDialog();
  } catch (error) {
    setDialogBusy(false);
    $("dialog-error").textContent = error.message;
    error.focusTarget?.focus();
  }
  finally {
    setDialogBusy(false);
    if (dialogSubmit === activeHandler) activeHandler.afterSubmit?.();
  }
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
$("select-mode").addEventListener("click", toggleSelectionMode);
$("select-visible").addEventListener("change", () => { linkSelection.toggleVisible(visibleSelectionIds()); render(); });
$("move-selected").addEventListener("click", bulkMoveDialog);
$("save-current").addEventListener("click", revealCurrentPage);
$("save-tabs").addEventListener("click", chooseOpenTabs);
$("clear-search").addEventListener("click", clearSearch);
$("backup-shortcut").addEventListener("click", openBackupSettings);
$("library-picker").addEventListener("change", event => { libraryId = event.target.value; suppressedFolds.clear(); render(); });
$("search").addEventListener("input", render);
$("undo").addEventListener("click", async () => { try { adopt(await requireResult(platform.undo(state.revision))); announce("마지막 내용 편집을 되돌렸습니다. 직접 접고 펼친 상태는 유지됩니다."); } catch (error) { announce(error.message, true); } });
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
  if (event.key === "Escape" && !$("dialog").open && linkSelection.isActive()) { event.preventDefault(); toggleSelectionMode(); $("select-mode").focus(); return; }
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
catch (error) { announce(error.message, true); for (const id of ["add-link", "add-group", "add-library", "save-current", "save-tabs", "import-legacy", "import-backup", "reset-library"]) $(id).disabled = true; }
