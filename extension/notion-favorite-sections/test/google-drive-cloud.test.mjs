import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createCatalog, validateCatalog } from "../src/link-library.js";
import { FAVMOA_STORAGE_KEY } from "../src/favmoa-service.js";
import { createGoogleDriveCloud, GOOGLE_CONNECTION_KEY, MAX_BACKUP_BYTES } from "../src/google-drive-cloud.js";

const ACCOUNT = { id: "google-user-1", email: "person@example.com" };
const TOKEN = "TEST_TOKEN_ONLY_NEVER_PERSIST";
const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const MANIFEST = { oauth2: { client_id: "123-testchromeclient.apps.googleusercontent.com", scopes: ["openid", "email", SCOPE] } };
const RELEASE_MANIFEST = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const DEFERRED_CONFIG = JSON.parse(readFileSync(new URL("../config/google-cloud.deferred.json", import.meta.url), "utf8"));
const DEFERRED_MANIFEST = { ...RELEASE_MANIFEST, oauth2: DEFERRED_CONFIG.oauth2 };
const RELEASE_CLIENT_ID = "24454578838-6nqb1s33u6djs6inpn2jud1nfq0ojevn.apps.googleusercontent.com";
const RELEASE_EXTENSION_ID = "ebbgmhdbonpillbfjapebljagnbjembj";
const sender = { id: "abcdefghijklmnopabcdefghijklmnop", url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/sidepanel/sidepanel.html" };
const DATE = "2026-09-22T12:00:00.000Z";
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

function metadata(overrides = {}) {
  return { id: "file-1", name: "favmoa-backup.json", createdTime: DATE, size: "1500", mimeType: "application/json", appProperties: { favmoaType: "backup-v1" }, spaces: ["appDataFolder"], parents: ["opaque-app-folder-id"], ...overrides };
}
function backup(overrides = {}) { return { format: "favmoa-backup", version: 1, createdAt: DATE, catalog: createCatalog(), ...overrides }; }

function fixture({ manifest = MANIFEST, runtimeId = sender.id, initial = {}, route, getAuthToken, timeoutMs = 1000, authTimeoutMs = 1000 } = {}) {
  const values = structuredClone(initial);
  const calls = [];
  const authCalls = [];
  const removed = [];
  let cleared = 0;
  const trustedSender = { id: runtimeId, url: `chrome-extension://${runtimeId}/sidepanel/sidepanel.html` };
  const api = {
    runtime: { id: runtimeId, getManifest: () => manifest },
    identity: {
      async getAuthToken(options) { authCalls.push(options); return getAuthToken ? getAuthToken(options) : { token: TOKEN, grantedScopes: ["openid", "email", SCOPE] }; },
      async removeCachedAuthToken({ token }) { removed.push(token); },
      async clearAllCachedAuthTokens() { cleared += 1; }
    },
    storage: { local: {
      async setAccessLevel(options) { assert.equal(options.accessLevel, "TRUSTED_CONTEXTS"); },
      async get(key) { return values[key] === undefined ? {} : { [key]: structuredClone(values[key]) }; },
      async set(data) { Object.assign(values, structuredClone(data)); }
    } }
  };
  const cloud = createGoogleDriveCloud({ chrome: api, now: () => new Date(DATE), timeoutMs, authTimeoutMs, fetch: async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url, options });
    assert.equal(parsed.origin, "https://www.googleapis.com");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    if (route) {
      const custom = await route(parsed, options, values);
      if (custom !== undefined) return custom;
    }
    if (parsed.pathname === "/oauth2/v3/userinfo") return json({ sub: ACCOUNT.id, email: ACCOUNT.email, email_verified: true });
    if (parsed.pathname === "/upload/drive/v3/files") return json({ id: "new-backup", name: "ignored-server-name", createdTime: DATE });
    if (parsed.pathname === "/drive/v3/files") return json({ files: [metadata()] });
    if (parsed.searchParams.get("alt") === "media") return json(backup());
    return json(metadata());
  } });
  return { cloud, values, api, calls, authCalls, removed, get cleared() { return cleared; },
    send: (type, fields = {}, who = trustedSender) => cloud.handle({ type: `FAVMOA_CLOUD_${type}`, ...fields }, who),
    connect: () => cloud.handle({ type: "FAVMOA_CLOUD_CONNECT" }, trustedSender)
  };
}

test("deferred public OAuth configuration is retained outside the local-only release manifest", async () => {
  const derivedId = createHash("sha256").update(Buffer.from(RELEASE_MANIFEST.key, "base64")).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/gu, value => String.fromCharCode(97 + Number.parseInt(value, 16)));
  assert.equal(derivedId, RELEASE_EXTENSION_ID);
  assert.equal(RELEASE_MANIFEST.oauth2, undefined);
  assert.equal(DEFERRED_CONFIG.status, "deferred");
  assert.equal(DEFERRED_CONFIG.oauth2.client_id, RELEASE_CLIENT_ID);
  assert.deepEqual(DEFERRED_CONFIG.oauth2.scopes, ["openid", "email", SCOPE]);
  assert.deepEqual(Object.keys(DEFERRED_CONFIG.oauth2), ["client_id", "scopes"]);
  const envelope = { revision: 7, catalog: createCatalog() };
  const f = fixture({ manifest: DEFERRED_MANIFEST, runtimeId: derivedId, initial: { [FAVMOA_STORAGE_KEY]: envelope } });
  const status = await f.send("STATUS");
  assert.deepEqual(status, { ok: true, configured: true, connected: false, account: null, extensionId: RELEASE_EXTENSION_ID, clientId: RELEASE_CLIENT_ID,
    version: RELEASE_MANIFEST.version, identityAvailable: true, configurationVerified: false, authPending: false });
  assert.equal(f.authCalls.length, 0);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.values, { [FAVMOA_STORAGE_KEY]: envelope });
});

test("deferred OAuth factory connection uses mocks and reads identity without creating a Drive backup", async () => {
  const envelope = { revision: 7, catalog: createCatalog() };
  const f = fixture({ manifest: DEFERRED_MANIFEST, runtimeId: RELEASE_EXTENSION_ID, initial: { [FAVMOA_STORAGE_KEY]: envelope } });
  await f.send("STATUS");
  assert.equal(f.authCalls.length, 0);
  const result = await f.connect();
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.connected, true);
  assert.equal(result.clientId, RELEASE_CLIENT_ID);
  assert.deepEqual(result.account, ACCOUNT);
  // Mock factory coverage keeps the deferred implementation recoverable.
  assert.deepEqual(f.authCalls, [{ interactive: true, enableGranularPermissions: true }]);
  assert.deepEqual(f.calls.map(call => [new URL(call.url).pathname, call.options.method]), [["/oauth2/v3/userinfo", "GET"]]);
  assert.deepEqual(f.values[FAVMOA_STORAGE_KEY], envelope);
  assert.equal(f.values[GOOGLE_CONNECTION_KEY].lastBackupAt, undefined);
  await f.send("STATUS");
  assert.equal(f.authCalls.length, 1);
  assert.equal(f.calls.length, 1);
});

test("cancelled deferred OAuth consent preserves all local links and creates no connection or backup", async () => {
  const envelope = { revision: 7, catalog: createCatalog() };
  const f = fixture({ manifest: DEFERRED_MANIFEST, runtimeId: RELEASE_EXTENSION_ID, initial: { [FAVMOA_STORAGE_KEY]: envelope },
    getAuthToken: () => { throw new Error("The user did not approve access."); } });
  const result = await f.connect();
  assert.equal(result.code, "AUTH_CANCELLED");
  assert.equal((await f.send("STATUS")).connected, false);
  assert.deepEqual(f.values, { [FAVMOA_STORAGE_KEY]: envelope });
  assert.equal(f.calls.length, 0);
});

test("status is network-free and missing OAuth configuration never invokes authentication", async () => {
  const f = fixture({ manifest: {} });
  const status = await f.send("STATUS");
  assert.equal(status.ok, true);
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal(status.extensionId, sender.id);
  assert.equal(status.clientId, "");
  const result = await f.connect();
  assert.equal(result.code, "CONFIG_REQUIRED");
  assert.equal(result.extensionId, sender.id);
  assert.equal(f.authCalls.length, 0);
  assert.equal(f.calls.length, 0);
});

test("only exact trusted sidepanel requests are handled and unrelated protocols are ignored", async () => {
  const f = fixture();
  assert.equal(f.cloud.accepts({ type: "FAVMOA_GET" }), false);
  assert.equal(f.cloud.accepts({ type: "FAVMOA_CLOUD_UNKNOWN" }), false);
  const response = await f.send("CONNECT", {}, { ...sender, url: "https://app.notion.com/" });
  assert.equal(response.code, "UNTRUSTED_SENDER");
  assert.equal(f.authCalls.length, 0);
});

test("connect verifies stable Google identity and never persists or returns token", async () => {
  const f = fixture();
  const result = await f.connect();
  assert.equal(result.ok, true);
  assert.equal(result.connected, true);
  assert.deepEqual(result.account, ACCOUNT);
  assert.deepEqual(f.authCalls, [{ interactive: true, enableGranularPermissions: true }]);
  assert.deepEqual(Object.keys(f.values), [GOOGLE_CONNECTION_KEY]);
  assert.equal(JSON.stringify(f.values).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  await f.send("STATUS");
  assert.equal(f.calls.length, 1);
});

test("granular permission denial removes partial token and cannot mark connected", async () => {
  const f = fixture({ getAuthToken: () => ({ token: TOKEN, grantedScopes: ["openid", "email"] }) });
  const result = await f.connect();
  assert.equal(result.code, "PERMISSION_REQUIRED");
  assert.deepEqual(f.removed, [TOKEN]);
  assert.equal((await f.send("STATUS")).connected, false);
  assert.equal(f.calls.length, 0);
});

test("OAuth client mismatch gives actionable safe diagnostic without raw response", async () => {
  const f = fixture({ getAuthToken: () => { throw new Error(`bad client id secret detail ${TOKEN}`); } });
  const result = await f.connect();
  assert.equal(result.code, "OAUTH_CONFIG");
  assert.match(result.error, /확장 ID/u);
  assert.equal(result.error.includes(TOKEN), false);
});

test("manual upload validates revision, verifies account and appends immutable appdata backup", async () => {
  const f = fixture({ initial: { [FAVMOA_STORAGE_KEY]: { revision: 3, catalog: createCatalog() } } });
  await f.connect();
  const result = await f.send("UPLOAD", { expectedRevision: 3, accountId: ACCOUNT.id });
  assert.equal(result.ok, true);
  assert.equal(result.revision, 3);
  assert.equal(result.backup.id, "new-backup");
  assert.equal(result.lastBackupAt, DATE);
  const uploads = f.calls.filter(call => call.options.method === "POST");
  assert.equal(uploads.length, 1);
  const call = uploads[0];
  const url = new URL(call.url);
  assert.equal(url.pathname, "/upload/drive/v3/files");
  assert.equal(url.searchParams.get("uploadType"), "multipart");
  assert.match(call.options.headers["Content-Type"], /^multipart\/related; boundary=favmoa_/u);
  assert.ok(call.options.body.includes('"parents":["appDataFolder"]'));
  assert.ok(call.options.body.includes('"appProperties":{"favmoaType":"backup-v1"}'));
  assert.ok(call.options.body.includes('"format":"favmoa-backup"'));
  assert.equal(call.options.body.includes(TOKEN), false);
  assert.equal(call.options.body.includes(ACCOUNT.email), false);
  assert.equal(f.values[FAVMOA_STORAGE_KEY].revision, 3);
  assert.equal(f.values[GOOGLE_CONNECTION_KEY].lastBackupAt, DATE);
  assert.equal(f.calls.some(call => ["PATCH", "PUT", "DELETE"].includes(call.options.method)), false);
  assert.deepEqual(f.authCalls.map(call => call.interactive), [true, false]);
});

test("stale local revision fails before network and backup is rechecked after identity verification", async () => {
  const f = fixture({ initial: { [FAVMOA_STORAGE_KEY]: { revision: 2, catalog: createCatalog() } } });
  await f.connect();
  const before = f.calls.length;
  assert.equal((await f.send("UPLOAD", { expectedRevision: 1, accountId: ACCOUNT.id })).code, "CONFLICT");
  assert.equal(f.calls.length, before);
  let userInfoCalls = 0;
  const changed = fixture({ initial: { [FAVMOA_STORAGE_KEY]: { revision: 1, catalog: createCatalog() } }, route: (url, options, values) => {
    if (url.pathname === "/oauth2/v3/userinfo" && ++userInfoCalls === 2) values[FAVMOA_STORAGE_KEY].revision = 2;
  } });
  await changed.connect();
  assert.equal((await changed.send("UPLOAD", { expectedRevision: 1, accountId: ACCOUNT.id })).code, "CONFLICT");
  assert.equal(changed.calls.some(call => call.options.method === "POST"), false);
});

test("corrupt stored envelopes are never silently backed up as an empty catalog", async () => {
  for (const value of [null, false, { revision: -1, catalog: createCatalog() }, { revision: 0, catalog: {} }]) {
    const f = fixture({ initial: { [FAVMOA_STORAGE_KEY]: value } });
    await f.connect();
    const before = f.calls.length;
    assert.equal((await f.send("UPLOAD", { expectedRevision: 0, accountId: ACCOUNT.id })).code, "INVALID_CATALOG");
    assert.equal(f.calls.length, before);
    assert.deepEqual(f.values[FAVMOA_STORAGE_KEY], value);
  }
});

test("a valid local catalog between 4 and 5MiB cannot upload or modify local data", async () => {
  const catalog = createCatalog();
  catalog.libraries[0].groups[0].links = Array.from({ length: 6800 }, (_, index) => ({ id: `link-${index}`, title: `Example ${index}`, url: `https://example.com/${index}/${"x".repeat(530)}`, icon: "", provider: "generic" }));
  const valid = validateCatalog(catalog);
  const size = new TextEncoder().encode(JSON.stringify(valid)).length;
  assert.ok(size > MAX_BACKUP_BYTES && size < 5 * 1024 * 1024, `Expected 4–5MiB, got ${size}`);
  const f = fixture({ initial: { [FAVMOA_STORAGE_KEY]: { revision: 2, catalog: valid } } });
  await f.connect();
  const result = await f.send("UPLOAD", { expectedRevision: 2, accountId: ACCOUNT.id });
  assert.equal(result.code, "BACKUP_TOO_LARGE");
  assert.match(result.error, /JSON 내보내기/u);
  assert.equal(f.calls.some(call => call.options.method === "POST"), false);
  assert.deepEqual(f.values[FAVMOA_STORAGE_KEY], { revision: 2, catalog: valid });
  assert.equal(f.values[GOOGLE_CONNECTION_KEY].lastBackupAt, undefined);
});

test("upload transport failures and server errors report uncertain results with no automatic retry", async () => {
  for (const serverError of [false, true]) {
    const f = fixture({ route: url => {
      if (url.pathname !== "/upload/drive/v3/files") return undefined;
      if (serverError) return json({ error: "private error body" }, 503);
      throw new Error("Network disconnected after sending request");
    } });
    await f.connect();
    const result = await f.send("UPLOAD", { expectedRevision: 0, accountId: ACCOUNT.id });
    assert.equal(result.code, "BACKUP_RESULT_UNKNOWN");
    assert.match(result.error, /목록을 확인/u);
    assert.equal(f.calls.filter(call => call.options.method === "POST").length, 1);
    assert.equal(f.values[FAVMOA_STORAGE_KEY], undefined);
  }
});

test("operations require explicit confirmed account and reject changed Google identity", async () => {
  let otherAccount = false;
  const f = fixture({ route: url => {
    if (otherAccount && url.pathname === "/oauth2/v3/userinfo") return json({ sub: "different-user", email: "other@example.com" });
  } });
  await f.connect();
  assert.equal((await f.send("LIST")).code, "ACCOUNT_CONFIRMATION_REQUIRED");
  assert.equal((await f.send("LIST", { accountId: "unconfirmed-user" })).code, "ACCOUNT_CHANGED");
  otherAccount = true;
  assert.equal((await f.send("LIST", { accountId: ACCOUNT.id })).code, "ACCOUNT_CHANGED");
  assert.equal((await f.send("STATUS")).connected, false);
  assert.equal(f.calls.some(call => new URL(call.url).pathname === "/drive/v3/files"), false);
  assert.deepEqual(f.removed, [TOKEN]);
});

test("401 expires connection and removes cached token without retrying interactively", async () => {
  let expired = false;
  const f = fixture({ route: url => expired && url.pathname === "/oauth2/v3/userinfo" ? json({ error: "private details" }, 401) : undefined });
  await f.connect();
  expired = true;
  const result = await f.send("LIST", { accountId: ACCOUNT.id });
  assert.equal(result.code, "AUTH_REQUIRED");
  assert.equal((await f.send("STATUS")).connected, false);
  assert.deepEqual(f.removed, [TOKEN]);
  assert.deepEqual(f.authCalls.map(value => value.interactive), [true, false]);
});

test("Drive permission/API-disabled response gives helpful diagnosis without copying remote body", async () => {
  const f = fixture({ route: url => url.pathname === "/drive/v3/files" ? json({ error: `private ${TOKEN}` }, 403) : undefined });
  await f.connect();
  const result = await f.send("LIST", { accountId: ACCOUNT.id });
  assert.equal(result.code, "DRIVE_PERMISSION");
  assert.match(result.error, /Drive API/u);
  assert.equal(result.error.includes(TOKEN), false);
});

test("backup listing paginates appData and only offers valid owned backup metadata", async () => {
  const f = fixture({ route: url => {
    if (url.pathname !== "/drive/v3/files") return undefined;
    assert.equal(url.searchParams.get("spaces"), "appDataFolder");
    assert.match(url.searchParams.get("q"), /favmoaType/u);
    return url.searchParams.get("pageToken") ? json({ files: [metadata({ id: "file-2" })] })
      : json({ files: [metadata(), metadata({ id: "wrong-space", spaces: ["drive"] }), metadata({ id: "no-marker", appProperties: {} })], nextPageToken: "page-2" });
  } });
  await f.connect();
  const result = await f.send("LIST", { accountId: ACCOUNT.id });
  assert.equal(result.ok, true);
  assert.deepEqual(result.backups.map(value => value.id), ["file-1", "file-2"]);
  assert.equal(result.hasMore, false);
  assert.deepEqual(Object.keys(result.backups[0]), ["id", "name", "createdTime", "size"]);
});

test("listing is bounded and reports more pages instead of claiming completion", async () => {
  let pages = 0;
  const f = fixture({ route: url => url.pathname === "/drive/v3/files" ? json({ files: [metadata({ id: `file-${++pages}` })], nextPageToken: `page-${pages + 1}` }) : undefined });
  await f.connect();
  const result = await f.send("LIST", { accountId: ACCOUNT.id });
  assert.equal(result.ok, true);
  assert.equal(result.backups.length, 5);
  assert.equal(result.hasMore, true);
  assert.equal(pages, 5);
});

test("reading validates appData space, parent, marker, size and format before returning a preview", async () => {
  const f = fixture({ initial: { [FAVMOA_STORAGE_KEY]: { revision: 6, catalog: createCatalog() } } });
  await f.connect();
  const snapshot = structuredClone(f.values[FAVMOA_STORAGE_KEY]);
  const result = await f.send("READ", { accountId: ACCOUNT.id, fileId: "file-1" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.catalog, createCatalog());
  assert.equal(result.createdAt, DATE);
  assert.deepEqual(f.values[FAVMOA_STORAGE_KEY], snapshot);
  assert.equal(f.calls.filter(call => new URL(call.url).searchParams.get("alt") === "media").length, 1);
});

test("wrong-space, unmarked, parentless or oversized files never download content", async () => {
  for (const override of [{ spaces: ["drive"] }, { spaces: "appDataFolder" }, { appProperties: {} }, { parents: [] }, { parents: ["https://other.example"] }, { size: String(MAX_BACKUP_BYTES + 1) }]) {
    const f = fixture({ route: url => url.pathname === "/drive/v3/files/file-1" ? json(metadata(override)) : undefined });
    await f.connect();
    assert.equal((await f.send("READ", { accountId: ACCOUNT.id, fileId: "file-1" })).ok, false);
    assert.equal(f.calls.some(call => new URL(call.url).searchParams.get("alt") === "media"), false);
  }
});

test("malformed backup or additional secret fields cannot replace local data", async () => {
  for (const payload of [backup({ catalog: {} }), backup({ token: "not-a-valid-backup" }), backup({ format: "another-product" })]) {
    const f = fixture({ route: url => url.searchParams.get("alt") === "media" ? json(payload) : undefined });
    await f.connect();
    assert.equal((await f.send("READ", { accountId: ACCOUNT.id, fileId: "file-1" })).code, "INVALID_BACKUP");
    assert.equal(f.values[FAVMOA_STORAGE_KEY], undefined);
  }
});

test("oversized content is rejected even if metadata incorrectly claims a small file", async () => {
  const f = fixture({ route: url => url.searchParams.get("alt") === "media" ? json(backup(), 200, { "content-length": String(MAX_BACKUP_BYTES + 1) }) : undefined });
  await f.connect();
  assert.equal((await f.send("READ", { accountId: ACCOUNT.id, fileId: "file-1" })).code, "BACKUP_TOO_LARGE");
  assert.equal(f.calls.find(call => new URL(call.url).searchParams.get("alt") === "media").options.signal.aborted, true);
});

test("streamed oversized downloads without content-length are cancelled at the byte limit", async () => {
  let cancelled = false;
  const f = fixture({ route: url => {
    if (url.searchParams.get("alt") !== "media") return undefined;
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(512 * 1024).fill(32)); },
      cancel() { cancelled = true; }
    }), { status: 200 });
  } });
  await f.connect();
  assert.equal((await f.send("READ", { accountId: ACCOUNT.id, fileId: "file-1" })).code, "BACKUP_TOO_LARGE");
  assert.equal(cancelled, true);
  assert.equal(f.values[FAVMOA_STORAGE_KEY], undefined);
});

test("caller supplied URLs cannot redirect authenticated Drive requests", async () => {
  const f = fixture();
  await f.connect();
  const result = await f.send("READ", { accountId: ACCOUNT.id, fileId: "https://evil.example/collect" });
  assert.equal(result.code, "INVALID_REQUEST");
  assert.equal(f.calls.every(call => new URL(call.url).origin === "https://www.googleapis.com"), true);
});

test("disconnect cancels in-flight requests, clears extension auth and preserves local and remote files", async () => {
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const f = fixture({ initial: { [FAVMOA_STORAGE_KEY]: { revision: 4, catalog: createCatalog() } }, route: (url, options) => {
    if (url.pathname !== "/drive/v3/files") return undefined;
    signalStarted();
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  } });
  await f.connect();
  const list = f.send("LIST", { accountId: ACCOUNT.id });
  await started;
  const disconnect = f.send("DISCONNECT");
  assert.equal((await list).code, "CANCELLED");
  const result = await disconnect;
  assert.equal(result.ok, true);
  assert.equal(result.connected, false);
  assert.equal(f.cleared, 1);
  assert.equal(f.values[FAVMOA_STORAGE_KEY].revision, 4);
  assert.equal(f.calls.some(call => call.options.method !== "GET"), false);
});

test("timeouts fail safely without starting retries or mutating a local library", async () => {
  const f = fixture({ timeoutMs: 5, route: (url, options) => url.pathname === "/oauth2/v3/userinfo"
    ? new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })) : undefined });
  assert.equal((await f.connect()).code, "TIMEOUT");
  assert.equal(f.calls.length, 1);
  assert.equal(f.values[FAVMOA_STORAGE_KEY], undefined);
});

test("authorization errors preserve safe actionable categories instead of pretending every failure was cancellation", async () => {
  for (const [message, code] of [
    ["Network connection failed", "AUTH_NETWORK"],
    ["access_denied: application is blocked", "AUTH_DENIED"],
    ["The user is not signed in.", "AUTH_ACCOUNT_UNAVAILABLE"],
    ["The user did not approve access.", "AUTH_CANCELLED"],
    ["Unrecognized provider response", "AUTH_FAILED"]
  ]) {
    const f = fixture({ getAuthToken: () => { throw new Error(`${message} ${TOKEN}`); } });
    const result = await f.connect();
    assert.equal(result.code, code);
    assert.equal(result.stage, "authorization");
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(f.calls.length, 0);
  }
});

test("local diagnostics do not claim Google Cloud verification and status remains responsive during authorization", async () => {
  let releaseToken;
  const tokenPromise = new Promise(resolve => { releaseToken = resolve; });
  const f = fixture({ manifest: { ...MANIFEST, version: "0.1.13" }, getAuthToken: () => tokenPromise });
  const connection = f.connect();
  await new Promise(resolve => setTimeout(resolve, 0));
  try {
    const status = await Promise.race([f.send("STATUS"), new Promise(resolve => setTimeout(() => resolve({ blocked: true }), 30))]);
    assert.equal(status.blocked, undefined);
    assert.equal(status.version, "0.1.13");
    assert.equal(status.identityAvailable, true);
    assert.equal(status.configurationVerified, false);
    assert.equal(status.authPending, true);
    assert.equal(f.calls.length, 0);
  } finally { releaseToken({ token: TOKEN }); await connection; }
});

test("authorization timeout releases the queue, blocks duplicate prompts, and discards a late token", async () => {
  let releaseToken;
  const tokenPromise = new Promise(resolve => { releaseToken = resolve; });
  const f = fixture({ authTimeoutMs: 5, getAuthToken: () => tokenPromise });
  const connection = f.connect();
  try {
    const result = await Promise.race([connection, new Promise(resolve => setTimeout(() => resolve({ code: "TEST_AUTH_STILL_HANGING" }), 40))]);
    assert.equal(result.code, "AUTH_TIMEOUT");
    assert.equal(result.stage, "authorization");
    assert.equal((await f.connect()).code, "AUTH_IN_PROGRESS");
    assert.equal(f.authCalls.length, 1);
  } finally { releaseToken({ token: TOKEN }); await connection; }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.removed, [TOKEN]);
  assert.equal((await f.send("STATUS")).connected, false);
  assert.equal((await f.send("STATUS")).authPending, false);
  const reconnected = await f.connect();
  assert.equal(reconnected.connected, true);
  assert.equal(f.authCalls.length, 2);
  assert.equal(f.calls.length, 1);
});

test("disconnect can finish during a pending browser authorization without reconnecting from the late result", async () => {
  let releaseToken;
  const tokenPromise = new Promise(resolve => { releaseToken = resolve; });
  const f = fixture({ getAuthToken: () => tokenPromise });
  const connection = f.connect();
  await new Promise(resolve => setTimeout(resolve, 0));
  const disconnect = f.send("DISCONNECT");
  try {
    const result = await Promise.race([disconnect, new Promise(resolve => setTimeout(() => resolve({ blocked: true }), 30))]);
    assert.equal(result.blocked, undefined);
    assert.equal(result.connected, false);
    assert.equal((await connection).code, "CANCELLED");
  } finally { releaseToken({ token: TOKEN }); await connection; await disconnect; }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await f.send("STATUS")).connected, false);
  assert.equal(f.calls.length, 0);
});

test("userinfo permission errors are account failures, not Drive API failures", async () => {
  const f = fixture({ route: url => url.pathname === "/oauth2/v3/userinfo" ? json({ error: TOKEN }, 403) : undefined });
  const result = await f.connect();
  assert.equal(result.code, "ACCOUNT_PERMISSION");
  assert.equal(result.stage, "account");
  assert.equal(result.error.includes("Drive API"), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("unsupported identity API has a distinct local diagnostic and never reaches Google", async () => {
  const f = fixture();
  const cloud = createGoogleDriveCloud({ chrome: { ...f.api, identity: {} }, fetch: () => { throw new Error("Unexpected Google request"); } });
  const status = await cloud.handle({ type: "FAVMOA_CLOUD_STATUS" }, sender);
  assert.equal(status.configured, false);
  assert.equal(status.identityAvailable, false);
  assert.equal(status.configurationVerified, false);
  const result = await cloud.handle({ type: "FAVMOA_CLOUD_CONNECT" }, sender);
  assert.equal(result.code, "IDENTITY_UNAVAILABLE");
  assert.equal(result.stage, "configuration");
  assert.equal(f.authCalls.length, 0);
});

test("revoked authorization clears stale saved connection but network failure preserves it", async () => {
  for (const [message, expectedCode, connected] of [["OAuth2 token revoked", "AUTH_DENIED", false], ["Network connection failed", "AUTH_NETWORK", true]]) {
    const f = fixture({ getAuthToken: options => {
      if (options.interactive) return { token: TOKEN };
      throw new Error(message);
    } });
    await f.connect();
    const result = await f.send("LIST", { accountId: ACCOUNT.id });
    assert.equal(result.code, expectedCode);
    assert.equal((await f.send("STATUS")).connected, connected);
    assert.equal(f.calls.length, 1);
  }
});
