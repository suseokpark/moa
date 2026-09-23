import { flattenGroups, MAX_GROUP_DEPTH, SYSTEM_GROUP_ID } from "./link-library.js";

export const TREE_DRAG_TYPE = "application/x-favmoa-tree";

const rejected = (reason, message) => ({ ok: false, reason, message });

/** Plan a move against the exact library/revision where the drag began. */
export function planTreeDrop(context, source, targetGroupId) {
  if (!context?.library || context.library.id !== context.libraryId || !source
      || !["link", "group"].includes(source.kind) || typeof source.id !== "string"
      || !Number.isSafeInteger(context.catalogRevision) || context.catalogRevision < 0
      || !Number.isSafeInteger(source.catalogRevision) || source.catalogRevision < 0) {
    return rejected("missing-source", "이동할 항목을 다시 선택해 주세요.");
  }
  if (context.busy) return rejected("busy", "저장이 끝난 뒤 다시 이동해 주세요.");
  if (source.libraryId !== context.libraryId) return rejected("library-changed", "보관함이 바뀌었습니다. 항목을 다시 끌어 주세요.");
  if (source.catalogRevision !== context.catalogRevision) return rejected("stale", "목록이 바뀌었습니다. 항목을 다시 끌어 주세요.");
  let groups;
  try { groups = flattenGroups(context.library); }
  catch { return rejected("invalid-tree", "그룹 목록을 다시 확인해 주세요."); }
  const target = targetGroupId === null ? null : groups.find(item => item.group.id === targetGroupId);
  if (targetGroupId !== null && !target) return rejected("missing-target", "옮길 그룹을 찾을 수 없습니다.");
  const action = { libraryId: context.libraryId };
  if (source.kind === "link") {
    const owner = groups.find(item => item.group.links.some(link => link.id === source.id));
    if (!owner) return rejected("missing-source", "이동할 링크를 찾을 수 없습니다.");
    if (!target) return rejected("link-at-root", "링크는 그룹 안으로 옮겨 주세요.");
    if (owner.group.id === target.group.id) return rejected("same-target", "이미 이 그룹에 있는 링크입니다.");
    Object.assign(action, { type: "moveLink", linkId: source.id, targetGroupId: target.group.id });
  } else {
    const item = groups.find(candidate => candidate.group.id === source.id);
    if (!item) return rejected("missing-source", "이동할 그룹을 찾을 수 없습니다.");
    if (source.id === SYSTEM_GROUP_ID) return rejected("system-group", "미분류 그룹은 이동할 수 없습니다.");
    if (target?.path.some(group => group.id === source.id)) return rejected("cycle", "그룹을 자기 자신이나 하위 그룹 안으로 옮길 수 없습니다.");
    if ((item.parent?.id ?? null) === targetGroupId) return rejected("same-target", "이미 이 위치에 있는 그룹입니다.");
    const height = groups.reduce((maximum, candidate) => candidate.path.some(group => group.id === source.id)
      ? Math.max(maximum, candidate.path.length - item.path.length + 1) : maximum, 1);
    if ((target?.path.length ?? 0) + height > MAX_GROUP_DEPTH) {
      return rejected("depth", `그룹은 ${MAX_GROUP_DEPTH}단계를 넘게 중첩할 수 없습니다.`);
    }
    Object.assign(action, { type: "moveGroup", groupId: source.id, targetParentGroupId: targetGroupId });
  }
  return { ok: true, action, revision: source.catalogRevision };
}

/** Native drag is an optional shortcut; the existing move menus remain usable. */
export function createTreeDrag({ getContext, onMove, announce = () => {}, onEnd = () => {}, eventTarget = globalThis.document }) {
  let active = null, marker = null, moving = false, destroyed = false;
  let suppressedSource = null, suppressUntil = 0;
  let cachedPlan = null;
  const body = eventTarget?.body;
  const clock = () => Date.now();
  const classes = (element, method, ...names) => element?.classList?.[method](...names);
  const clearMarker = () => { classes(marker, "remove", "is-drop-target"); marker = null; };
  const reset = () => {
    clearMarker();
    classes(active?.element, "remove", "is-dragging");
    classes(body, "remove", "tree-dragging", "tree-dragging-group");
    active = null; cachedPlan = null;
  };
  const rememberClick = () => {
    if (active) {
      suppressedSource = { element: active.element, kind: active.kind, id: active.id };
      suppressUntil = clock() + 300;
    }
  };
  const finish = () => {
    if (!active) return;
    rememberClick(); reset(); onEnd();
  };
  const getPlan = targetGroupId => {
    const context = getContext();
    if (moving) return rejected("busy", "저장이 끝난 뒤 다시 이동해 주세요.");
    if (cachedPlan?.library === context?.library && cachedPlan.revision === context?.catalogRevision
        && cachedPlan.libraryId === context?.libraryId && cachedPlan.busy === context?.busy
        && cachedPlan.target === targetGroupId) return cachedPlan.result;
    const result = planTreeDrop(context, active, targetGroupId);
    cachedPlan = { library: context?.library, revision: context?.catalogRevision,
      libraryId: context?.libraryId, busy: context?.busy, target: targetGroupId, result };
    return result;
  };
  const ownTransfer = transfer => active && Array.from(transfer?.types || []).includes(TREE_DRAG_TYPE);
  const isControl = (target, sourceElement) => {
    const control = target?.closest?.("button, input, select, textarea, summary, details, [contenteditable], [role=button]");
    return Boolean(control && control !== sourceElement && sourceElement.contains(control));
  };

  function bindSource(element, source) {
    if (source.kind === "group" && source.id === SYSTEM_GROUP_ID) return () => {};
    element.draggable = true;
    let fromControl = false;
    const pointerDown = event => { fromControl = isControl(event.target, element); };
    const start = event => {
      event.stopPropagation();
      const context = getContext();
      let present = false;
      try {
        present = flattenGroups(context?.library).some(({ group }) => source.kind === "group"
          ? group.id === source.id : group.links.some(link => link.id === source.id));
      } catch { /* A replaced library must never produce a usable drag session. */ }
      if (destroyed || moving || context?.busy || !event.dataTransfer || fromControl
          || isControl(event.target, element) || !present
          || !["link", "group"].includes(source.kind) || context.library?.id !== context.libraryId
          || !Number.isSafeInteger(context.catalogRevision) || context.catalogRevision < 0) {
        event.preventDefault(); return;
      }
      reset();
      // The payload is only a session nonce, never a URL or saved user content.
      const token = globalThis.crypto?.randomUUID?.();
      if (!token) { event.preventDefault(); return; }
      try {
        event.dataTransfer.clearData();
        event.dataTransfer.setData(TREE_DRAG_TYPE, token);
        event.dataTransfer.effectAllowed = "move";
      } catch { event.preventDefault(); return; }
      active = { ...source, libraryId: context.libraryId, catalogRevision: context.catalogRevision, token, element };
      classes(element, "add", "is-dragging");
      classes(body, "add", "tree-dragging");
      if (source.kind === "group") classes(body, "add", "tree-dragging-group");
    };
    const end = () => { fromControl = false; finish(); };
    element.addEventListener("pointerdown", pointerDown);
    element.addEventListener("dragstart", start);
    element.addEventListener("dragend", end);
    return () => {
      element.removeEventListener("pointerdown", pointerDown);
      element.removeEventListener("dragstart", start);
      element.removeEventListener("dragend", end);
      element.draggable = false;
    };
  }

  function bindTarget(element, { groupId }) {
    const over = event => {
      // The nearest bound group owns the decision, including rejected drops.
      event.stopPropagation();
      event.preventDefault();
      if (destroyed || !ownTransfer(event.dataTransfer)) {
        clearMarker(); if (event.dataTransfer) event.dataTransfer.dropEffect = "none"; return;
      }
      const plan = getPlan(groupId);
      event.dataTransfer.dropEffect = plan.ok ? "move" : "none";
      if (marker !== element || !plan.ok) clearMarker();
      if (plan.ok) { marker = element; classes(marker, "add", "is-drop-target"); }
    };
    const leave = event => {
      event.stopPropagation();
      if (event.relatedTarget && element.contains(event.relatedTarget)) return;
      if (marker === element) clearMarker();
    };
    const drop = async event => {
      event.preventDefault(); event.stopPropagation();
      if (destroyed || !ownTransfer(event.dataTransfer)
          || event.dataTransfer.getData(TREE_DRAG_TYPE) !== active.token) {
        clearMarker(); return;
      }
      const plan = getPlan(groupId);
      rememberClick(); reset();
      if (!plan.ok) { announce(plan.message, plan.reason !== "same-target"); onEnd(); return; }
      moving = true;
      try { await onMove(plan.action, plan.revision); }
      catch (error) { if (!destroyed) announce(error?.message || "이동하지 못했습니다. 다시 시도해 주세요.", true); }
      finally { moving = false; if (!destroyed) onEnd(); }
    };
    element.addEventListener("dragover", over);
    element.addEventListener("dragenter", over);
    element.addEventListener("dragleave", leave);
    element.addEventListener("drop", drop);
    return () => {
      element.removeEventListener("dragover", over);
      element.removeEventListener("dragenter", over);
      element.removeEventListener("dragleave", leave);
      element.removeEventListener("drop", drop);
    };
  }

  const suppressClick = event => {
    if (event.detail === 0 || clock() > suppressUntil || !suppressedSource) return;
    const selector = suppressedSource.kind === "link" ? "[data-link-id]" : "[data-group-id]";
    const idKey = suppressedSource.kind === "link" ? "linkId" : "groupId";
    const renderedId = event.target?.closest?.(selector)?.dataset?.[idKey];
    if (!suppressedSource.element.contains(event.target) && renderedId !== suppressedSource.id) return;
    event.preventDefault(); event.stopImmediatePropagation();
    suppressedSource = null; suppressUntil = 0;
  };
  const escape = event => { if (event.key === "Escape") finish(); };
  eventTarget?.addEventListener("click", suppressClick, true);
  eventTarget?.addEventListener("keydown", escape);
  eventTarget?.addEventListener("dragend", finish);
  return {
    bindSource, bindTarget, reset, isDragging: () => Boolean(active),
    destroy() {
      destroyed = true; reset(); suppressedSource = null;
      eventTarget?.removeEventListener("click", suppressClick, true);
      eventTarget?.removeEventListener("keydown", escape);
      eventTarget?.removeEventListener("dragend", finish);
    }
  };
}
