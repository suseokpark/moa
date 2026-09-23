import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { flattenGroups, identifyUrl, MAX_GROUP_DEPTH, SYSTEM_GROUP_ID } from "../src/link-library.js";
import { findSavedPage } from "../src/link-navigation.js";

const script = await readFile(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");

// This fixture exercises the shipped refresh/render chain. It proves whether
// an event between pointer-down and pointer-up replaces the clicked DOM node;
// browser pointer dispatch and Chrome focus behavior need a separate UI check.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
    this.attributes = {}; this.value = ""; this.className = ""; this.ownText = ""; this.replacements = 0;
    this.style = { setProperty(name, value) { this[name] = value; } };
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.replacements += 1; this.ownText = ""; this.children = children; }
  addEventListener() {}
}
const descendants = element => [element, ...element.children.flatMap(descendants)];

function fixture() {
  const elements = new Map();
  const document = {
    createElement: tag => new Element(tag),
    querySelectorAll: () => [],
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element("div"));
      return elements.get(id);
    }
  };
  const snapshots = {
    page: { id: 1, title: "Current page", url: "https://example.com/current", active: true },
    tabs: [{ id: 1, title: "Current page", url: "https://example.com/current", active: true }]
  };
  let pageLoader = () => ({ ...snapshots.page });
  let tabsLoader = () => snapshots.tabs.map(tab => ({ ...tab }));
  let interactionActive = false;
  let dragging = false;
  const context = vm.createContext({
    document, window: {}, identifyUrl, findSavedPage, SYSTEM_GROUP_ID, flattenGroups, MAX_GROUP_DEPTH,
    createInteractionGuard: () => ({ isActive: () => interactionActive }),
    createPlatform: () => ({
      getCurrentPage: async () => pageLoader(),
      getOpenTabs: async () => tabsLoader()
    }),
    createTreeDrag: () => ({ bindSource() {}, bindTarget() {}, reset() {}, isDragging: () => dragging })
  });
  const boundary = script.indexOf('$("dialog-form").addEventListener("submit"');
  assert.ok(boundary > 0, "review sidepanel fixture initialization boundary");
  vm.runInContext(script.slice(0, boundary).replace(/^import .+;\n/gmu, ""), context);
  vm.runInContext(`
    state = { revision: 1, catalog: { libraries: [{ id: "library-demo", name: "Demo", groups: [{
      id: "group-demo", name: "Links", collapsed: false, groups: [], links: [
        { id: "link-current", title: "Current page", url: "https://example.com/current" },
        { id: "link-next", title: "Next page", url: "https://example.com/next" }
      ]
    }] }] }, canUndo: false, hasRestorePoint: false };
    libraryId = "library-demo";
    render();
  `, context);
  return {
    snapshots, elements,
    setLoaders(page, tabs) { pageLoader = page; tabsLoader = tabs; },
    press() { interactionActive = true; },
    release() { interactionActive = false; return vm.runInContext("flushPendingUI()", context); },
    startDrag() { dragging = true; },
    finishDrag() { dragging = false; return vm.runInContext("flushPendingUI()", context); },
    runEffect(effect) {
      context.testTreeEffect = effect;
      try { return vm.runInContext("runAfterTreeRender(testTreeEffect)", context); }
      finally { delete context.testTreeEffect; }
    },
    adoptTitle(revision, title) {
      const catalog = structuredClone(vm.runInContext("state.catalog", context));
      catalog.libraries[0].groups[0].links[1].title = title;
      context.testCatalogUpdate = { revision, catalog };
      vm.runInContext("adopt(testCatalogUpdate)", context);
      delete context.testCatalogUpdate;
    },
    refresh: () => vm.runInContext("refreshTabs()", context),
    anchors: () => descendants(elements.get("tree")).filter(element => element.tagName === "A")
  };
}

test("focus refresh with unchanged tab state preserves the pressed link DOM node", async () => {
  const view = fixture();
  await view.refresh();
  const pointerDownTarget = view.anchors()[1];
  // Focus, visibility and tabs-changed all use this same refresh function.
  await view.refresh();
  assert.equal(view.anchors()[1], pointerDownTarget,
    "an unchanged focus refresh must not remove the link between pointer-down and pointer-up");
});

test("refresh still updates current and open semantics after the active URL changes", async () => {
  const view = fixture();
  await view.refresh();
  assert.equal(view.anchors()[0].getAttribute("aria-current"), "page");
  view.snapshots.page = { id: 2, title: "Next page", url: "https://example.com/next", active: true };
  view.snapshots.tabs = [view.snapshots.page];
  await view.refresh();
  assert.equal(view.anchors()[0].getAttribute("aria-current"), undefined);
  assert.equal(view.anchors()[1].getAttribute("aria-current"), "page");
  assert.match(view.elements.get("current-page").textContent, /Next page/u);
});

test("title-only tab refresh updates the current page card without replacing tree links", async () => {
  const view = fixture();
  await view.refresh();
  const pointerDownTarget = view.anchors()[1];
  view.snapshots.page.title = "Current page loaded";
  view.snapshots.tabs[0].title = "Current page loaded";
  await view.refresh();
  assert.match(view.elements.get("current-page").textContent, /Current page loaded/u);
  assert.equal(view.anchors()[1], pointerDownTarget,
    "tab title changes do not change saved link labels and must not remove a pressed link");
});

test("equivalent open-tab URLs preserve links despite tab ordering, duplicates and metadata changes", async () => {
  const view = fixture();
  view.snapshots.tabs.push({ id: 2, title: "Next page", url: "https://example.com/next", active: false });
  await view.refresh();
  const before = view.anchors();
  view.snapshots.tabs = [
    { id: 22, title: "Next page loaded", url: "https://example.com/next", active: false },
    { ...view.snapshots.page, id: 3 },
    { ...view.snapshots.page, id: 4 }
  ];
  await view.refresh();
  assert.equal(view.anchors()[0], before[0]);
  assert.equal(view.anchors()[1], before[1],
    "only the set of open URL keys affects tree badges, not tab metadata or ordering");
});

test("a newly opened background URL updates its saved link badge", async () => {
  const view = fixture();
  await view.refresh();
  assert.doesNotMatch(view.anchors()[1].textContent, /열림/u);
  view.snapshots.tabs.push({ id: 2, title: "Next page", url: "https://example.com/next", active: false });
  await view.refresh();
  assert.match(view.anchors()[1].textContent, /열림/u);
  assert.equal(view.anchors()[0].getAttribute("aria-current"), "page");
});

test("an older in-flight tab response cannot replace the latest page or tree", async () => {
  const view = fixture();
  await view.refresh();
  let resolveOldPage, resolveOldTabs;
  const oldPage = new Promise(resolve => { resolveOldPage = resolve; });
  const oldTabs = new Promise(resolve => { resolveOldTabs = resolve; });
  view.setLoaders(() => oldPage, () => oldTabs);
  const oldRefresh = view.refresh();
  const next = { id: 2, title: "Next page", url: "https://example.com/next", active: true };
  view.setLoaders(() => ({ ...next }), () => [{ ...next }]);
  await view.refresh();
  const latestAnchor = view.anchors()[1];
  resolveOldPage(view.snapshots.page);
  resolveOldTabs(view.snapshots.tabs);
  await oldRefresh;
  assert.equal(view.anchors()[1], latestAnchor);
  assert.equal(latestAnchor.getAttribute("aria-current"), "page");
  assert.match(view.elements.get("current-page").textContent, /Next page/u);
});

test("a meaningful tab change during a pointer sequence waits until the click target is released", async () => {
  const view = fixture();
  await view.refresh();
  const pressedAnchor = view.anchors()[1];
  const initialTreeRenders = view.elements.get("tree").replacements;
  view.press();
  view.snapshots.page = { id: 2, title: "Next page", url: "https://example.com/next", active: true };
  view.snapshots.tabs = [view.snapshots.page];
  await view.refresh();
  assert.equal(view.anchors()[1], pressedAnchor, "refresh must leave the pressed anchor connected");
  assert.match(view.elements.get("current-page").textContent, /Current page/u,
    "the current-page action must also stay stable until its pointer sequence finishes");
  view.release();
  assert.equal(view.anchors()[1].getAttribute("aria-current"), "page");
  assert.match(view.elements.get("current-page").textContent, /Next page/u);
  assert.equal(view.elements.get("tree").replacements, initialTreeRenders + 1);
});

test("multiple tab updates while pressed apply only the latest pending snapshot once", async () => {
  const view = fixture();
  await view.refresh();
  const pressedAnchor = view.anchors()[1];
  const initialTreeRenders = view.elements.get("tree").replacements;
  view.press();
  view.snapshots.page = { id: 2, title: "Next page loading", url: "https://example.com/next", active: true };
  view.snapshots.tabs = [view.snapshots.page];
  await view.refresh();
  view.snapshots.page = { ...view.snapshots.page, title: "Next page loaded" };
  view.snapshots.tabs = [view.snapshots.page];
  await view.refresh();
  assert.equal(view.anchors()[1], pressedAnchor);
  view.release();
  assert.equal(view.anchors()[1].getAttribute("aria-current"), "page");
  assert.match(view.elements.get("current-page").textContent, /Next page loaded/u);
  assert.equal(view.elements.get("tree").replacements, initialTreeRenders + 1,
    "release must not replay intermediate tab renders");
});

test("catalog updates during a pointer sequence preserve the target and render the latest catalog once", async () => {
  const view = fixture();
  await view.refresh();
  const pressedAnchor = view.anchors()[1];
  const initialTreeRenders = view.elements.get("tree").replacements;
  view.press();
  view.adoptTitle(2, "First external title");
  view.adoptTitle(3, "Latest external title");
  assert.equal(view.anchors()[1], pressedAnchor);
  assert.equal(pressedAnchor.textContent, "Next page");
  view.release();
  assert.equal(view.anchors()[1].textContent, "Latest external title");
  assert.equal(view.elements.get("tree").replacements, initialTreeRenders + 1);
});

test("catalog and tab changes queued together result in one latest-state render", async () => {
  const view = fixture();
  await view.refresh();
  const pressedAnchor = view.anchors()[1];
  const initialTreeRenders = view.elements.get("tree").replacements;
  view.press();
  view.adoptTitle(2, "Latest saved title");
  view.snapshots.page = { id: 2, title: "Next page loaded", url: "https://example.com/next", active: true };
  view.snapshots.tabs = [view.snapshots.page];
  await view.refresh();
  assert.equal(view.anchors()[1], pressedAnchor);
  view.release();
  assert.match(view.anchors()[1].textContent, /Latest saved title.*현재/u);
  assert.equal(view.elements.get("tree").replacements, initialTreeRenders + 1);
});

test("tab refresh waits for native dragging even when no pointer guard is active", async () => {
  const view = fixture();
  await view.refresh();
  const draggedAnchor = view.anchors()[1];
  view.startDrag();
  view.snapshots.page = { id: 2, title: "Next page", url: "https://example.com/next", active: true };
  view.snapshots.tabs = [view.snapshots.page];
  await view.refresh();
  assert.equal(view.anchors()[1], draggedAnchor);
  assert.match(view.elements.get("current-page").textContent, /Current page/u);
  view.finishDrag();
  assert.equal(view.anchors()[1].getAttribute("aria-current"), "page");
});

test("a queued focus effect runs once after the newest deferred tree is available", async () => {
  const view = fixture();
  await view.refresh();
  const pressedAnchor = view.anchors()[1];
  const effectTargets = [];
  view.press();
  view.adoptTitle(2, "First deferred title");
  view.runEffect(() => effectTargets.push(view.anchors()[1]));
  view.adoptTitle(3, "Latest deferred title");
  assert.equal(view.anchors()[1], pressedAnchor);
  assert.equal(effectTargets.length, 0, "focus must not target the obsolete DOM before rendering");
  view.release();
  assert.equal(effectTargets.length, 1);
  assert.equal(effectTargets[0], view.anchors()[1]);
  assert.notEqual(effectTargets[0], pressedAnchor);
  assert.equal(effectTargets[0].textContent, "Latest deferred title");
  view.release();
  await view.refresh();
  assert.equal(effectTargets.length, 1, "completed effects must not replay on later refreshes");
});

test("a focus effect runs immediately when the current tree needs no deferred render", async () => {
  const view = fixture();
  await view.refresh();
  const anchor = view.anchors()[1];
  const initialTreeRenders = view.elements.get("tree").replacements;
  const effectTargets = [];
  view.runEffect(() => effectTargets.push(view.anchors()[1]));
  assert.equal(effectTargets.length, 1);
  assert.equal(effectTargets[0], anchor);
  assert.equal(view.elements.get("tree").replacements, initialTreeRenders);
  view.release();
  assert.equal(effectTargets.length, 1);
});
