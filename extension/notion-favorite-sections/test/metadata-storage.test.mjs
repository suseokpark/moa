import assert from "node:assert/strict";
import test from "node:test";
import * as contract from "../src/storage-contract.js";

const PAGE_A = "0123456789abcdef0123456789abcdef";
const PAGE_B = "fedcba9876543210fedcba9876543210";
const PAGE_C = "cccccccccccccccccccccccccccccccc";
const ENTRY_A = { pageId: PAGE_A, title: "Decisions", icon: "📋" };
const ENTRY_B = { pageId: PAGE_B, title: "메모", icon: "" };
const GET = "NFS_METADATA_GET";
const MERGE = "NFS_METADATA_MERGE";

function workspace(pageIds = [PAGE_A, PAGE_B]) {
  return { schemaVersion: 1, groups: [{
    id: "group", name: "Group", color: "", emoji: "", collapsed: false, order: 0, system: true,
    sections: [{
      id: "section", name: "Section", color: "", emoji: "", collapsed: false, order: 0, system: true,
      favorites: pageIds.map((pageId, order) => ({ pageId, order, dormant: false, updatedAt: "2026-09-21T00:00:00.000Z" }))
    }]
  }] };
}

let harnessSequence = 0;
async function background(t) {
  const values = new Map();
  const writes = [];
  const broadcasts = [];
  let listener;
  let connect;
  const sender = { id: "extension", url: "https://app.notion.com/page", tab: {} };
  globalThis.chrome = {
    runtime: {
      id: "extension",
      onMessage: { addListener(value) { listener = value; } },
      onConnect: { addListener(value) { connect = value; } }
    },
    storage: { local: {
      async setAccessLevel() {},
      async get(key) { return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}; },
      async set(entries) {
        writes.push(structuredClone(entries));
        for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value));
      },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); }
    } }
  };
  t.after(() => { delete globalThis.chrome; });
  // Historical cache contracts remain covered without enabling the retired
  // content-script service in the shipped browser-only worker.
  await import(`../test-support/legacy-notion-background.js?metadata-test=${++harnessSequence}`);
  connect({ name: "NFS_WORKSPACE_SYNC", sender, postMessage(message) { broadcasts.push(structuredClone(message)); }, disconnect() {}, onDisconnect: { addListener() {} } });
  function request(type, payload, requestSender = sender) {
    return new Promise(resolve => listener({ type, payload }, requestSender, resolve));
  }
  return { values, writes, broadcasts, request,
    set: (workspaceKey, pageIds, expectedRevision = 0) => request("NFS_STORAGE_SET", { workspaceKey, workspace: workspace(pageIds), expectedRevision }),
    get: workspaceKey => request(GET, { workspaceKey }),
    merge: (workspaceKey, entries) => request(MERGE, { workspaceKey, entries })
  };
}

test("metadata contract accepts only bounded display fields and normalized IDs", () => {
  assert.deepEqual(contract.validateStorageRequest({ type: GET, payload: { workspaceKey: "alpha" } }), {
    type: GET, workspaceKey: "alpha"
  });
  assert.deepEqual(contract.validateStorageRequest({ type: MERGE, payload: { workspaceKey: "alpha", entries: [ENTRY_A] } }), {
    type: MERGE, workspaceKey: "alpha", entries: [ENTRY_A]
  });
  assert.deepEqual(contract.METADATA_MESSAGE_TYPES, { GET, MERGE });
  for (const entry of [
    { ...ENTRY_A, pageId: PAGE_A.toUpperCase() },
    { ...ENTRY_A, pageId: "01234567-89ab-cdef-0123-456789abcdef" },
    { ...ENTRY_A, title: "" },
    { ...ENTRY_A, title: "   " },
    { ...ENTRY_A, title: "x".repeat(301) },
    { ...ENTRY_A, title: "bad\nname" },
    { ...ENTRY_A, title: "bad\u0085name" },
    { ...ENTRY_A, icon: "x".repeat(65) },
    { ...ENTRY_A, icon: "bad\u0000" },
    { pageId: PAGE_A, title: "Decisions" },
    { ...ENTRY_A, href: "https://app.notion.com/private" },
    { ...ENTRY_A, body: "not display metadata" }
  ]) {
    assert.throws(() => contract.validateStorageRequest({ type: MERGE, payload: { workspaceKey: "alpha", entries: [entry] } }), contract.StorageContractError);
  }
  for (const message of [
    { type: GET, payload: { workspaceKey: "alpha", entries: [] } },
    { type: MERGE, payload: { workspaceKey: "alpha" } },
    { type: MERGE, payload: { workspaceKey: "alpha", entries: [ENTRY_A, ENTRY_A] } },
    { type: MERGE, payload: { workspaceKey: "alpha", entries: Array(10_001).fill(ENTRY_A) } }
  ]) assert.throws(() => contract.validateStorageRequest(message), contract.StorageContractError);
});

test("display metadata persists separately, merges omitted entries and skips unchanged writes", async t => {
  const h = await background(t);
  assert.deepEqual(await h.get("alpha"), { ok: true, metadata: [] });
  assert.equal((await h.set("alpha")).revision, 1);
  assert.deepEqual(await h.merge("alpha", [ENTRY_A, ENTRY_B]), { ok: true, metadata: [ENTRY_A, ENTRY_B] });
  const renamed = { ...ENTRY_A, title: "Updated decisions", icon: "✅" };
  assert.deepEqual(await h.merge("alpha", [renamed]), { ok: true, metadata: [renamed, ENTRY_B] });
  assert.deepEqual(await h.get("alpha"), { ok: true, metadata: [renamed, ENTRY_B] });
  const writeCount = h.writes.length;
  await h.merge("alpha", [{ icon: "✅", title: "Updated decisions", pageId: PAGE_A }]);
  await h.merge("alpha", []);
  assert.equal(h.writes.length, writeCount);
  assert.deepEqual(h.values.get("nfs:metadata:alpha"), [renamed, ENTRY_B]);
  assert.deepEqual(await h.request("NFS_STORAGE_GET", { workspaceKey: "alpha" }), { ok: true, revision: 1, workspace: workspace() });
  assert.equal(h.broadcasts.length, 1);
});

test("managed metadata stores and restores its validated workspace route without changing tree revision", async t => {
  const h = await background(t);
  await h.set("alpha", [PAGE_A]);
  const routed = { ...ENTRY_A, href: `https://app.notion.com/p/alpha/${PAGE_A}?pvs=4#notes` };
  assert.deepEqual(await h.merge("alpha", [routed]), { ok: true, metadata: [routed] });
  assert.deepEqual(await h.get("alpha"), { ok: true, metadata: [routed] });
  assert.deepEqual(h.values.get("nfs:metadata:alpha"), [routed]);
  assert.equal(h.values.get("nfs:workspace:alpha").revision, 1);
  assert.deepEqual(h.values.get("nfs:workspace:alpha").workspace, workspace([PAGE_A]));
});

test("metadata merges keep an observed scoped route when later tabs omit it or send an ID-only address", async t => {
  const h = await background(t);
  await h.set("alpha", [PAGE_A]);
  const href = `https://app.notion.com/p/alpha/${PAGE_A}`;
  await h.merge("alpha", [{ ...ENTRY_A, href }]);
  const updated = { ...ENTRY_A, title: "Updated label" };
  assert.deepEqual((await h.merge("alpha", [updated])).metadata, [{ ...updated, href }]);
  assert.deepEqual((await h.merge("alpha", [{ ...updated, href: `https://app.notion.com/${PAGE_A}` }])).metadata, [{ ...updated, href }]);
  const newer = `https://app.notion.com/p/renamed-workspace/${PAGE_A}`;
  assert.deepEqual((await h.merge("alpha", [{ ...updated, href: newer }])).metadata, [{ ...updated, href: newer }]);
  assert.equal(h.values.get("nfs:workspace:alpha").revision, 1);
});

test("metadata route validation rejects untrusted, mismatched, relative and oversized addresses atomically", async t => {
  const h = await background(t);
  await h.set("alpha", [PAGE_A]);
  const saved = { ...ENTRY_A, href: `https://app.notion.com/p/alpha/${PAGE_A}` };
  await h.merge("alpha", [saved]);
  const count = h.writes.length;
  for (const href of [
    `http://app.notion.com/${PAGE_A}`, `https://www.notion.so/${PAGE_A}`, `https://evil.example/${PAGE_A}`,
    `https://app.notion.com.evil.example/${PAGE_A}`, `https://user:secret@app.notion.com/${PAGE_A}`,
    `https://app.notion.com:444/${PAGE_A}`, `https://app.notion.com/${PAGE_B}`,
    `https://app.notion.com/?p=${PAGE_A}`, `/p/alpha/${PAGE_A}`, `?p=${PAGE_A}`,
    `https://app.notion.com/p/alpha%2Fescape/${PAGE_A}`, `https://app.notion.com/%ZZ/${PAGE_A}`,
    `https://app.notion.com/p/alpha/${PAGE_A}\u0085`, `https://app.notion.com/${PAGE_A}?long=${"x".repeat(4096)}`,
    "", null, undefined
  ]) {
    const result = await h.merge("alpha", [{ ...ENTRY_A, href }]);
    assert.equal(result.ok, false, String(href));
    assert.deepEqual((await h.get("alpha")).metadata, [saved]);
  }
  assert.equal(h.writes.length, count);
});

test("cached routes remain workspace-scoped, managed-only, and are pruned on removal and reset", async t => {
  const h = await background(t);
  await h.set("alpha", [PAGE_A]);
  await h.set("beta", [PAGE_A]);
  const alpha = { ...ENTRY_A, href: `https://app.notion.com/p/alpha/${PAGE_A}` };
  const beta = { ...ENTRY_A, href: `https://app.notion.com/p/beta/${PAGE_A}` };
  const orphan = { ...ENTRY_B, href: `https://app.notion.com/p/alpha/${PAGE_B}` };
  assert.deepEqual((await h.merge("alpha", [alpha, orphan])).metadata, [alpha]);
  assert.deepEqual((await h.merge("beta", [beta])).metadata, [beta]);
  assert.deepEqual((await h.get("alpha")).metadata, [alpha]);
  assert.deepEqual((await h.get("beta")).metadata, [beta]);
  await h.set("alpha", [], 1);
  assert.deepEqual((await h.merge("alpha", [alpha])).metadata, []);
  assert.deepEqual((await h.get("beta")).metadata, [beta]);
  assert.equal((await h.request("NFS_STORAGE_RESET", { workspaceKey: "beta" })).ok, true);
  assert.deepEqual((await h.get("beta")).metadata, []);
});

test("successful tree changes prune removed labels and queued late merges cannot restore them", async t => {
  const h = await background(t);
  await h.set("alpha");
  await h.merge("alpha", [ENTRY_A, ENTRY_B]);
  assert.equal((await h.set("alpha", [], 0)).conflict, true);
  assert.deepEqual((await h.get("alpha")).metadata, [ENTRY_A, ENTRY_B]);
  const [saved, lateMerge] = await Promise.all([
    h.set("alpha", [PAGE_B], 1),
    h.merge("alpha", [ENTRY_A])
  ]);
  assert.equal(saved.revision, 2);
  assert.deepEqual(lateMerge, { ok: true, metadata: [ENTRY_B] });
  assert.deepEqual(h.values.get("nfs:metadata:alpha"), [ENTRY_B]);
  await h.set("alpha", [PAGE_A, PAGE_B], 2);
  assert.deepEqual((await h.get("alpha")).metadata, [ENTRY_B]);
  await h.set("alpha", [], 3);
  assert.deepEqual(h.values.get("nfs:metadata:alpha") || [], []);
  assert.deepEqual(await h.merge("alpha", [ENTRY_A]), { ok: true, metadata: [] });
});

test("RESET clears labels and a queued stale merge cannot repopulate the cache", async t => {
  const h = await background(t);
  await h.set("alpha");
  await h.merge("alpha", [ENTRY_A]);
  assert.deepEqual(await h.request("NFS_STORAGE_RESET", { workspaceKey: "alpha" }), { ok: true, revision: 0 });
  assert.equal(h.values.has("nfs:metadata:alpha"), false);
  await h.set("alpha");
  assert.deepEqual((await h.get("alpha")).metadata, []);
  await h.merge("alpha", [ENTRY_A]);
  const [, late] = await Promise.all([
    h.request("NFS_STORAGE_RESET", { workspaceKey: "alpha" }),
    h.merge("alpha", [ENTRY_A])
  ]);
  assert.deepEqual(late, { ok: true, metadata: [] });
  assert.equal(h.values.has("nfs:metadata:alpha"), false);
});

test("metadata reads and merges stay within each workspace's current managed IDs", async t => {
  const h = await background(t);
  await h.set("alpha", [PAGE_A]);
  await h.set("beta", [PAGE_B]);
  const orphan = { pageId: PAGE_C, title: "Unmanaged page", icon: "" };
  h.values.set("nfs:metadata:alpha", [ENTRY_A, orphan]);
  assert.deepEqual(await h.get("alpha"), { ok: true, metadata: [ENTRY_A] });
  assert.deepEqual(await h.merge("alpha", [ENTRY_B, orphan]), { ok: true, metadata: [ENTRY_A] });
  assert.deepEqual(await h.merge("beta", [ENTRY_A, ENTRY_B]), { ok: true, metadata: [ENTRY_B] });
  assert.deepEqual(await h.get("missing"), { ok: true, metadata: [] });
  const writesBefore = h.writes.length;
  assert.deepEqual(await h.merge("missing", [ENTRY_A]), { ok: true, metadata: [] });
  assert.equal(h.writes.length, writesBefore);
  assert.equal((await h.request(GET, { workspaceKey: "alpha" }, { id: "other-extension", tab: {}, url: "https://app.notion.com/" })).ok, false);
  assert.deepEqual((await h.get("alpha")).metadata, [ENTRY_A]);
});

test("corrupt display caches degrade to empty without blocking tree reads or changes", async t => {
  const h = await background(t);
  await h.set("alpha", [PAGE_A]);
  for (const corrupt of [null, "invalid", {}, [ENTRY_A, { pageId: PAGE_B }], [{ ...ENTRY_A, url: "https://example.com" }]]) {
    h.values.set("nfs:metadata:alpha", corrupt);
    assert.deepEqual(await h.get("alpha"), { ok: true, metadata: [] });
    assert.equal((await h.request("NFS_STORAGE_GET", { workspaceKey: "alpha" })).revision, 1);
  }
  assert.deepEqual(await h.merge("alpha", [ENTRY_A]), { ok: true, metadata: [ENTRY_A] });
  h.values.set("nfs:metadata:alpha", { unexpected: "cache" });
  assert.equal((await h.set("alpha", [], 1)).revision, 2);
  assert.deepEqual(h.values.get("nfs:metadata:alpha"), []);
});

test("metadata writes reject oversized serialized requests and aggregate caches without changing stored state", async t => {
  const h = await background(t);
  const entries = Array.from({ length: 6500 }, (_, index) => ({
    pageId: index.toString(16).padStart(32, "0"), title: "界".repeat(300), icon: ""
  }));
  const tree = workspace([]);
  const section = tree.groups[0].sections[0];
  tree.groups[0].sections = Array.from({ length: 13 }, (_, index) => ({
    ...section, id: `section-${index}`, order: index,
    favorites: workspace(entries.slice(index * 500, (index + 1) * 500).map(entry => entry.pageId)).groups[0].sections[0].favorites
  }));
  assert.equal((await h.request("NFS_STORAGE_SET", { workspaceKey: "alpha", workspace: tree, expectedRevision: 0 })).ok, true);
  const requestFailure = await h.merge("alpha", entries);
  assert.equal(requestFailure.ok, false);
  assert.match(requestFailure.error, /storage size/u);
  const initial = entries.slice(0, 3250);
  assert.equal((await h.merge("alpha", initial)).ok, true);
  const writesBefore = h.writes.length;
  const aggregateFailure = await h.merge("alpha", entries.slice(3250));
  assert.equal(aggregateFailure.ok, false);
  assert.match(aggregateFailure.error, /storage size/u);
  assert.equal(h.writes.length, writesBefore);
  assert.deepEqual((await h.get("alpha")).metadata, initial);
  assert.equal((await h.request("NFS_STORAGE_GET", { workspaceKey: "alpha" })).revision, 1);
});
