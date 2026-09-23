import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { collectPackageEntries } from "../scripts/package-extension.mjs";
import { flattenGroups, MAX_GROUP_DEPTH, identifyUrl, SYSTEM_GROUP_ID } from "../src/link-library.js";
import { findSavedPage } from "../src/link-navigation.js";

// Bounded source and synthetic-DOM regressions, not a WCAG conformance audit.
// Real layout, zoom, computed styles, keyboard use and assistive technology
// require browser testing in addition to these checks.
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [css, html, script] = await Promise.all([
  read("../sidepanel/sidepanel.css"), read("../sidepanel/sidepanel.html"),
  read("../sidepanel/sidepanel.js")
]);
const rootBlocks = [...css.matchAll(/:root\s*\{([^}]+)\}/gu)];
assert.equal(rootBlocks.length, 2, "review light/dark token extraction if root blocks change");
const themes = Object.fromEntries(rootBlocks.map((match, index) => [index ? "dark" : "light",
  Object.fromEntries([...match[1].matchAll(/--([a-z-]+):\s*(#[a-f\d]{6})\s*;/giu)]
    .map((entry) => [entry[1], entry[2]]))]));
const surfaces = ["bg", "surface", "subtle", "tint", "hover"];

function luminance(hex) {
  assert.match(hex, /^#[a-f\d]{6}$/iu, "opaque sRGB token required for this contrast calculation");
  return hex.slice(1).match(/../gu).map((part) => parseInt(part, 16) / 255)
    .map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
}
function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
function atLeast(tokens, foreground, background, minimum, context) {
  const ratio = contrast(tokens[foreground], tokens[background]);
  assert.ok(ratio >= minimum,
    `${context}: ${foreground}/${background} is ${ratio.toFixed(3)}:1, expected >= ${minimum}:1`);
}
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = css.match(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]+)\\}`, "u"));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return Object.fromEntries(match[1].split(";").filter((part) => part.includes(":"))
    .map((part) => part.split(":").map((value) => value.trim())));
}

for (const [name, tokens] of Object.entries(themes)) {
  test(`${name} opaque body, secondary, accent and error text tokens meet 4.5:1 on supported surfaces`, () => {
    for (const foreground of ["text", "muted", "accent", "danger"]) {
      for (const surface of surfaces) atLeast(tokens, foreground, surface, 4.5, name);
    }
  });
  test(`${name} primary labels and visible focus/input boundaries retain their contrast`, () => {
    for (const fill of ["accent", "accent-hover"]) atLeast(tokens, "on-accent", fill, 4.5, name);
    for (const surface of surfaces) atLeast(tokens, "accent", surface, 3, `${name} focus ring`);
    // Inputs/search are surface-filled with bg outside; decorative --line dividers
    // and hypothetical inputs on tint are intentionally not claimed as controls.
    for (const surface of ["surface", "bg"]) atLeast(tokens, "input-line", surface, 3, `${name} input edge`);
    assert.equal(rule("input, select").background, "var(--surface)");
    assert.equal(rule("input, select").border, "1px solid var(--input-line)");
    assert.equal(rule(".search-bar").background, "var(--surface)");
    assert.equal(rule(".search-bar").border, "1px solid var(--input-line)");
  });
}

test("local regular Phosphor assets and MIT notice are reachable in the release package", async () => {
  const expected = ["arrow-up-right", "caret-down", "caret-right", "check", "dots-three", "magnifying-glass", "plus", "x"];
  const references = [...css.matchAll(/url\("\.\.\/icons\/ui\/([a-z-]+)\.svg"\)/gu)].map((match) => match[1]).sort();
  assert.deepEqual(references, expected);
  const { entries } = await collectPackageEntries();
  const packaged = new Set(entries.map((entry) => entry.path));
  for (const name of expected) {
    const path = `icons/ui/${name}.svg`;
    assert.ok(packaged.has(path), `${path} must ship, not load from a CDN`);
    const svg = await read(`../${path}`);
    assert.match(svg, /<svg\s[^>]*viewBox="0 0 256 256"[^>]*fill="currentColor"/u);
    assert.match(svg, /<path\sd="[^"]+"\s*\/>/u);
    assert.doesNotMatch(svg, /(?:\b(?:xlink:)?href\s*=|url\s*\(|<script\b|<foreignObject\b|<image\b|<!DOCTYPE|<!ENTITY|\bon\w+\s*=)/iu);
  }
  assert.ok(packaged.has("icons/ui/LICENSE.txt"));
  assert.match(html, /href="\.\.\/icons\/ui\/LICENSE\.txt"/u);
  const license = await read("../icons/ui/LICENSE.txt");
  assert.match(license, /MIT License/u);
  assert.match(license, /Copyright \(c\) 2023 Phosphor Icons/u);
  assert.match(license, /The above copyright notice and this permission notice shall be included/u);
});

test("icons retain prefixed masks for the supported Chrome 116 through 119 releases", () => {
  const icon = rule(".ui-icon");
  assert.equal(icon["-webkit-mask"], "var(--icon) center / contain no-repeat");
  assert.equal(icon.mask, icon["-webkit-mask"]);
});

test("source guards preserve readable link text, control targets, focus and motion alternatives", () => {
  assert.equal(rule(".link-anchor")["font-size"], "14px");
  for (const selector of ["button", ".quiet-button", ".icon-button", ".text-button", ".small", ".fold", ".link-anchor"]) {
    assert.ok(parseFloat(rule(selector)["min-height"]) >= 32, `${selector} min-height must remain >= 32px`);
  }
  assert.ok(parseFloat(rule(".icon-button")["min-width"]) >= 32);
  for (const dimension of ["width", "height"]) assert.ok(parseFloat(rule(".row-menu > summary")[dimension]) >= 32);
  assert.equal(rule("button:focus-visible, a:focus-visible, summary:focus-visible").outline, "2px solid var(--accent)");
  assert.equal(rule(".search-bar:focus-within").outline, "2px solid var(--accent)");
  assert.equal(rule("input:focus, select:focus").outline, "2px solid var(--accent)");
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition:\s*none\s*!important;[^}]*scroll-behavior:\s*auto\s*!important;/u);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/u);
  assert.match(css, /\.ui-icon\s*\{[^}]*background-color:\s*CanvasText;[^}]*forced-color-adjust:\s*none;/u);
  assert.match(css, /\.link-row\.current\s*\{\s*border:\s*1px solid Highlight;/u);
});

test("static icon-only buttons have accessible names and icons stay decorative", () => {
  let iconOnlyCount = 0;
  for (const [, attributes, content] of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)) {
    if (!content.includes("ui-icon")) continue;
    for (const [icon] of content.matchAll(/<span\b[^>]*class="[^"]*\bui-icon\b[^"]*"[^>]*>/gu)) {
      assert.match(icon, /aria-hidden="true"/u);
    }
    if (content.replace(/<[^>]*>/gu, "").trim()) continue;
    iconOnlyCount += 1;
    assert.match(attributes, /aria-label="[^"\s][^"]*"/u, "icon-only button needs a name, not just a title");
  }
  assert.equal(iconOnlyCount, 3, "library add, link dialog close and theme dialog close all need accessible names");
});

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.value = ""; this.className = ""; this.ownText = ""; this.style = { setProperty(name, value) { this[name] = value; } }; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.ownText = ""; this.children = children; }
  addEventListener() {}
}
function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }
function accessibleText(element) {
  if (element.getAttribute("aria-hidden") === "true") return "";
  return element.getAttribute("aria-label") || element.ownText + element.children.map(accessibleText).join(" ");
}

test("rendered recursive group/link controls retain names and current/open semantics", () => {
  const elements = new Map();
  const document = {
    createElement: (tag) => new Element(tag),
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element("div")); return elements.get(id); }
  };
  const context = vm.createContext({
    document, createPlatform: () => ({}), identifyUrl, findSavedPage,
    SYSTEM_GROUP_ID, flattenGroups, MAX_GROUP_DEPTH
  });
  const initializationStart = script.indexOf('$("dialog-form").addEventListener("submit"');
  assert.ok(initializationStart > 0, "review initialization boundary before executing source fixture");
  vm.runInContext(script.slice(0, initializationStart).replace(/^import .+;\n/gmu, ""), context);
  vm.runInContext(`
    state = { catalog: { libraries: [{ id: "demo-library", name: "보관함", groups: [{
      id: "demo-group", name: "프로젝트", collapsed: false, links: [], groups: [{
        id: "demo-child", name: "읽을거리", collapsed: false, groups: [], links: [
          { id: "link-current", title: "현재 문서", url: "https://example.com/current" },
          { id: "link-open", title: "참고 문서", url: "https://example.com/reference" }
        ]
      }]
    }] }] }, canUndo: false, hasRestorePoint: false };
    libraryId = "demo-library";
    currentPage = { title: "현재 문서", url: "https://example.com/current" };
    pageKey = safeKey(currentPage.url);
    openTabs = [currentPage, { url: "https://example.com/reference" }];
    render();
  `, context);
  const treeNodes = descendants(elements.get("tree"));
  const controls = treeNodes.filter((element) => ["BUTTON", "SUMMARY"].includes(element.tagName));
  assert.ok(controls.length > 5, "fixture must render groups, child groups and link menus");
  for (const control of controls) assert.ok(accessibleText(control).trim(), `${control.tagName}.${control.className} needs a name`);
  const addMenu = controls.find((element) => element.getAttribute("aria-label") === "프로젝트에 추가 메뉴");
  assert.ok(addMenu, "every group needs its own add menu");
  assert.ok(controls.some(element => accessibleText(element) === "하위 그룹 추가"));
  for (const icon of treeNodes.filter((element) => element.className.split(" ").includes("ui-icon"))) {
    assert.equal(icon.getAttribute("aria-hidden"), "true");
  }
  const folds = controls.filter((element) => element.className === "fold");
  assert.equal(folds.length, 2);
  for (const fold of folds) assert.equal(fold.getAttribute("aria-expanded"), "true");
  const anchors = treeNodes.filter((element) => element.tagName === "A");
  assert.equal(anchors[0].getAttribute("aria-current"), "page");
  assert.equal(anchors[1].getAttribute("aria-current"), undefined);
  assert.match(accessibleText(anchors[0]), /현재 문서.*현재/u);
  assert.match(accessibleText(anchors[1]), /참고 문서.*열림/u);
});

function positionedMenu({ viewportHeight, top, bottom, contentHeight }) {
  const start = script.indexOf("function positionMenu(details) {");
  const end = script.indexOf("\nfunction menu(", start);
  assert.ok(start >= 0 && end > start, "review menu positioning source boundary");
  const body = { scrollHeight: contentHeight, style: {} };
  const summary = { getBoundingClientRect: () => ({ top, bottom }) };
  const details = {
    open: true, dataset: {},
    querySelector(selector) { return selector === "summary" ? summary : body; }
  };
  const context = vm.createContext({ window: { innerHeight: viewportHeight }, details });
  vm.runInContext(`${script.slice(start, end)}\npositionMenu(details);`, context);
  return { side: details.dataset.side, maxHeight: parseFloat(body.style.maxHeight) };
}

test("a lower-row menu opens above its trigger instead of escaping a 740px viewport", () => {
  const positioned = positionedMenu({ viewportHeight: 740, top: 676, bottom: 708, contentHeight: 228 });
  assert.equal(positioned.side, "above");
  assert.equal(positioned.maxHeight, 320);
  assert.ok(positioned.maxHeight <= 676 - 12);
  assert.equal(rule(".row-menu[data-side=above] .menu-items").top, "auto");
  assert.equal(rule(".row-menu[data-side=above] .menu-items").bottom, "34px");
});

test("an upper-row menu keeps its below-trigger placement when there is room", () => {
  const positioned = positionedMenu({ viewportHeight: 740, top: 40, bottom: 72, contentHeight: 228 });
  assert.equal(positioned.side, "below");
  assert.equal(positioned.maxHeight, 320);
  assert.ok(positioned.maxHeight <= 740 - 72 - 12);
  assert.equal(rule(".menu-items").top, "34px");
});

test("a short viewport limits menu height to the larger available side and permits scrolling", () => {
  const positioned = positionedMenu({ viewportHeight: 180, top: 80, bottom: 112, contentHeight: 228 });
  assert.equal(positioned.side, "above");
  assert.equal(positioned.maxHeight, 68);
  assert.ok(positioned.maxHeight < 228);
  assert.equal(rule(".menu-items")["overflow-y"], "auto");
});
