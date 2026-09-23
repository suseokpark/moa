import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Expose the shipped renderer's validator at its real normalization seam,
// without duplicating its parsing logic or needing a live Notion account.
const source = await readFile(new URL("../src/favorite-tree-view.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(await readFile(new URL("../src/notion-url.js", import.meta.url), "utf8"), context);
vm.runInContext(source.replace("    createFavoriteTreeView\n  });",
  "    createFavoriteTreeView, normalizePageNavigation\n  });"), context);
const view = context.NotionFavoriteSections.view;
const id = "0123456789abcdef0123456789abcdef";

test("shipped navigation renderer accepts underscore and percent-encoded page IDs without rewriting URLs", () => {
  for (const href of [
    `https://app.notion.com/p/another-workspace/Planning_${id}?pvs=4#notes`,
    `https://app.notion.com/p/acme/%30${id.slice(1)}`,
    `https://app.notion.com/p/acme/%E8%A8%88%E7%94%BB-${id}`,
  ]) {
    const result = view.normalizePageNavigation({ currentPage: { pageId: id, href, title: "Page" }, scopeSafe: false });
    assert.equal(result.currentPage.href, href);
  }
});

test("shipped navigation renderer fails closed for wrong IDs, origins, ports, credentials and encoded separators", () => {
  for (const href of [
    `https://app.notion.com:444/${id}`, `https://evil.example/${id}`,
    `https://user@app.notion.com/${id}`, `http://app.notion.com/${id}`,
    `https://app.notion.com/?p=${id}`, `https://app.notion.com/p/acme/x%2F${id}`,
    `https://app.notion.com/p/acme/x%5C${id}`, `https://app.notion.com/%ZZ-${id}`,
    "https://app.notion.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "javascript:alert(1)",
  ]) {
    const result = view.normalizePageNavigation({ currentPage: { pageId: id, href, title: "Page" }, scopeSafe: false });
    assert.equal(result.currentPage.href, null, href);
  }
});

test("shared URL selection retains scoped routes, stable ties and never guesses an unknown route", () => {
  const urls = context.NotionFavoriteSections.urls;
  const generic = `https://app.notion.com/${id}`;
  const scoped = `https://app.notion.com/p/acme/Planning_${id}?pvs=4#notes`;
  const renamed = `https://app.notion.com/p/new-name/${id}`;
  assert.equal(urls.preferredPageUrl(id, [generic, scoped]), scoped);
  assert.equal(urls.preferredPageUrl(id, [renamed, scoped]), renamed);
  assert.equal(urls.preferredPageUrl(id, [null, "javascript:alert(1)"]), null);
  assert.equal(urls.preferredPageUrl(id, [generic]), generic, "actual observed ID-only URL remains valid");
  assert.equal(urls.safePageUrl(scoped, { pageId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), null);
  assert.equal(urls.safePageUrl(`https://www.notion.so/${id}`), null);
  assert.equal(urls.safePageUrl(`https://www.notion.so/${id}`, { allowLegacyHost: true }), `https://www.notion.so/${id}`);
  assert.equal(urls.safePageUrl(scoped + "x".repeat(4096)), null);
});

test("adapter and renderer share acceptance and preserve 84 cross-workspace URL variants", async () => {
  vm.runInContext(await readFile(new URL("../src/notion-sidebar-adapter.js", import.meta.url), "utf8"), context);
  const adapter = context.NotionFavoriteSections.adapter;
  const pages = [id, `Page-${id}`, `Planning_${id}`, `%30${id.slice(1)}`, `계획-${id}`, "01234567-89ab-cdef-0123-456789abcdef", `${id}/`];
  let count = 0;
  for (const slug of ["acme", "another-workspace", "team_42", "개인공간"]) {
    for (const page of pages) for (const suffix of ["", "?pvs=4#notes", `?v=${id}`]) {
      const href = new URL(`https://app.notion.com/p/${slug}/${page}${suffix}`).href;
      const navigation = adapter.readPageNavigation({ location: new URL(href), title: "Page | Notion", querySelectorAll: () => [] });
      assert.equal(navigation.currentPage.href, href);
      assert.equal(view.normalizePageNavigation(navigation).currentPage.href, href);
      count += 1;
    }
  }
  assert.equal(count, 84);
});
