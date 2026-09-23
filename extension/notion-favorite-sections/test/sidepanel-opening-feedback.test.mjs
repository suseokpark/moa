import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const script = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../sidepanel/sidepanel.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../sidepanel/sidepanel.css", import.meta.url), "utf8");

// Exercise the shipped renderLink -> openSavedLink -> setLinkOpening chain.
// DOM content/child identity are layout inputs, not a browser pixel measurement.
// Browser QA separately checks that the real row does not jump when clicked.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
    this.attributes = {}; this.className = ""; this.ownText = ""; this.listeners = {};
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name === "href" ? this.href : this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  querySelector(selector) { return this.children.find(child => child.className.split(" ").includes(selector.slice(1))) || null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}

function fixture({ badge = "", immediateResult = null } = {}) {
  const link = { id: "synthetic-link", title: "Example project document", url: "https://example.com/document" };
  let anchor;
  const announcements = [], navigationAnnouncements = [], calls = [], timers = new Map();
  let timerId = 0, resolve, reject;
  const response = immediateResult ? Promise.resolve(immediateResult) : new Promise((yes, no) => { resolve = yes; reject = no; });
  const context = vm.createContext({
    document: {
      createElement: tag => new Element(tag),
      querySelectorAll: () => anchor ? [anchor] : []
    },
    openingUrls: new Set(), openingCounts: new Map(),
    openTabKeys: new Set(badge ? [link.url] : []),
    pageKey: badge === "현재" ? link.url : "", libraryId: "synthetic-library",
    safeKey: value => value,
    uiIcon: () => new Element("span"),
    menu: () => new Element("details"),
    treeDrag: { bindSource() {} },
    platform: { openLink: (...args) => { calls.push(args); return response; } },
    announce: (...args) => announcements.push(args),
    announceNavigation: (...args) => navigationAnnouncements.push(args),
    refreshTabs: async () => {},
    setTimeout: (callback, delay = 0) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  const nodeStart = script.indexOf("function node(");
  const nodeEnd = script.indexOf("\nfunction uiIcon(", nodeStart);
  const start = script.indexOf("function setLinkOpening(");
  const end = script.indexOf("\nfunction renderGroup(", start);
  assert.ok(nodeStart >= 0 && nodeEnd > nodeStart && start > nodeEnd && end > start,
    "review opening feedback fixture boundaries when the implementation changes");
  vm.runInContext(script.slice(nodeStart, nodeEnd) + "\n" + script.slice(start, end), context);
  anchor = context.renderLink(link).children[0];
  return {
    anchor, announcements, navigationAnnouncements, calls, context, resolve, reject,
    open: options => context.openSavedLink(link, options),
    runTimers() {
      const pending = [...timers.values()]; timers.clear();
      pending.forEach(({ callback }) => callback());
    }
  };
}

test("a fast successful click never inserts transient text or an extra link child", async () => {
  const view = fixture({ immediateResult: { ok: true, reused: false } });
  const originalChildren = [...view.anchor.children];
  const originalText = view.anchor.textContent;
  const pending = view.open();
  assert.equal(view.calls.length, 1, "opening still starts synchronously in the click gesture");
  assert.equal(view.anchor.getAttribute("aria-busy"), "true");
  assert.equal(view.anchor.textContent, originalText,
    "a fast click must not briefly add opening text and shorten the visible link title");
  assert.deepEqual(view.anchor.children, originalChildren,
    "the loading affordance must not insert a width-consuming child into the row");
  await pending;
  view.runTimers();
  assert.equal(view.anchor.textContent, originalText, "completed fast opens must not show a late loading label");
  assert.deepEqual(view.anchor.children, originalChildren);
  assert.equal(view.anchor.getAttribute("aria-busy"), "false");
  assert.equal(view.context.openingUrls.size, 0);
});

for (const badge of ["열림", "현재"]) {
  test(`clicking a ${badge} link keeps its existing state label while the API is pending`, async () => {
    const view = fixture({ badge });
    const originalText = view.anchor.textContent;
    const originalBadge = view.anchor.querySelector(".open-indicator");
    const pending = view.open();
    assert.equal(view.anchor.textContent, originalText,
      "an existing stable state badge must not flash to a temporary opening label");
    assert.equal(view.anchor.querySelector(".open-indicator"), originalBadge);
    view.resolve({ ok: true, reused: true }); await pending;
    assert.equal(originalBadge.textContent, badge);
  });
}

test("a fast open does not flash a visible status line and keeps success in the navigation live region", async () => {
  const view = fixture({ immediateResult: { ok: true, reused: true } });
  await view.open();
  view.runTimers();
  assert.deepEqual(view.announcements, [], "navigation must not replace the visible save or undo message");
  assert.ok(view.navigationAnnouncements.every(([message]) => !/여는 중/u.test(message)),
    "routine fast opens must not add then replace a temporary opening announcement");
  assert.ok(view.navigationAnnouncements.some(([message, error]) => message && !error),
    "completed opens still provide a polite screen-reader update");
});

test("quiet successful feedback does not hide failures or prevent a subsequent retry", async () => {
  const view = fixture();
  const pending = view.open();
  view.resolve({ ok: false, error: "Synthetic open failure" }); await pending;
  assert.ok(view.navigationAnnouncements.some(([message, error]) => message.includes("Synthetic open failure") && error === true));
  assert.deepEqual(view.announcements, [], "navigation failures use their own visible retry region");
  assert.equal(view.context.openingUrls.size, 0);
  await view.open();
  assert.equal(view.calls.length, 2);
});

function announcementFixture() {
  const navigation = new Element("p"), status = new Element("p");
  const classes = new Set(["status", "sr-only"]);
  navigation.classList = { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } };
  status.textContent = "Saved successfully";
  const context = vm.createContext({ $: id => id === "navigation-status" ? navigation : status });
  const start = script.indexOf("function announceNavigation(");
  const end = script.indexOf("\nfunction library(", start);
  assert.ok(start >= 0 && end > start, "navigation announcement helper must remain independently testable");
  vm.runInContext(script.slice(start, end), context);
  return { navigation, status, classes, announce: (...args) => context.announceNavigation(...args) };
}

test("successful navigation updates a visually hidden live region without changing the save status", () => {
  const view = announcementFixture();
  view.announce("Opened successfully");
  assert.equal(view.navigation.textContent, "Opened successfully");
  assert.equal(view.navigation.dataset.error, "false");
  assert.ok(view.classes.has("sr-only"));
  assert.equal(view.status.textContent, "Saved successfully");
});

test("navigation errors stay visible until a later successful navigation resolves them", () => {
  const view = announcementFixture();
  view.announce("Could not open. Please try again.", true);
  assert.equal(view.navigation.dataset.error, "true");
  assert.ok(!view.classes.has("sr-only"));
  assert.equal(view.navigation.textContent, "Could not open. Please try again.");
  assert.equal(view.status.textContent, "Saved successfully");
  view.announce("Opened successfully");
  assert.ok(view.classes.has("sr-only"));
  assert.equal(view.navigation.dataset.error, "false");
  assert.equal(view.status.textContent, "Saved successfully");
});

test("the quiet navigation live region is available before its first announcement", () => {
  assert.match(html, /<p id="navigation-status"[^>]*class="[^"]*sr-only[^"]*"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u);
  assert.doesNotMatch(css, /\.status:empty\s*\{[^}]*display:\s*none/u,
    "empty screen-reader live regions must not be hidden with display:none before their first update");
});
