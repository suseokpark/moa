import assert from "node:assert/strict";
import test from "node:test";
import { applyCatalogAction, createCatalog, SYSTEM_GROUP_ID, validateCatalog } from "../src/link-library.js";
import { createPlatform } from "../src/favmoa-platform.js";
import { prepareBookmarkCandidates, prepareOpenTabCandidates } from "../src/open-tab-candidates.js";

const pageId = "0123456789abcdef0123456789abcdef";
const notion = `https://app.notion.com/p/sample/Project-${pageId}?view=board#overview`;

test("bookmark choices retain exact normalized URLs and clean transient folder paths without browser metadata or mutation", () => {
  const items = [
    { id: "12", parentId: "3", title: "  프로젝트 문서  ", url: `  ${notion}  `, folderPath: "  업무\n/\t프로젝트\u0000  ", dateAdded: 123 },
    { id: "13", title: "Guide", url: "https://EXAMPLE.org:443/guide?view=compact#intro", folderPath: "개인 / 참고" }
  ];
  const existing = [{ url: "https://example.net/saved" }];
  const original = structuredClone({ items, existing });
  assert.deepEqual(prepareBookmarkCandidates(items, existing), {
    candidates: [
      { key: `notion:${pageId}`, title: "프로젝트 문서", url: notion, folderPath: "업무 / 프로젝트" },
      { key: "https://example.org/guide?view=compact#intro", title: "Guide", url: "https://example.org/guide?view=compact#intro", folderPath: "개인 / 참고" }
    ], savedCount: 0, duplicateCount: 0, unsupportedCount: 0
  });
  assert.deepEqual({ items, existing }, original);
});

test("saved identity classification wins over duplicates regardless of source folder or exact URL", () => {
  const items = [
    { title: "Saved first", url: notion, folderPath: "A" },
    { title: "Saved second", url: `https://www.notion.so/${pageId}`, folderPath: "B" },
    { title: "New first", url: "https://example.org/new", folderPath: "C" },
    { title: "New second", url: "https://example.org/new", folderPath: "D" },
    { title: "Invalid", url: "chrome://extensions", folderPath: "E" }
  ];
  const result = prepareBookmarkCandidates(items, [{ url: `https://app.notion.com/p/other/${pageId}?view=list` }]);
  assert.deepEqual(result, {
    candidates: [{ key: "https://example.org/new", title: "New first", url: "https://example.org/new", folderPath: "C" }],
    savedCount: 2, duplicateCount: 1, unsupportedCount: 1
  });
  assert.equal(result.candidates.length + result.savedCount + result.duplicateCount + result.unsupportedCount, items.length);
});

test("first valid Notion and Drive identities retain their source title, URL, path and order", () => {
  const result = prepareBookmarkCandidates([
    { url: `https://app.notion.com/p/sample/${pageId}?token=synthetic`, title: "Invalid first", folderPath: "Invalid" },
    { url: notion, title: "First valid", folderPath: "Notion / First" },
    { url: `https://www.notion.so/${pageId}?view=other`, title: "Duplicate", folderPath: "Notion / Later" },
    { url: "https://drive.google.com/drive/folders/sample-folder?usp=sharing", title: "Folder", folderPath: "Drive / First" },
    { url: "https://drive.google.com/open?id=sample-folder", title: "Duplicate folder", folderPath: "Drive / Later" }
  ]);
  assert.deepEqual(result.candidates, [
    { key: `notion:${pageId}`, title: "First valid", url: notion, folderPath: "Notion / First" },
    { key: "google-drive:sample-folder", title: "Folder", url: "https://drive.google.com/drive/folders/sample-folder?usp=sharing", folderPath: "Drive / First" }
  ]);
  assert.equal(result.unsupportedCount, 1);
  assert.equal(result.duplicateCount, 2);
});

test("malformed, unsafe and credential-bearing bookmark addresses never become candidates", () => {
  const items = [null, {}, { url: 42 }, { url: "javascript:alert(1)" }, { url: "file:///tmp/synthetic" },
    { url: "https://user:password@example.org/" }, { url: "https://example.org/oauth/callback" },
    { url: "https://example.org/page#access_token=synthetic" }, { url: "https://example.org/page?api_key=synthetic" }];
  assert.deepEqual(prepareBookmarkCandidates(items), {
    candidates: [], savedCount: 0, duplicateCount: 0, unsupportedCount: items.length
  });
  assert.deepEqual(prepareBookmarkCandidates(undefined, null), {
    candidates: [], savedCount: 0, duplicateCount: 0, unsupportedCount: 0
  });
});

test("301-character titles are truncated before saving and folder metadata never enters the catalog", () => {
  const result = prepareBookmarkCandidates([
    { title: "가".repeat(301), url: "https://example.org/a", folderPath: "Folder" },
    { title: "  Title\nwith\tcontrols\u0000  ", url: "https://example.org/b", folderPath: "Other" },
    { title: { unsafe: "not text" }, url: "https://example.org/c" },
    { title: "\n\t", url: `https://example.org/${"long".repeat(100)}` }
  ]);
  assert.deepEqual(result.candidates.map(item => item.title), [
    "가".repeat(300), "Title with controls", "https://example.org/c", `https://example.org/${"long".repeat(100)}`.slice(0, 300)
  ]);
  let catalog = createCatalog();
  for (const { title, url } of result.candidates) {
    catalog = applyCatalogAction(catalog, { type: "addLink", libraryId: "library-personal", groupId: SYSTEM_GROUP_ID, link: { title, url } });
  }
  assert.doesNotThrow(() => validateCatalog(catalog));
  assert.equal(JSON.stringify(catalog).includes("folderPath"), false);
});

test("folder paths have a safe string fallback, no control characters and a 1000-character bound", () => {
  const result = prepareBookmarkCandidates([
    { url: "https://example.org/a", folderPath: "가".repeat(1001) },
    { url: "https://example.org/b", folderPath: null },
    { url: "https://example.org/c", folderPath: { toString: "do not coerce" } },
    { url: "https://example.org/d", folderPath: "  A\u007f/\u009fB  " }
  ]);
  assert.deepEqual(result.candidates.map(item => item.folderPath), ["가".repeat(1000), "", "", "A / B"]);
});

test("only caller-provided current-library links are excluded and malformed existing metadata is ignored", () => {
  const items = [{ title: "New", url: "https://example.org/new", folderPath: "Folder" }];
  const anotherLibraryLinks = [{ url: items[0].url }];
  assert.equal(prepareBookmarkCandidates(items, [null, {}, { url: "not a URL" }]).candidates.length, 1);
  assert.equal(prepareBookmarkCandidates(items, anotherLibraryLinks).savedCount, 1);
  assert.equal(prepareBookmarkCandidates(items, []).candidates.length, 1);
});

test("bookmark and open-tab preparation share classification while tab result shape stays unchanged", () => {
  const items = [
    { title: "First", url: "https://example.org/first", folderPath: "A" },
    { title: "Duplicate", url: "https://example.org/first", folderPath: "B" },
    { title: "Saved", url: "https://example.org/saved", folderPath: "C" },
    { title: "Unsafe", url: "chrome://settings", folderPath: "D" }
  ];
  const existing = [{ url: "https://example.org/saved" }];
  const bookmarkResult = prepareBookmarkCandidates(items, existing);
  const tabResult = prepareOpenTabCandidates(items, existing);
  assert.deepEqual({ ...bookmarkResult, candidates: bookmarkResult.candidates.map(({ folderPath, ...candidate }) => candidate) }, tabResult);
  assert.equal(Object.hasOwn(tabResult.candidates[0], "folderPath"), false);
});

test("local preview bookmark choices are independent synthetic fixtures with two new and one saved page", async () => {
  const platform = createPlatform({ chrome: undefined, location: { protocol: "http:", hostname: "127.0.0.1" } });
  const result = await platform.getBookmarkCandidates();
  assert.deepEqual(result, {
    ok: true, demo: true, candidates: [
      { title: "예시 참고 문서 (데모)", url: "https://example.org/reference", folderPath: "데모 북마크" },
      { title: "예시 사용 안내 (데모)", url: "https://example.net/guide", folderPath: "데모 / 안내" },
      { title: "예시 프로젝트 문서 (데모)", url: "https://example.com/project/specification", folderPath: "데모 / 프로젝트" }
    ]
  });
  result.candidates[2].title = "Changed";
  const fresh = await platform.getBookmarkCandidates();
  assert.equal(fresh.candidates[2].title, "예시 프로젝트 문서 (데모)");
  assert.equal((await platform.getCurrentPage()).title, "예시 프로젝트 문서 (데모)");
  const prepared = prepareBookmarkCandidates(fresh.candidates, [await platform.getCurrentPage()]);
  assert.equal(prepared.savedCount, 1);
  assert.equal(prepared.candidates.length, 2);
});
