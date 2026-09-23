import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

await import("../src/moa-brand.js");
await import("../src/notion-tree-panel.js");

const { createPanelShell } = globalThis.NotionFavoriteSections.panel;

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    event.type = type;
    event.target ||= this;
    event.stopPropagation ||= () => {};
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener.call(this, event);
    }
  }
}

class FakeStyle {
  constructor() {
    this.display = "";
    this.values = new Map();
  }

  setProperty(name, value) {
    this.values.set(name, String(value));
  }

  getPropertyValue(name) {
    return this.values.get(name) || "";
  }
}

class FakeElement extends FakeEventTarget {
  constructor(tagName, ownerDocument, namespaceURI = null) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.shadowRoot = null;
    this.style = new FakeStyle();
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.inert = false;
    this.isConnected = true;
    this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parentElement) {
        node.parentElement.children = node.parentElement.children.filter(
          (child) => child !== node
        );
      }
      node.parentElement = this;
      this.children.push(node);
    }
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this
      );
    }
    this.parentElement = null;
    this.isConnected = false;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }

  attachShadow() {
    if (!this.shadowRoot) {
      this.shadowRoot = new FakeShadowRoot(this.ownerDocument, this);
    }
    return this.shadowRoot;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  matches(selector) {
    if (/^[a-z]+$/iu.test(selector)) {
      return this.tagName === selector.toUpperCase();
    }
    const match = selector.match(
      /^(?:([a-z]+))?\[([^=\]]+)(?:="([^"]*)")?\]$/iu
    );
    if (!match) return false;
    const [, tagName, attribute, expected] = match;
    if (tagName && this.tagName !== tagName.toUpperCase()) return false;
    if (!this.attributes.has(attribute)) return false;
    return expected === undefined || this.getAttribute(attribute) === expected;
  }

  contains(node) {
    if (node === this) return true;
    if (this.shadowRoot?.contains(node)) return true;
    return this.children.some((child) => child.contains?.(node));
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches?.(selector)) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    for (const child of this.children) {
      if (child.matches?.(selector)) results.push(child);
      results.push(...(child.querySelectorAll?.(selector) || []));
    }
    return results;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  focus() {
    let parent = this.parentElement;
    while (parent) {
      if (parent instanceof FakeShadowRoot) {
        parent.activeElement = this;
        this.ownerDocument.activeElement = parent.host;
        return;
      }
      parent = parent.parentElement;
    }
    this.ownerDocument.activeElement = this;
  }
}

class FakeShadowRoot extends FakeElement {
  constructor(ownerDocument, host) {
    super("shadow-root", ownerDocument);
    this.host = host;
    this.activeElement = null;
  }
}

class FakeWindow extends FakeEventTarget {
  constructor() {
    super();
    this.innerWidth = 900;
    this.innerHeight = 700;
  }

  getComputedStyle(node) {
    return {
      backgroundColor:
        node.style.backgroundColor ||
        (node.tagName === "NAV" ? "rgb(249, 248, 247)" : "rgba(0, 0, 0, 0)"),
      color: node.style.color || "rgb(55, 53, 47)",
      display: node.hidden ? "none" : node.style.display || "block"
    };
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.defaultView = new FakeWindow();
    this.documentElement = { clientWidth: 900, clientHeight: 700 };
    this.activeElement = null;
    this.body = new FakeElement("body", this);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createElementNS(namespaceURI, tagName) {
    return new FakeElement(tagName, this, namespaceURI);
  }
}

function createFixture() {
  const documentRef = new FakeDocument();
  const nav = documentRef.createElement("nav");
  nav.setAttribute("aria-label", "사이드바");
  const tablist = documentRef.createElement("div");
  tablist.setAttribute("role", "tablist");
  tablist.rect = {
    left: 8,
    top: 20,
    right: 328,
    bottom: 52,
    width: 320,
    height: 32
  };
  const nativeTab = documentRef.createElement("button");
  nativeTab.setAttribute("role", "tab");
  nativeTab.setAttribute("aria-selected", "true");
  const host = documentRef.createElement("div");
  const contentSurface = documentRef.createElement("div");
  contentSurface.style.position = "relative";
  const nativePanel = documentRef.createElement("section");
  nativePanel.setAttribute("role", "tabpanel");
  nativePanel.rect = {
    left: 0,
    top: 60,
    right: 336,
    bottom: 700,
    width: 336,
    height: 640
  };
  const viewHost = documentRef.createElement("div");
  tablist.append(nativeTab, host);
  contentSurface.append(nativePanel, viewHost);
  nav.append(tablist, contentSurface);
  documentRef.body.append(nav);
  return {
    documentRef,
    nav,
    tablist,
    nativeTab,
    contentSurface,
    nativePanel,
    viewHost,
    host
  };
}

test("classic content script publishes the panel shell API", () => {
  assert.equal(typeof createPanelShell, "function");
  assert.equal(Object.isFrozen(globalThis.NotionFavoriteSections.panel), true);
});

test("FAVMOA menu button presents the decorative approved bookmark before its text label", () => {
  const { viewHost, host } = createFixture();
  const shell = createPanelShell({ host, viewHost });
  const trigger = shell.shadowRoot.querySelector('[aria-label="FAVMOA"]');
  const [icon, label] = trigger.children;

  assert.equal(icon.tagName, "SVG");
  assert.equal(icon.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(icon.getAttribute("class"), "ntree-trigger-icon");
  assert.equal(icon.getAttribute("aria-hidden"), "true");
  assert.equal(icon.getAttribute("focusable"), "false");
  assert.equal(icon.getAttribute("width"), "16");
  assert.equal(icon.getAttribute("height"), "16");
  assert.equal(icon.getAttribute("viewBox"), "0 0 32 32");
  assert.equal(icon.querySelectorAll("path").length, 3);
  assert.deepEqual(icon.querySelectorAll("path").map(path => path.getAttribute("d")),
    globalThis.NotionFavoriteSections.brand.shapes.map(shape => shape.d));
  assert.equal(icon.querySelector("path").getAttribute("fill"), "var(--moa-ink, #164C45)");
  assert.equal(label.tagName, "SPAN");
  assert.equal(label.className, "ntree-trigger-label");
  assert.equal(label.textContent, "FAVMOA");

  const style = shell.shadowRoot.children.find(
    (child) => child.tagName === "STYLE"
  );
  assert.match(
    style.textContent,
    /\.ntree-trigger-icon\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*flex:\s*0 0 auto;/su
  );
  shell.destroy();
});

test("hidden internal view host has an explicit Shadow DOM display override", () => {
  const { viewHost, host } = createFixture();
  const shell = createPanelShell({ host, viewHost });
  const style = shell.panelShadowRoot.children.find(
    (child) => child.tagName === "STYLE"
  );

  assert.match(
    style.textContent,
    /:host\(\[hidden\]\)\s*\{\s*display:\s*none\s*!important;\s*\}/u
  );
  shell.destroy();
});

test("a crowded navigation keeps an accessible icon trigger and restores its label when wider", () => {
  const { documentRef, tablist, nativeTab, viewHost, host } = createFixture();
  tablist.rect.width = 220;
  nativeTab.rect.width = 180;
  const shell = createPanelShell({ host, viewHost });
  const trigger = shell.shadowRoot.querySelector('[aria-label="FAVMOA"]');
  assert.equal(trigger.hasAttribute("data-compact"), true);
  assert.equal(trigger.getAttribute("title"), "FAVMOA · 즐겨찾기 정리");
  assert.equal(nativeTab.getAttribute("aria-selected"), "true");
  tablist.rect.width = 330;
  documentRef.defaultView.dispatch("resize");
  assert.equal(trigger.hasAttribute("data-compact"), false);
  shell.destroy();
});

test("compressed native tabs do not make a four-tab narrow bar appear roomy", () => {
  const { documentRef, tablist, nativeTab, viewHost, host } = createFixture();
  tablist.rect.width = 240;
  nativeTab.rect.width = 30;
  for (let index = 0; index < 3; index += 1) {
    const native = documentRef.createElement("button");
    native.setAttribute("role", "tab");
    native.rect.width = 30;
    tablist.append(native);
  }
  const shell = createPanelShell({ host, viewHost });
  assert.equal(shell.shadowRoot.querySelector('[aria-label="FAVMOA"]').hasAttribute("data-compact"), true);
  shell.destroy();
});

test("sidebar theme changes propagate to an opaque panel and native form color scheme", () => {
  const { documentRef, nav, viewHost, host } = createFixture();
  let themeChanged;
  let disconnected = false;
  documentRef.defaultView.MutationObserver = class {
    constructor(callback) { themeChanged = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  nav.style.backgroundColor = "rgb(32, 32, 32)";
  nav.style.color = "rgb(242, 242, 242)";
  const shell = createPanelShell({ host, viewHost });
  shell.open();
  assert.equal(viewHost.style.backgroundColor, "rgb(32, 32, 32)");
  assert.equal(viewHost.style.color, "rgb(242, 242, 242)");
  assert.equal(viewHost.style.colorScheme, "dark");
  assert.equal(viewHost.style.getPropertyValue("--ntree-surface"), "rgb(32, 32, 32)");
  assert.equal(host.style.getPropertyValue("--moa-ink"), "#A3D9C5");
  assert.equal(viewHost.style.getPropertyValue("--moa-mint"), "#164C45");

  documentRef.body.style.backgroundColor = "rgb(255, 255, 255)";
  nav.style.backgroundColor = "rgba(240, 240, 240, 0.5)";
  nav.style.color = "rgb(55, 53, 47)";
  themeChanged();
  assert.equal(viewHost.style.backgroundColor, "rgb(248, 248, 248)");
  assert.equal(viewHost.style.colorScheme, "light");
  assert.equal(host.style.getPropertyValue("--moa-ink"), "#164C45");
  assert.equal(viewHost.style.getPropertyValue("--moa-mint"), "#A3D9C5");
  assert.equal(viewHost.style.color, "rgb(55, 53, 47)");
  assert.equal(viewHost.hidden, false);
  shell.destroy();
  assert.equal(disconnected, true);
});

test("panel shell exposes an opaque internal surface as a named region", () => {
  const {
    documentRef,
    nativeTab,
    contentSurface,
    nativePanel,
    viewHost,
    host
  } = createFixture();
  const changes = [];
  const shell = createPanelShell({
    host,
    viewHost,
    nativeTab,
    onOpenChange(open) {
      changes.push(open);
    }
  });
  const trigger = shell.shadowRoot.querySelector('[aria-label="FAVMOA"]');
  const panel = shell.panelShadowRoot.querySelector('[role="region"]');
  const title = shell.panelShadowRoot.querySelector(
    `[id="${panel.getAttribute("aria-labelledby")}"]`
  );
  const closeButton = shell.panelShadowRoot.querySelector(
    '[aria-label="FAVMOA 패널 닫기"]'
  );

  assert.equal(host.style.display, "contents");
  assert.equal(shell.overlayHost, viewHost);
  assert.equal(viewHost.parentElement, contentSurface);
  assert.equal(shell.overlayHost.hidden, true);
  assert.equal(shell.overlayHost.style.isolation, "isolate");
  assert.equal(trigger.tagName, "BUTTON");
  assert.equal(trigger.getAttribute("role"), null);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.getAttribute("aria-selected"), null);
  assert.equal(trigger.getAttribute("aria-controls"), null);
  assert.equal(panel.getAttribute("aria-labelledby"), title.getAttribute("id"));
  assert.equal(title.textContent, "FAVMOA");
  assert.equal(panel.hidden, true);
  assert.equal(shell.contentHost.parentElement.parentElement, panel);
  assert.doesNotThrow(() => shell.contentHost.attachShadow({ mode: "open" }));

  trigger.dispatch("click", {
    composedPath: () => [trigger, host, documentRef]
  });
  assert.equal(panel.hidden, false);
  assert.equal(shell.overlayHost.hidden, false);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("aria-selected"), null);
  assert.equal(shell.overlayHost.style.position, "absolute");
  assert.equal(shell.overlayHost.style.inset, "0px");
  assert.equal(shell.overlayHost.style.backgroundColor, "rgb(249, 248, 247)");
  assert.equal(nativePanel.inert, false);
  assert.equal(nativePanel.hasAttribute("aria-hidden"), false);
  assert.equal(nativeTab.getAttribute("aria-selected"), "true");
  assert.deepEqual(changes, [true]);

  closeButton.dispatch("click");
  assert.equal(panel.hidden, true);
  assert.equal(shell.overlayHost.hidden, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.getAttribute("aria-selected"), null);
  assert.equal(shell.shadowRoot.activeElement, trigger);
  assert.equal(nativePanel.inert, false);
  assert.equal(nativePanel.hasAttribute("aria-hidden"), false);
  assert.equal(nativeTab.getAttribute("aria-selected"), "true");
  assert.deepEqual(changes, [true, false]);

  assert.equal(shell.destroy(), true);
  assert.equal(shell.shadowRoot.children.length, 0);
  assert.equal(shell.overlayHost.isConnected, false);
  assert.equal(shell.destroy(), false);
});

test("Escape and outside pointer close without providing another opener", () => {
  const { documentRef, nativeTab, viewHost, host } = createFixture();
  const shell = createPanelShell({ host, viewHost, nativeTab });
  const panel = shell.panelShadowRoot.querySelector('[role="region"]');

  assert.equal(shell.open(), true);
  let prevented = false;
  panel.dispatch("keydown", {
    key: "Escape",
    preventDefault() {
      prevented = true;
    }
  });
  assert.equal(prevented, true);
  assert.equal(panel.hidden, true);

  assert.equal(shell.update({ open: true }), true);
  documentRef.dispatch("pointerdown", {
    target: shell.overlayHost,
    composedPath: () => [shell.overlayHost, documentRef]
  });
  assert.equal(panel.hidden, false);
  const outside = documentRef.createElement("main");
  documentRef.dispatch("pointerdown", {
    target: outside,
    composedPath: () => [outside, documentRef]
  });
  assert.equal(panel.hidden, true);
  assert.equal(shell.toggle(), true);
  assert.equal(shell.close({ restoreFocus: false }), true);
  assert.throws(() => shell.update({ open: "yes" }), /boolean/u);
  shell.destroy();
});

test("Escape already consumed by a picker or inline form leaves FAVMOA open", () => {
  const { documentRef, viewHost, host } = createFixture();
  const shell = createPanelShell({ host, viewHost });
  const panel = shell.panelShadowRoot.querySelector('[role="region"]');
  assert.equal(shell.open(), true);
  let prevented = false;
  panel.dispatch("keydown", {
    key: "Escape",
    defaultPrevented: true,
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, false);
  assert.equal(panel.hidden, false);
  shell.destroy();
});

test("Escape outside FAVMOA does not intercept the rest of Notion", () => {
  const { documentRef, viewHost, host } = createFixture();
  const shell = createPanelShell({ host, viewHost });
  const panel = shell.panelShadowRoot.querySelector('[role="region"]');
  assert.equal(shell.open(), true);
  let prevented = false;
  documentRef.dispatch("keydown", {
    key: "Escape",
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, false);
  assert.equal(panel.hidden, false);
  shell.destroy();
});

test("Escape closes the focused details menu before the FAVMOA panel", () => {
  const { documentRef, viewHost, host } = createFixture();
  const shell = createPanelShell({ host, viewHost });
  const panel = shell.panelShadowRoot.querySelector('[role="region"]');
  const viewShadow = shell.contentHost.attachShadow({ mode: "open" });
  const details = documentRef.createElement("details");
  details.open = true;
  details.setAttribute("open", "");
  const summary = documentRef.createElement("summary");
  const menuAction = documentRef.createElement("button");
  details.append(summary, menuAction);
  viewShadow.append(details);

  assert.equal(shell.open(), true);
  menuAction.focus();
  let prevented = false;
  panel.dispatch("keydown", {
    key: "Escape",
    target: menuAction,
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, true);
  assert.equal(panel.hidden, false);
  assert.equal(details.open, false);
  assert.equal(details.hasAttribute("open"), false);
  assert.equal(viewShadow.activeElement, summary);
  shell.destroy();
});

test("Tab remains native within a nonmodal region and destroy removes listeners", () => {
  const { documentRef, nativeTab, viewHost, host } = createFixture();
  const shell = createPanelShell({ host, viewHost, nativeTab });
  const viewShadow = shell.contentHost.attachShadow({ mode: "open" });
  const panel = shell.panelShadowRoot.querySelector('[role="region"]');
  const firstAction = documentRef.createElement("button");
  const lastAction = documentRef.createElement("button");
  viewShadow.append(firstAction, lastAction);

  assert.equal(shell.open(), true);
  lastAction.focus();
  let prevented = false;
  panel.dispatch("keydown", {
    key: "Tab",
    preventDefault() {
      prevented = true;
    }
  });
  assert.equal(prevented, false);
  assert.equal(viewShadow.activeElement, lastAction);

  assert.equal(shell.destroy(), true);
  for (const eventName of ["pointerdown", "keydown", "focusin"]) {
    assert.equal(documentRef.listeners.get(eventName)?.size || 0, 0);
  }
  assert.equal(nativeTab.getAttribute("aria-selected"), "true");
});

test("keyboard focus leaving FAVMOA closes the surface without stealing focus", () => {
  const { documentRef, nativeTab, viewHost, host } = createFixture();
  const shell = createPanelShell({ host, viewHost });
  const panel = shell.panelShadowRoot.querySelector('[role="region"]');

  assert.equal(shell.open(), true);
  nativeTab.focus();
  documentRef.dispatch("focusin", {
    target: nativeTab,
    composedPath: () => [nativeTab, documentRef]
  });
  assert.equal(panel.hidden, true);
  assert.equal(documentRef.activeElement, nativeTab);

  shell.destroy();
});

test("pointer navigation outside FAVMOA does not restore focus to its trigger", () => {
  const { documentRef, viewHost, host } = createFixture();
  const shell = createPanelShell({ host, viewHost });
  const outside = documentRef.createElement("button");
  documentRef.body.append(outside);

  assert.equal(shell.open(), true);
  outside.focus();
  documentRef.dispatch("pointerdown", {
    target: outside,
    composedPath: () => [outside, documentRef]
  });
  assert.equal(viewHost.hidden, true);
  assert.equal(documentRef.activeElement, outside);

  shell.destroy();
});

test("panel runtime avoids remote I/O and unsafe execution primitives", async () => {
  const source = await readFile(
    new URL("../src/notion-tree-panel.js", import.meta.url),
    "utf8"
  );

  assert.match(source, /^\(function initializeNotionTreePanel/u);
  assert.match(source, /\}\)\(globalThis\);\s*$/u);
  for (const forbidden of [
    /\.innerHTML\s*=/u,
    /\beval\s*\(/u,
    /\bnew\s+Function\b/u,
    /\bfetch\s*\(/u,
    /\bXMLHttpRequest\b/u,
    /\bWebSocket\b/u,
    /document\.cookie/u
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});
