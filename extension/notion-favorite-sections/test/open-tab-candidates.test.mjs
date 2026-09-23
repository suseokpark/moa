import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogAction, createCatalog, SYSTEM_GROUP_ID, validateCatalog } from "../src/link-library.js";
import { prepareOpenTabCandidates } from "../src/open-tab-candidates.js";

const pageId = "0123456789abcdef0123456789abcdef";
const notion = `https://app.notion.com/p/sample/Project-${pageId}?view=board#overview`;

test("open tab preparation keeps normalized exact URLs and excludes browser metadata without mutating inputs", () => {
  const tabs = [
    { id: 12, windowId: 3, title: "  프로젝트 문서  ", url: `  ${notion}  `, active: true, favIconUrl: "https://example.net/icon.png" },
    { id: 13, title: "Guide", url: "https://EXAMPLE.org:443/guide?view=compact#intro" }
  ];
  const existing = [{ url: "https://example.net/saved" }];
  const original = structuredClone({ tabs, existing });
  const result = prepareOpenTabCandidates(tabs, existing);
  assert.deepEqual(result, {
    candidates: [
      { key: `notion:${pageId}`, title: "프로젝트 문서", url: notion },
      { key: "https://example.org/guide?view=compact#intro", title: "Guide", url: "https://example.org/guide?view=compact#intro" }
    ], savedCount: 0, duplicateCount: 0, unsupportedCount: 0
  });
  assert.deepEqual({ tabs, existing }, original);
});

test("saved identities take precedence over duplicates and every input receives one classification", () => {
  const tabs = [
    { title: "Saved A", url: notion },
    { title: "Saved B", url: `https://www.notion.so/${pageId}` },
    { title: "First", url: "https://example.org/guide" },
    { title: "Second", url: "https://example.org/guide" },
    { title: "Unsafe", url: "chrome://extensions" }
  ];
  const result = prepareOpenTabCandidates(tabs, [{ url: `https://app.notion.com/p/another/${pageId}?view=list` }]);
  assert.deepEqual(result, {
    candidates: [{ key: "https://example.org/guide", title: "First", url: "https://example.org/guide" }],
    savedCount: 2, duplicateCount: 1, unsupportedCount: 1
  });
  assert.equal(result.candidates.length + result.savedCount + result.duplicateCount + result.unsupportedCount, tabs.length);
});

test("Notion and Drive duplicate identities keep the first valid tab URL, title and order", () => {
  const tabs = [
    { url: `https://app.notion.com/p/sample/${pageId}?token=not-a-real-token`, title: "Unsafe first" },
    { url: notion, title: "First valid" },
    { url: `https://www.notion.so/${pageId}?view=other`, title: "Duplicate" },
    { url: "https://drive.google.com/drive/folders/sample-folder?usp=sharing", title: "Folder" },
    { url: "https://drive.google.com/open?id=sample-folder", title: "Folder duplicate" }
  ];
  const result = prepareOpenTabCandidates(tabs);
  assert.deepEqual(result.candidates.map(({ title, url }) => ({ title, url })), [
    { title: "First valid", url: notion },
    { title: "Folder", url: "https://drive.google.com/drive/folders/sample-folder?usp=sharing" }
  ]);
  assert.equal(result.unsupportedCount, 1);
  assert.equal(result.duplicateCount, 2);
});

test("unsupported, credential-bearing, private and malformed tabs cannot become candidates", () => {
  const tabs = [null, {}, { url: "javascript:alert(1)" }, { url: "file:///tmp/test" },
    { url: "https://user:password@example.org/" }, { url: "https://example.org/oauth/callback" },
    { url: "https://example.org/page#access_token=synthetic" },
    { url: "https://example.org/private", incognito: true }];
  assert.deepEqual(prepareOpenTabCandidates(tabs), {
    candidates: [], savedCount: 0, duplicateCount: 0, unsupportedCount: tabs.length
  });
  assert.deepEqual(prepareOpenTabCandidates(undefined, null), {
    candidates: [], savedCount: 0, duplicateCount: 0, unsupportedCount: 0
  });
});

test("titles are trimmed, control-free, nonempty and at most 300 characters accepted by the catalog", () => {
  const tabs = [
    { title: "  Title\nwith\tcontrols\u0000  ", url: "https://example.org/a" },
    { title: "  ", url: "https://example.org/b" },
    { title: { private: "not a string" }, url: "https://example.org/c" },
    { title: "가".repeat(450), url: "https://example.org/d" },
    { url: `https://example.org/${"long".repeat(100)}` }
  ];
  const result = prepareOpenTabCandidates(tabs);
  assert.deepEqual(result.candidates.map(item => item.title), [
    "Title with controls", "https://example.org/b", "https://example.org/c", "가".repeat(300), tabs[4].url.slice(0, 300)
  ]);
  let catalog = createCatalog();
  for (const { title, url } of result.candidates) {
    catalog = applyCatalogAction(catalog, { type: "addLink", libraryId: "library-personal", groupId: SYSTEM_GROUP_ID, link: { title, url } });
  }
  assert.doesNotThrow(() => validateCatalog(catalog));
});

test("invalid existing metadata is ignored without hiding safe candidates", () => {
  const tabs = [{ url: "https://example.org/new", title: "New" }];
  assert.equal(prepareOpenTabCandidates(tabs, [null, {}, { url: "not a URL" }]).candidates.length, 1);
});
