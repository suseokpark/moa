import assert from "node:assert/strict";
import test from "node:test";
import { createPlatform } from "../src/favmoa-platform.js";
import { prepareOpenTabCandidates } from "../src/open-tab-candidates.js";

function extensionFixture(tabs) {
  const calls = [];
  const chrome = {
    runtime: { id: "synthetic-extension" },
    tabs: {
      async query(options) { calls.push(["query", options]); return structuredClone(tabs); },
      async create() { throw new Error("Must not create tabs"); },
      async update() { throw new Error("Must not update tabs"); },
      async remove() { throw new Error("Must not close tabs"); }
    },
    permissions: { async request() { throw new Error("Must not request permission"); } }
  };
  const platform = createPlatform({ chrome, location: { protocol: "chrome-extension:" } });
  return { chrome, platform, calls };
}

test("open tab API reads all windows once and returns only safe minimal tab metadata", async () => {
  const notion = "https://app.notion.com/p/sample/0123456789abcdef0123456789abcdef?view=board#details";
  const tabs = [
    { id: 1, windowId: 5, title: "First", url: notion, active: true, favIconUrl: "https://example.org/favicon.png", sessionId: "do-not-copy" },
    { id: 2, windowId: 7, title: "Second", url: "https://example.net/guide?view=compact" }
  ];
  const original = structuredClone(tabs);
  const { platform, calls } = extensionFixture(tabs);
  assert.deepEqual(await platform.getOpenTabCandidates(), {
    ok: true, excludedCount: 0, tabs: [
      { id: 1, windowId: 5, title: "First", url: notion },
      { id: 2, windowId: 7, title: "Second", url: "https://example.net/guide?view=compact" }
    ]
  });
  assert.deepEqual(calls, [["query", {}]]);
  assert.deepEqual(tabs, original);
});

test("open tab API excludes private, unsupported and authentication URLs without exposing them", async () => {
  const { platform } = extensionFixture([
    { id: 1, windowId: 1, url: "https://example.org/safe" },
    { id: 2, windowId: 1, title: "Do not expose", url: "https://example.org/private", incognito: true },
    { url: "chrome://settings/" }, { url: "chrome-extension://synthetic/popup.html" },
    { url: "https://example.org/callback?code=synthetic" }, { url: "https://example.org/#token=synthetic" }, null
  ]);
  const result = await platform.getOpenTabCandidates();
  assert.deepEqual(result, { ok: true, tabs: [{ id: 1, windowId: 1, title: "https://example.org/safe", url: "https://example.org/safe" }], excludedCount: 6 });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("tab query failures are explicit retryable errors with no private exception details", async () => {
  const { chrome, platform } = extensionFixture([]);
  chrome.tabs.query = async () => { throw new Error("private browser detail"); };
  assert.deepEqual(await platform.getOpenTabCandidates(), {
    ok: false, code: "TABS_UNAVAILABLE", error: "열린 탭을 읽지 못했습니다. 잠시 후 다시 시도해 주세요."
  });
  chrome.tabs.query = async () => [];
  assert.deepEqual(await platform.getOpenTabCandidates(), { ok: true, tabs: [], excludedCount: 0 });
  delete chrome.tabs;
  assert.equal((await platform.getOpenTabCandidates()).code, "TABS_UNAVAILABLE");
});

test("open tab API does not change the existing open-tabs method or request new permission", async () => {
  const { platform, calls } = extensionFixture([{ id: 1, windowId: 2, title: "Page", url: "https://example.org/", active: true }]);
  assert.deepEqual(await platform.getOpenTabs(), [{ id: 1, windowId: 2, title: "Page", url: "https://example.org/", active: true }]);
  await platform.getOpenTabCandidates();
  assert.deepEqual(calls, [["query", {}], ["query", {}]]);
});

test("local preview returns three unmistakably synthetic independent demo tabs", async () => {
  const platform = createPlatform({ chrome: undefined, location: { protocol: "http:", hostname: "127.0.0.1" } });
  const result = await platform.getOpenTabCandidates();
  assert.equal(result.ok, true);
  assert.equal(result.demo, true);
  assert.equal(result.excludedCount, 0);
  assert.deepEqual(result.tabs.map(tab => tab.url), [
    "https://example.com/project/specification", "https://example.org/reference", "https://example.net/guide"
  ]);
  assert.ok(result.tabs.every(tab => tab.title.includes("데모")));
  result.tabs[0].title = "Changed";
  assert.equal((await platform.getOpenTabCandidates()).tabs[0].title, "예시 프로젝트 문서 (데모)");
  assert.equal((await platform.getCurrentPage()).title, "예시 프로젝트 문서 (데모)");
  const candidates = prepareOpenTabCandidates((await platform.getOpenTabCandidates()).tabs, [await platform.getCurrentPage()]);
  assert.equal(candidates.savedCount, 1);
  assert.equal(candidates.candidates.length, 2);
});
