import assert from "node:assert/strict";
import test from "node:test";
import { createTreeDrag, planTreeDrop, TREE_DRAG_TYPE } from "../src/tree-drag.js";
import { applyCatalogAction, MAX_GROUP_DEPTH, SYSTEM_GROUP_ID } from "../src/link-library.js";

const link = id => ({ id, title: `Example ${id}`, url: `https://example.com/${id}`, icon: "", provider: "generic" });
const group = (id, groups = [], links = []) => ({ id, name: id, collapsed: false, groups, links });
function contextFixture() {
  return { libraryId: "library-example", catalogRevision: 7, busy: false,
    library: { id: "library-example", name: "Example", groups: [group(SYSTEM_GROUP_ID),
      group("work", [group("child", [group("grandchild")], [link("child-link")])], [link("work-link")]), group("personal")] } };
}
const source = (kind, id, context = contextFixture()) => ({ kind, id, libraryId: context.libraryId, catalogRevision: context.catalogRevision });
const catalogFor = context => ({ schemaVersion: 2, libraries: [context.library], migratedLegacyKeys: [] });

test("plans and applies link moves between groups without mutating the source", () => {
  const context = contextFixture(), before = structuredClone(context);
  const plan = planTreeDrop(context, source("link", "work-link"), "personal");
  assert.deepEqual(plan, { ok: true, revision: 7, action: { libraryId: context.libraryId, type: "moveLink", linkId: "work-link", targetGroupId: "personal" } });
  const moved = applyCatalogAction(catalogFor(context), plan.action);
  assert.equal(moved.libraries[0].groups[1].links.length, 0);
  assert.equal(moved.libraries[0].groups[2].links[0].id, "work-link");
  assert.deepEqual(context, before);
});

test("plans whole-group nesting and returning a nested group to the root", () => {
  const context = contextFixture();
  const nested = planTreeDrop(context, source("group", "work"), "personal");
  const moved = applyCatalogAction(catalogFor(context), nested.action);
  assert.equal(moved.libraries[0].groups[1].groups[0].groups[0].groups[0].id, "grandchild");
  assert.equal(moved.libraries[0].groups[1].groups[0].links[0].id, "work-link");
  const root = planTreeDrop(context, source("group", "child"), null);
  assert.equal(root.action.targetParentGroupId, null);
  assert.equal(applyCatalogAction(catalogFor(context), root.action).libraries[0].groups.at(-1).id, "child");
});

test("same location is a no-op; links cannot become root nodes", () => {
  const context = contextFixture();
  for (const [kind, id, target] of [["link", "work-link", "work"], ["group", "child", "work"], ["group", "work", null]]) {
    assert.equal(planTreeDrop(context, source(kind, id), target).reason, "same-target");
  }
  assert.equal(planTreeDrop(context, source("link", "work-link"), null).reason, "link-at-root");
});

test("system group remains protected while receiving links or ordinary groups", () => {
  const context = contextFixture();
  assert.equal(planTreeDrop(context, source("group", SYSTEM_GROUP_ID), "work").reason, "system-group");
  assert.equal(planTreeDrop(context, source("link", "work-link"), SYSTEM_GROUP_ID).ok, true);
  assert.equal(planTreeDrop(context, source("group", "work"), SYSTEM_GROUP_ID).ok, true);
});

test("self and descendant drops cannot form group cycles", () => {
  const context = contextFixture();
  for (const target of ["work", "child", "grandchild"]) {
    assert.equal(planTreeDrop(context, source("group", "work"), target).reason, "cycle");
  }
});

test("subtree height is included in the maximum depth guard", () => {
  const context = contextFixture();
  let chain = group("depth-32");
  for (let depth = MAX_GROUP_DEPTH - 1; depth >= 1; depth -= 1) chain = group(`depth-${depth}`, [chain]);
  context.library.groups.push(chain);
  assert.equal(planTreeDrop(context, source("group", "work"), "depth-30").reason, "depth");
  const boundary = planTreeDrop(context, source("group", "work"), "depth-29");
  assert.equal(boundary.ok, true);
  assert.doesNotThrow(() => applyCatalogAction(catalogFor(context), boundary.action));
});

test("stale, switched, busy and removed entries never produce a move", () => {
  const context = contextFixture(), dragged = source("link", "work-link");
  assert.equal(planTreeDrop({ ...context, catalogRevision: 8 }, dragged, "personal").reason, "stale");
  assert.equal(planTreeDrop(context, { ...dragged, libraryId: "other" }, "personal").reason, "library-changed");
  assert.equal(planTreeDrop({ ...context, busy: true }, dragged, "personal").reason, "busy");
  assert.equal(planTreeDrop(context, source("link", "removed"), "personal").reason, "missing-source");
  assert.equal(planTreeDrop(context, source("group", "removed"), "personal").reason, "missing-source");
  assert.equal(planTreeDrop(context, dragged, "removed").reason, "missing-target");
  assert.equal(planTreeDrop({ ...context, libraryId: "wrong" }, dragged, "personal").reason, "missing-source");
  assert.equal(planTreeDrop({ ...context, catalogRevision: undefined }, { ...dragged, catalogRevision: undefined }, "personal").reason, "missing-source");
});

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase(); this.parentNode = null; this.children = [];
    this.listeners = new Map(); this.draggable = false; this.dataset = {};
    const names = new Set();
    this.classList = { add: (...values) => values.forEach(value => names.add(value)), remove: (...values) => values.forEach(value => names.delete(value)), contains: value => names.has(value) };
  }
  append(...elements) { for (const element of elements) { element.parentNode = this; this.children.push(element); } }
  contains(element) { return this === element || this.children.some(child => child.contains(element)); }
  closest(selector) {
    if (selector === "[data-link-id]" || selector === "[data-group-id]") {
      const key = selector === "[data-link-id]" ? "linkId" : "groupId";
      return this.dataset[key] ? this : this.parentNode?.closest(selector) || null;
    }
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "DETAILS"].includes(this.tagName)) return this;
    return this.parentNode?.closest(selector) || null;
  }
  addEventListener(type, handler, capture = false) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ handler, capture });
  }
  removeEventListener(type, handler) { this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.handler !== handler)); }
}
class Transfer {
  constructor(initial = {}) { this.data = new Map(Object.entries(initial)); this.effectAllowed = "all"; this.dropEffect = "none"; }
  get types() { return [...this.data.keys()]; }
  clearData() { this.data.clear(); }
  setData(type, value) { this.data.set(type, value); }
  getData(type) { return this.data.get(type) || ""; }
}
function event(type, target, dataTransfer = new Transfer(), extra = {}) {
  return { type, target, dataTransfer, detail: 1, defaultPrevented: false, stopped: false, immediate: false, ...extra,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.stopped = true; this.immediate = true; } };
}
async function fire(type, target, transfer, extra) {
  const value = event(type, target, transfer, extra), path = [];
  for (let current = target; current; current = current.parentNode) path.push(current);
  for (const capture of [true, false]) {
    for (const element of capture ? [...path].reverse() : path) {
      for (const entry of element.listeners.get(type) || []) {
        if (entry.capture === capture) await entry.handler(value);
        if (value.immediate) break;
      }
      if (value.stopped) break;
    }
    if (value.stopped) break;
  }
  return value;
}
function controllerFixture(onMove) {
  let context = contextFixture();
  const document = new Element("document"), body = new Element("body");
  document.body = body; document.append(body);
  const row = new Element(), anchor = new Element("a"), menu = new Element("summary"), target = new Element(), root = new Element();
  row.append(anchor, menu); body.append(row, target, root);
  const calls = [], announcements = [];
  let ends = 0;
  const controller = createTreeDrag({ getContext: () => context, eventTarget: document,
    onMove: onMove || ((...args) => calls.push(args)), announce: (...args) => announcements.push(args), onEnd: () => { ends += 1; } });
  controller.bindSource(row, { kind: "link", id: "work-link" });
  controller.bindTarget(target, { groupId: "personal" });
  controller.bindTarget(root, { groupId: null });
  return { controller, document, body, row, anchor, menu, target, root, calls, announcements, get ends() { return ends; },
    get context() { return context; }, setContext: value => { context = value; },
    async start(element = anchor, transfer = new Transfer()) { await fire("pointerdown", element, transfer); const result = await fire("dragstart", element, transfer); return { transfer, result }; } };
}

test("native link drag sends only a nonce, marks its target, and dispatches exact expected revision", async () => {
  const fixture = controllerFixture();
  const { transfer } = await fixture.start();
  assert.equal(fixture.controller.isDragging(), true);
  assert.equal(fixture.row.classList.contains("is-dragging"), true);
  assert.equal(fixture.body.classList.contains("tree-dragging"), true);
  assert.equal(fixture.body.classList.contains("tree-dragging-group"), false);
  assert.deepEqual(transfer.types, [TREE_DRAG_TYPE]);
  assert.match(transfer.getData(TREE_DRAG_TYPE), /^[0-9a-f-]{36}$/u);
  const over = await fire("dragover", fixture.target, transfer);
  assert.equal(over.defaultPrevented, true); assert.equal(transfer.dropEffect, "move");
  assert.equal(fixture.target.classList.contains("is-drop-target"), true);
  await fire("drop", fixture.target, transfer);
  assert.deepEqual(fixture.calls, [[{ libraryId: "library-example", type: "moveLink", linkId: "work-link", targetGroupId: "personal" }, 7]]);
  assert.equal(fixture.controller.isDragging(), false);
  assert.equal(fixture.row.classList.contains("is-dragging"), false);
  assert.equal(fixture.target.classList.contains("is-drop-target"), false);
  assert.equal(fixture.body.classList.contains("tree-dragging"), false);
  assert.equal(fixture.ends, 1);
});

test("group fold button itself is draggable but its descendant controls are not", async () => {
  const fixture = controllerFixture();
  const fold = new Element("button"), label = new Element("span"); fold.append(label); fixture.body.append(fold);
  fixture.controller.bindSource(fold, { kind: "group", id: "child" });
  const { transfer, result } = await fixture.start(label);
  assert.equal(result.defaultPrevented, false);
  assert.equal(fixture.body.classList.contains("tree-dragging-group"), true);
  await fire("drop", fixture.root, transfer);
  assert.equal(fixture.calls[0][0].targetParentGroupId, null);
  const excluded = await fixture.start(fixture.menu);
  assert.equal(excluded.result.defaultPrevented, true);
  assert.equal(fixture.controller.isDragging(), false);
});

test("external URL, foreign session and substituted payloads cannot move records", async () => {
  const fixture = controllerFixture();
  for (const transfer of [new Transfer({ "text/uri-list": "https://example.com/external" }), new Transfer({ [TREE_DRAG_TYPE]: "foreign-token" })]) {
    await fire("dragover", fixture.target, transfer);
    await fire("drop", fixture.target, transfer);
    assert.equal(transfer.dropEffect, "none");
  }
  const { transfer } = await fixture.start(); transfer.setData(TREE_DRAG_TYPE, "substituted-token");
  await fire("drop", fixture.target, transfer);
  assert.equal(fixture.calls.length, 0);
  await fire("dragend", fixture.row, transfer);
  assert.equal(fixture.controller.isDragging(), false);
});

test("nearest invalid child target never falls through to a valid parent target", async () => {
  const fixture = controllerFixture(), invalid = new Element(); fixture.target.append(invalid);
  fixture.controller.bindTarget(invalid, { groupId: "work" });
  const { transfer } = await fixture.start();
  const over = await fire("dragover", invalid, transfer);
  assert.equal(over.stopped, true); assert.equal(transfer.dropEffect, "none");
  assert.equal(fixture.target.classList.contains("is-drop-target"), false);
  await fire("drop", invalid, transfer);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.announcements[0][1], false);
});

test("drop rechecks revision, library and busy state after a valid hover", async () => {
  for (const patch of [{ catalogRevision: 8 }, { libraryId: "other", library: { ...contextFixture().library, id: "other" } }, { busy: true }]) {
    const fixture = controllerFixture(); const { transfer } = await fixture.start();
    await fire("dragover", fixture.target, transfer);
    fixture.setContext({ ...fixture.context, ...patch });
    await fire("drop", fixture.target, transfer);
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.controller.isDragging(), false);
    assert.equal(fixture.announcements[0][1], true);
  }
});

test("dragend, Escape, reset and destruction clear drag markers without moving data", async () => {
  for (const operation of ["dragend", "Escape", "reset", "destroy"]) {
    const fixture = controllerFixture(), { transfer } = await fixture.start();
    await fire("dragover", fixture.target, transfer);
    if (operation === "Escape") await fire("keydown", fixture.row, transfer, { key: "Escape" });
    else if (operation === "dragend") await fire("dragend", fixture.row, transfer);
    else fixture.controller[operation]();
    assert.equal(fixture.controller.isDragging(), false);
    assert.equal(fixture.body.classList.contains("tree-dragging"), false);
    assert.equal(fixture.target.classList.contains("is-drop-target"), false);
    assert.equal(fixture.calls.length, 0);
  }
});

test("post-drag pointer click cannot open a link; keyboard activation still works", async () => {
  const fixture = controllerFixture(); let opened = 0;
  fixture.anchor.addEventListener("click", () => { opened += 1; });
  const { transfer } = await fixture.start();
  await fire("dragend", fixture.row, transfer);
  const keyboard = await fire("click", fixture.anchor, transfer, { detail: 0 });
  assert.equal(keyboard.defaultPrevented, false); assert.equal(opened, 1);
  const pointer = await fire("click", fixture.anchor, transfer);
  assert.equal(pointer.defaultPrevented, true); assert.equal(opened, 1);
  await fire("click", fixture.anchor, transfer);
  assert.equal(opened, 2);
});

test("post-drag click suppression survives a synchronous tree re-render", async () => {
  const fixture = controllerFixture(), { transfer } = await fixture.start();
  await fire("dragend", fixture.row, transfer);
  const replacement = new Element(), anchor = new Element("a");
  replacement.dataset.linkId = "work-link"; replacement.append(anchor); fixture.body.append(replacement);
  let opened = false; anchor.addEventListener("click", () => { opened = true; });
  const click = await fire("click", anchor, transfer);
  assert.equal(click.defaultPrevented, true); assert.equal(opened, false);
});

test("a fresh pointer gesture immediately after a drag activates links and menus on its first click", async t => {
  t.mock.method(Date, "now", () => 1000);
  for (const targetName of ["anchor", "menu"]) {
    await t.test(targetName, async () => {
      const fixture = controllerFixture(), { transfer } = await fixture.start();
      await fire("dragend", fixture.row, transfer);
      let activated = 0;
      const target = targetName === "menu" ? new Element("span") : fixture.anchor;
      if (targetName === "menu") fixture.menu.append(target);
      target.addEventListener("click", () => { activated += 1; });
      target.addEventListener("pointerdown", event => { event.stopPropagation(); });
      await fire("pointerdown", target);
      await fire("pointerup", target);
      const click = await fire("click", target);
      assert.equal(click.defaultPrevented, false, "a new gesture is not a trailing click from the drag");
      assert.equal(activated, 1);
    });
  }
});

test("a fresh pointer gesture after a move activates a replacement row's first click", async t => {
  t.mock.method(Date, "now", () => 1000);
  const fixture = controllerFixture(), { transfer } = await fixture.start();
  await fire("drop", fixture.target, transfer);
  const replacement = new Element(), anchor = new Element("a");
  replacement.dataset.linkId = "work-link"; replacement.append(anchor); fixture.body.append(replacement);
  let opened = 0; anchor.addEventListener("click", () => { opened += 1; });
  await fire("pointerdown", anchor);
  await fire("pointerup", anchor);
  const click = await fire("click", anchor);
  assert.equal(click.defaultPrevented, false);
  assert.equal(opened, 1);
});

test("a fresh pointer gesture immediately after group drag toggles its fold button", async t => {
  t.mock.method(Date, "now", () => 1000);
  const fixture = controllerFixture(), fold = new Element("button");
  fixture.body.append(fold);
  fixture.controller.bindSource(fold, { kind: "group", id: "child" });
  const { transfer } = await fixture.start(fold);
  await fire("dragend", fold, transfer);
  let toggled = 0; fold.addEventListener("click", () => { toggled += 1; });
  await fire("pointerdown", fold);
  await fire("pointerup", fold);
  const click = await fire("click", fold);
  assert.equal(click.defaultPrevented, false);
  assert.equal(toggled, 1);
});

test("each later drag still suppresses its own trailing click after a fresh gesture", async t => {
  t.mock.method(Date, "now", () => 1000);
  const fixture = controllerFixture();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { transfer } = await fixture.start();
    await fire("dragend", fixture.row, transfer);
    assert.equal((await fire("click", fixture.anchor)).defaultPrevented, true);
    await fire("pointerdown", fixture.anchor);
    assert.equal((await fire("click", fixture.anchor)).defaultPrevented, false);
  }
});

test("destroy removes the document gesture listener as well as click suppression", () => {
  const fixture = controllerFixture();
  assert.equal(fixture.document.listeners.get("pointerdown").length, 1);
  fixture.controller.destroy();
  for (const type of ["pointerdown", "click", "keydown", "dragend"]) {
    assert.equal(fixture.document.listeners.get(type).length, 0, `${type} listener must be removed`);
  }
});

test("leaving a target child retains highlight; leaving its boundary clears it", async () => {
  const fixture = controllerFixture(), child = new Element(); fixture.target.append(child);
  const { transfer } = await fixture.start(); await fire("dragover", child, transfer);
  await fire("dragleave", child, transfer, { relatedTarget: fixture.target });
  assert.equal(fixture.target.classList.contains("is-drop-target"), true);
  await fire("dragleave", fixture.target, transfer, { relatedTarget: fixture.body });
  assert.equal(fixture.target.classList.contains("is-drop-target"), false);
});

test("a pending move prevents duplicate drops or another drag", async () => {
  let release;
  const calls = [], pending = new Promise(resolve => { release = resolve; });
  const fixture = controllerFixture(async (...args) => { calls.push(args); await pending; });
  const { transfer } = await fixture.start();
  const dropped = fire("drop", fixture.target, transfer);
  await Promise.resolve();
  await fire("drop", fixture.target, transfer);
  assert.equal((await fixture.start()).result.defaultPrevented, true);
  release(); await dropped;
  assert.equal(calls.length, 1);
});

test("move rejection clears state and reports failure without an unhandled rejection", async () => {
  const fixture = controllerFixture(async () => { throw new Error("저장 실패"); });
  const { transfer } = await fixture.start(); await fire("drop", fixture.target, transfer);
  assert.deepEqual(fixture.announcements, [["저장 실패", true]]);
  assert.equal(fixture.controller.isDragging(), false);
  assert.equal(fixture.ends, 1);
});

test("protected, absent, busy and destroyed sources cannot start a drag", async () => {
  const fixture = controllerFixture(), protectedRow = new Element(), absent = new Element();
  fixture.body.append(protectedRow, absent);
  fixture.controller.bindSource(protectedRow, { kind: "group", id: SYSTEM_GROUP_ID });
  assert.equal(protectedRow.draggable, false);
  fixture.controller.bindSource(absent, { kind: "group", id: "missing" });
  assert.equal((await fixture.start(absent)).result.defaultPrevented, true);
  fixture.setContext({ ...fixture.context, busy: true });
  assert.equal((await fixture.start()).result.defaultPrevented, true);
  fixture.setContext({ ...fixture.context, busy: false }); fixture.controller.destroy();
  assert.equal((await fixture.start()).result.defaultPrevented, true);
});
