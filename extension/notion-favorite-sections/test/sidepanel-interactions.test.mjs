import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const script = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../sidepanel/sidepanel.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../sidepanel/sidepanel.css", import.meta.url), "utf8");

test("group creation is a theme-colored secondary action with a visible label", () => {
  assert.match(html, /id="add-group" class="secondary small"/u);
  assert.match(css, /\.secondary\s*\{[^}]*background: var\(--tint\);[^}]*color: var\(--accent\);[^}]*border-color: var\(--accent\);/u);
});

test("tree wires link and group dragging, group/root destinations, and keeps keyboard move menus", () => {
  assert.match(script, /treeDrag\.bindSource\(row, \{ kind: "link", id: link.id \}\)/u);
  assert.match(script, /treeDrag\.bindSource\(fold.control, \{ kind: "group", id: group.id \}\)/u);
  assert.match(script, /treeDrag\.bindTarget\(wrapper, \{ groupId: group.id \}\)/u);
  assert.match(script, /treeDrag\.bindTarget\(\$\("root-drop"\), \{ groupId: null \}\)/u);
  assert.match(script, /\["다른 그룹으로 이동", \(\) => moveDialog\(link\)\]/u);
  assert.match(script, /\["다른 그룹으로 이동", \(\) => moveGroupDialog\(group\)\]/u);
  assert.match(html, /id="drag-help"/u);
  assert.match(css, /\.group\.is-drop-target\s*\{[^}]*outline:/u);
});

function openingFixture(result) {
  const start = script.indexOf("async function openSavedLink(");
  const end = script.indexOf("\nfunction renderLink(", start);
  assert.ok(start >= 0 && end > start, "opening behavior must be testable independently");
  const events = [];
  let resolve, reject;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  const context = vm.createContext({
    openingUrls: new Set(), openingCounts: new Map(),
    platform: { openLink: (...args) => { events.push(["open", ...args]); return response; } },
    updateOpeningLinks: (...args) => events.push(["busy", ...args]),
    announce: (...args) => events.push(["announce", ...args]),
    refreshTabs: async () => { events.push(["refresh"]); }
  });
  vm.runInContext(script.slice(start, end), context);
  return { events, context, open: (options = {}) => context.openSavedLink({ title: "Example", url: "https://example.com/document" }, options), resolve: () => resolve(result), reject };
}

test("click feedback starts before Chrome responds, coalesces repeat clicks, and clears after success", async () => {
  const fixture = openingFixture({ ok: true, reused: false });
  const pending = fixture.open();
  assert.equal(fixture.events[0][0], "busy");
  assert.equal(fixture.events[0][2], true);
  assert.equal(fixture.events[1][0], "announce");
  assert.match(fixture.events[1][1], /여는 중/u);
  assert.equal(fixture.events[2][0], "open", "call must start synchronously to preserve the click gesture");
  await fixture.open();
  assert.equal(fixture.events.filter(event => event[0] === "open").length, 1);
  fixture.resolve(); await pending;
  assert.equal(fixture.context.openingUrls.size, 0);
  assert.deepEqual(fixture.events.at(-1), ["busy", "https://example.com/document", false]);
  assert.ok(fixture.events.some(event => event[0] === "refresh"));
});

test("failed opens clear pending state, announce the failure, and allow retry", async () => {
  const fixture = openingFixture({ ok: false, error: "열기 실패" });
  const pending = fixture.open(); fixture.resolve(); await pending;
  assert.equal(fixture.context.openingUrls.size, 0);
  assert.ok(fixture.events.some(event => event[0] === "announce" && event[1] === "열기 실패" && event[2] === true));
  await fixture.open();
  assert.equal(fixture.events.filter(event => event[0] === "open").length, 2);
});

test("an explicit new-tab request is not swallowed by an ordinary pending click", async () => {
  const fixture = openingFixture({ ok: true, reused: false });
  const ordinary = fixture.open(); const forced = fixture.open({ newTab: true });
  assert.equal(fixture.events.filter(event => event[0] === "open").length, 2);
  assert.equal(fixture.context.openingCounts.get("https://example.com/document"), 2);
  fixture.resolve(); await Promise.all([ordinary, forced]);
  assert.equal(fixture.context.openingUrls.size, 0);
  assert.equal(fixture.context.openingCounts.size, 0);
  assert.equal(fixture.events.filter(event => event[0] === "busy" && event[2] === false).length, 1);
});

test("unexpected API rejection does not leave the link stuck as opening", async () => {
  const fixture = openingFixture(); const pending = fixture.open();
  fixture.reject(new Error("API failed")); await pending;
  assert.equal(fixture.context.openingUrls.size, 0);
  assert.ok(fixture.events.some(event => event[0] === "announce" && event[2] === true));
});

test("render precomputes tab identities instead of scanning every tab for every link", () => {
  assert.match(script, /openTabKeys = new Set\(openTabs.map\(tab => safeKey\(tab.url\)\)\)/u);
  assert.match(script, /const isOpen = openTabKeys.has\(linkKey\)/u);
  assert.doesNotMatch(script, /openTabs.some\(/u);
});
