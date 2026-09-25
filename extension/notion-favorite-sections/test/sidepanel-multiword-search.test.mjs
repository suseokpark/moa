import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../test-support/candidate-picker-fixture.mjs";
import { validateCatalog } from "../src/link-library.js";

function searchFixture() {
  const f = fixture(), catalog = structuredClone(f.context.initial.catalog);
  catalog.libraries[0].groups[0].links = [
    { id: "rail", title: "철도 여행 일정", url: "https://rail.example.org/schedule?year=2026#spring", icon: "", provider: "generic" },
    { id: "flight", title: "항공 여행 일정", url: "https://air.example.org/schedule", icon: "", provider: "generic" }
  ];
  f.setCatalog(catalog, 7); f.context.initial = { catalog, revision: 7, canUndo: true }; f.run("adopt(initial)");
  return f;
}
async function query(f, text) { f.$("search").value = text; await f.$("search").emit("input"); }
const ids = f => f.$("tree").querySelectorAll("[data-link-id]").map(row => row.dataset.linkId);

test("main tree finds the same title when query words are entered in reverse order", async () => {
  const f = searchFixture(), before = structuredClone(f.run("state"));
  await query(f, "철도 여행"); assert.deepEqual(ids(f), ["rail"]);
  await query(f, "여행 철도"); assert.deepEqual(ids(f), ["rail"]);
  assert.equal(f.$("link-count").textContent, "검색 결과 1개 / 전체 2개");
  assert.deepEqual(structuredClone(f.run("state")), before); assert.equal(f.actions.length, 0);
});

test("query terms can be split across one link title, URL and its ancestor group path", async () => {
  const f = searchFixture(), catalog = structuredClone(f.run("state.catalog"));
  const rail = catalog.libraries[0].groups[0].links.shift();
  const parent = catalog.libraries[0].groups[1]; parent.name = "Research"; parent.groups[0].name = "교통";
  parent.groups[0].links.push(rail); f.context.updated = { catalog, revision: 7 }; f.run("adopt(updated)");
  await query(f, "2026 교통 여행 RESEARCH");
  assert.deepEqual(ids(f), ["rail"]);
  assert.deepEqual(f.$("tree").querySelectorAll("[data-group-id]").map(row => row.dataset.groupId), ["parent", "destination"]);
  assert.equal(f.$("link-count").textContent, "검색 결과 1개 / 전체 2개");
  assert.equal(f.$("tree").querySelector("a").href, rail.url);
  assert.equal(f.actions.length, 0);
});

for (const text of ["  RAIL  여행  ", "여행\tRAIL", "rail\u3000여행\u00a0rail", "여행\nrail"]) {
  test(`whitespace, mixed case and repeated terms: ${JSON.stringify(text)}`, async () => {
    const f = searchFixture(); await query(f, text);
    assert.deepEqual(ids(f), ["rail"]); assert.equal(f.$("search").value, text);
    assert.equal(f.actions.length, 0);
  });
}

test("every query term must match and clearing an unmatched query restores the ordinary list", async () => {
  const f = searchFixture(); await query(f, "rail 여행 없는단어");
  assert.deepEqual(ids(f), []); assert.equal(f.$("link-count").textContent, "검색 결과 0개 / 전체 2개");
  const recover = f.$("tree").querySelectorAll("button").find(item => item.textContent === "검색 지우고 전체 보기");
  assert.ok(recover); await recover.emit("click");
  assert.equal(f.$("search").value, ""); assert.deepEqual(ids(f), ["rail", "flight"]);
  assert.ok(f.document.activeElement === f.$("search")); assert.equal(f.actions.length, 0);
});

test("opening a multiword result preserves the exact URL and one-click navigation contract", async () => {
  const f = searchFixture(); await query(f, "2026 철도");
  const anchor = f.$("tree").querySelector("a"); assert.ok(anchor);
  await anchor.emit("click");
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0][0], "https://rail.example.org/schedule?year=2026#spring");
  assert.equal(f.actions.length, 0); assert.equal(f.$("search").value, "2026 철도");
});

test("10,000 synthetic links under 32 levels keep one reversed-word result, its path and original data", async () => {
  const f = fixture(), catalog = structuredClone(f.context.initial.catalog);
  const links = Array.from({ length: 10000 }, (_, i) => ({ id: `large-${i}`, title: `Needle ${i}`, url: `https://example.org/item/${i}`, icon: "", provider: "generic" }));
  let tree = { id: "level-32", name: "Level 32", groups: [], links, collapsed: true };
  for (let depth = 31; depth > 0; depth--) tree = { id: `level-${depth}`, name: `Level ${depth}`, groups: [tree], links: [], collapsed: true };
  catalog.libraries[0].groups[0].links = []; catalog.libraries[0].groups.splice(1, Infinity, tree);
  f.context.large = { catalog: validateCatalog(catalog), revision: 7, canUndo: true }; f.run("adopt(large)");
  const before = structuredClone(f.run("state"));
  await query(f, "9999 needle"); assert.deepEqual(ids(f), ["large-9999"]);
  assert.equal(f.$("tree").querySelectorAll("[data-group-id]").length, 32);
  assert.equal(f.$("link-count").textContent, "검색 결과 1개 / 전체 10000개");
  assert.deepEqual(structuredClone(f.run("state")), before); assert.equal(f.actions.length, 0);
});
