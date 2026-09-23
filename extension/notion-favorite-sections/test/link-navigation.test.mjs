import assert from "node:assert/strict";
import test from "node:test";
import { findSavedPage } from "../src/link-navigation.js";

const group = (id, groups = [], links = []) => ({ id, name: id, collapsed: true, groups, links });
const lib = (id, url) => ({ id, name: id, groups: [group(`root-${id}`, [group(`nested-${id}`, [group(`deep-${id}`, [], [{ id: `link-${id}`, url }])])])] });

test("current page finds deeply nested destinations and prefers the active library without reordering input", () => {
  const catalog = { libraries: [lib("one", "https://example.com/doc"), lib("two", "https://example.com/doc")] };
  const before = structuredClone(catalog);
  const found = findSavedPage(catalog, "https://example.com/doc", "two");
  assert.equal(found.library.id, "two");
  assert.equal(found.group.id, "deep-two");
  assert.deepEqual(found.path.map(item => item.id), ["root-two", "nested-two", "deep-two"]);
  assert.equal(found.path.at(-1), found.group);
  assert.equal(found.link.id, "link-two");
  assert.equal(Object.hasOwn(found, "section"), false);
  assert.deepEqual(catalog, before);
  assert.equal(findSavedPage(catalog, "https://example.com/doc", "missing").library.id, "one");
});

test("a directly saved root link has a one-group expansion path", () => {
  const root = group("root", [], [{ id: "root-link", url: "https://example.com/root" }]);
  const found = findSavedPage({ libraries: [{ id: "personal", groups: [root] }] }, "https://example.com/root", "personal");
  assert.equal(found.group, root);
  assert.deepEqual(found.path, [root]);
  assert.equal(found.link.id, "root-link");
});

test("nested current page matching uses canonical Notion and Drive identity", () => {
  const notion = { libraries: [lib("notion", "https://www.notion.so/Title-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")] };
  assert.equal(findSavedPage(notion, "https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "").link.id, "link-notion");
  const drive = { libraries: [lib("drive", "https://drive.google.com/file/d/exampleFile123/view")] };
  assert.equal(findSavedPage(drive, "https://drive.google.com/open?id=exampleFile123", "").link.id, "link-drive");
});

test("unmatched and unsafe current URLs return no destination", () => {
  const catalog = { libraries: [lib("one", "https://example.com/doc")] };
  for (const url of ["chrome://extensions", "javascript:alert(1)", "https://example.com/new", "not a url"]) assert.equal(findSavedPage(catalog, url, "one"), null);
  assert.equal(findSavedPage(null, "https://example.com/doc", "one"), null);
});
