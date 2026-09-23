import { createCatalog, validateCatalog } from "./link-library.js";
import { FAVMOA_STORAGE_KEY, isTrustedFavmoaSender } from "./favmoa-service.js";

export const GOOGLE_CONNECTION_KEY = "favmoa:google:connection:v1";
export const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
const APP_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const TYPES = new Set(["FAVMOA_CLOUD_STATUS", "FAVMOA_CLOUD_CONNECT", "FAVMOA_CLOUD_DISCONNECT", "FAVMOA_CLOUD_LIST", "FAVMOA_CLOUD_UPLOAD", "FAVMOA_CLOUD_READ"]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/u;

class CloudError extends Error {
  constructor(code, message, stage) { super(message); this.code = code; this.stage = stage; }
}
function fail(code, message, stage) { throw new CloudError(code, message, stage); }
function resultError(error, stage = "runtime") {
  return error instanceof CloudError ? { ok: false, code: error.code, error: error.message, stage: error.stage || (error.code === "STORAGE_UNAVAILABLE" ? "storage" : stage) }
    : { ok: false, code: "CLOUD_UNAVAILABLE", stage, error: "Google 연결을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요." };
}
function accountFromUserInfo(value) {
  if (!value || typeof value.sub !== "string" || !SAFE_ID.test(value.sub)
    || typeof value.email !== "string" || value.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email)
    || value.email_verified === false) fail("INVALID_ACCOUNT", "Google 계정을 확인하지 못했습니다. 다시 연결해 주세요.", "account");
  return { id: value.sub, email: value.email };
}
function validConnection(value) {
  if (!value?.connected) return { connected: false, account: null };
  try {
    const account = accountFromUserInfo({ sub: value.account?.id, email: value.account?.email });
    return { connected: true, account, ...(typeof value.lastBackupAt === "string" && Number.isFinite(Date.parse(value.lastBackupAt)) ? { lastBackupAt: value.lastBackupAt } : {}) };
  } catch { return { connected: false, account: null }; }
}
function backupMetadata(file) {
  if (!file || typeof file.id !== "string" || !SAFE_ID.test(file.id) || file.mimeType !== "application/json" || file.trashed === true
    || file.appProperties?.favmoaType !== "backup-v1" || !Array.isArray(file.spaces) || !file.spaces.includes("appDataFolder")
    || !Array.isArray(file.parents) || file.parents.length === 0 || !file.parents.every(parent => typeof parent === "string" && SAFE_ID.test(parent))) fail("NOT_FAVMOA_BACKUP", "이 파일은 FAVMOA 앱 데이터 백업이 아닙니다.");
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BACKUP_BYTES) fail("BACKUP_TOO_LARGE", "지원하는 백업 크기는 최대 4MB입니다.");
  if (typeof file.name !== "string" || file.name.length > 300 || typeof file.createdTime !== "string" || !Number.isFinite(Date.parse(file.createdTime))) fail("INVALID_BACKUP", "백업 파일 정보를 확인할 수 없습니다.");
  return { id: file.id, name: file.name, createdTime: file.createdTime, size };
}

export function createGoogleDriveCloud({ chrome: api, fetch: fetcher = globalThis.fetch, now = () => new Date(), timeoutMs = 30_000, authTimeoutMs = 90_000 } = {}) {
  const runtimeId = api?.runtime?.id;
  const manifest = api?.runtime?.getManifest?.() || {};
  const clientId = manifest.oauth2?.client_id || "";
  const identityAvailable = typeof api?.identity?.getAuthToken === "function";
  const configured = /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(clientId)
    && ["openid", "email", APP_SCOPE].every(scope => manifest.oauth2?.scopes?.includes(scope))
    && identityAvailable;
  let epoch = 0;
  let queue = Promise.resolve();
  let storageQueue = Promise.resolve();
  let pendingAuth = null;
  const controllers = new Set();
  const storageReady = Promise.resolve().then(async () => {
    try { await api.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }); return true; }
    catch { return false; }
  });

  function assertEpoch(operationEpoch) {
    if (operationEpoch !== epoch) fail("CANCELLED", "연결이 변경되어 작업을 중단했습니다. 현재 계정을 확인해 주세요.");
  }
  async function readConnection() {
    if (!(await storageReady)) fail("STORAGE_UNAVAILABLE", "안전한 로컬 저장소를 사용할 수 없습니다.");
    try { return validConnection((await api.storage.local.get(GOOGLE_CONNECTION_KEY))[GOOGLE_CONNECTION_KEY]); }
    catch { fail("STORAGE_UNAVAILABLE", "Google 연결 상태를 읽지 못했습니다."); }
  }
  function writeConnection(value, operationEpoch) {
    const task = storageQueue.catch(() => undefined).then(async () => {
      assertEpoch(operationEpoch);
      if (!(await storageReady)) fail("STORAGE_UNAVAILABLE", "안전한 로컬 저장소를 사용할 수 없습니다.");
      await api.storage.local.set({ [GOOGLE_CONNECTION_KEY]: value });
      assertEpoch(operationEpoch);
    });
    storageQueue = task;
    return task;
  }
  async function status() {
    const connection = await readConnection();
    return { ok: true, configured, ...(configured ? connection : { connected: false, account: null }), extensionId: runtimeId, clientId,
      version: manifest.version || "", identityAvailable, configurationVerified: false, authPending: Boolean(pendingAuth) };
  }
  async function checkSession(session) {
    assertEpoch(session.epoch);
    if (session.connecting) return;
    const connection = await readConnection();
    assertEpoch(session.epoch);
    if (!connection.connected) fail("AUTH_REQUIRED", "Google 계정을 먼저 연결해 주세요.");
    if (connection.account.id !== session.accountId) fail("ACCOUNT_CHANGED", "연결 계정이 변경되었습니다. 계정을 다시 확인해 주세요.");
  }
  async function invalidate(session, code = "AUTH_REQUIRED") {
    if (session.epoch === epoch) {
      epoch += 1;
      for (const controller of controllers) controller.abort();
      try { await writeConnection({ connected: false, account: null }, epoch); } catch { /* Keep cancellation active even if storage is unavailable. */ }
      try { await api.identity.removeCachedAuthToken({ token: session.token }); } catch { /* Token is never persisted by this extension. */ }
    }
    fail(code, code === "ACCOUNT_CHANGED" ? "Google 계정이 이전 연결과 다릅니다. 다시 연결하고 사용할 계정을 확인해 주세요." : "Google 연결이 만료되었습니다. 다시 연결해 주세요.");
  }
  async function token(interactive, operationEpoch) {
    assertEpoch(operationEpoch);
    if (pendingAuth) fail("AUTH_IN_PROGRESS", "이전 Google 인증 창이 아직 응답하지 않았습니다. 열린 Google 창을 완료하거나 닫은 뒤 다시 시도해 주세요.", "authorization");
    async function removeLateToken(value) {
      const lateToken = typeof value === "string" ? value : value?.token;
      if (typeof lateToken === "string" && lateToken && lateToken.length <= 16_384) {
        try { await api.identity.removeCachedAuthToken({ token: lateToken }); } catch { /* A discarded result can never mark this app connected. */ }
      }
    }
    // Chrome cannot abort getAuthToken. Bound our wait, but retain a gate until
    // that browser request settles, and discard its late token before reopening
    // the gate. A timeout must not start overlapping Google consent prompts.
    const attempt = { cancel: null };
    pendingAuth = attempt;
    const authorization = new Promise((resolve, reject) => {
      let abandoned = false;
      const abandon = (code, message) => {
        if (abandoned) return;
        abandoned = true;
        clearTimeout(timer);
        reject(new CloudError(code, message, "authorization"));
      };
      const timer = setTimeout(() => abandon("AUTH_TIMEOUT", "Google 인증 응답을 90초 동안 받지 못했습니다. 열린 Google 창을 완료하거나 닫아 주세요. 로컬 링크는 그대로 사용할 수 있습니다."), authTimeoutMs);
      attempt.cancel = () => abandon("CANCELLED", "Google 연결 작업을 중단했습니다. 열린 Google 인증 창도 닫아 주세요.");
      Promise.resolve().then(() => api.identity.getAuthToken({ interactive, enableGranularPermissions: true })).then(async value => {
        if (abandoned || operationEpoch !== epoch) await removeLateToken(value);
        else resolve(value);
      }, error => { if (!abandoned) reject(error); }).finally(() => {
        clearTimeout(timer);
        if (pendingAuth === attempt) pendingAuth = null;
      });
    });
    let value;
    try { value = await authorization; }
    catch (error) {
      assertEpoch(operationEpoch);
      if (error instanceof CloudError) throw error;
      const message = String(error?.message || "");
      if (/invalid.?client|bad client|oauth2.*client|client.*(?:id|invalid)|redirect_uri|origin|not registered/iu.test(message)) {
        fail("OAUTH_CONFIG", "Google OAuth 설정을 확인해 주세요. OAuth 클라이언트 유형은 Chrome 확장 프로그램이어야 하며 등록된 확장 ID가 현재 확장 ID와 일치해야 합니다.", "configuration");
      }
      if (/network|connection failed|temporarily unavailable|service unavailable|timed?\s*out/iu.test(message)) fail("AUTH_NETWORK", "Google 인증 서버에 연결하지 못했습니다. 인터넷 또는 VPN 연결을 확인한 뒤 다시 시도해 주세요.", "authorization");
      if (/not signed in|not logged in|no (?:signed.in )?account|account.*unavailable/iu.test(message)) fail("AUTH_ACCOUNT_UNAVAILABLE", "브라우저에서 사용할 Google 계정을 찾지 못했습니다. Chrome의 Google 로그인 상태를 확인한 뒤 다시 시도해 주세요.", "authorization");
      if (/access.?denied|blocked|admin_policy_enforced|org_internal|restricted|test user|not verified|verification|not granted|revoked/iu.test(message)) fail("AUTH_DENIED", "Google에서 연결을 허용하지 않았습니다. 테스트 사용자 등록, 동의 권한 또는 조직의 앱 허용 정책을 확인해 주세요.", "authorization");
      if (interactive && /user.*(?:cancel|did not approve|denied|reject)|cancelled|canceled|window.*closed/iu.test(message)) fail("AUTH_CANCELLED", "Google 연결을 취소했습니다. 로컬 링크는 그대로 유지되며 원할 때 다시 연결할 수 있습니다.", "authorization");
      if (interactive) fail("AUTH_FAILED", "Google 인증을 완료하지 못했습니다. 연결 진단의 오류 코드와 설정 정보를 확인해 주세요.", "authorization");
      fail("AUTH_REQUIRED", "Google 연결이 만료되었습니다. 다시 연결해 주세요.", "authorization");
    }
    if (operationEpoch !== epoch) await removeLateToken(value);
    assertEpoch(operationEpoch);
    const result = typeof value === "string" ? { token: value } : value;
    if (!result || typeof result.token !== "string" || !result.token || result.token.length > 16_384) fail("AUTH_REQUIRED", "Google 인증 정보를 받지 못했습니다. 다시 연결해 주세요.", "authorization");
    if (Array.isArray(result.grantedScopes) && !["openid", "email", APP_SCOPE].every(scope => result.grantedScopes.includes(scope) || (scope === "email" && result.grantedScopes.includes("https://www.googleapis.com/auth/userinfo.email")))) {
      try { await api.identity.removeCachedAuthToken({ token: result.token }); } catch { /* No raw authentication errors are returned. */ }
      fail("PERMISSION_REQUIRED", "계정 확인과 FAVMOA 전용 Drive 앱 데이터 권한을 모두 허용해 주세요.", "authorization");
    }
    return result.token;
  }
  async function parseJson(response, maxBytes) {
    const length = Number(response.headers?.get?.("content-length"));
    if (length > maxBytes) fail("BACKUP_TOO_LARGE", "응답 크기가 허용 범위를 초과했습니다.");
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0;
      const parts = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) { await reader.cancel(); fail("BACKUP_TOO_LARGE", "응답 크기가 허용 범위를 초과했습니다."); }
          parts.push(decoder.decode(value, { stream: true }));
        }
        parts.push(decoder.decode());
        text = parts.join("");
      } finally { reader.releaseLock(); }
    } else {
      text = await response.text();
      if (new TextEncoder().encode(text).length > maxBytes) fail("BACKUP_TOO_LARGE", "응답 크기가 허용 범위를 초과했습니다.");
    }
    try { return JSON.parse(text); } catch { fail("INVALID_RESPONSE", "Google 응답 형식을 확인하지 못했습니다."); }
  }
  async function request(session, path, { query = {}, method = "GET", body, contentType, maxBytes = 512 * 1024 } = {}) {
    const stage = path === "/oauth2/v3/userinfo" ? "account" : "drive";
    // The token is only attached to these fixed Google API routes. File IDs and
    // page tokens are parameters, never caller-supplied URLs or redirect targets.
    if (!["/oauth2/v3/userinfo", "/drive/v3/files", "/upload/drive/v3/files"].includes(path) && !/^\/drive\/v3\/files\/[A-Za-z0-9_-]{1,200}$/u.test(path)) fail("INVALID_REQUEST", "지원하지 않는 Google 요청입니다.");
    await checkSession(session);
    const url = new URL(path, "https://www.googleapis.com");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url.href, { method, headers: { Authorization: `Bearer ${session.token}`, ...(contentType ? { "Content-Type": contentType } : {}) }, body, signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store" });
      await checkSession(session);
      if (response.status === 401) await invalidate(session);
      if (response.status === 403 && stage === "account") fail("ACCOUNT_PERMISSION", "Google 계정 정보를 확인할 권한이 없습니다. 계정 확인 권한을 허용하고 다시 연결해 주세요.");
      if (response.status === 403) fail("DRIVE_PERMISSION", "Drive 앱 데이터 권한이 없거나 Google Cloud의 Drive API가 꺼져 있습니다. 권한 승인과 API 사용 설정을 확인해 주세요.");
      if (response.status === 404) fail("BACKUP_NOT_FOUND", "백업을 찾을 수 없습니다. 목록을 새로고침해 주세요.");
      if (response.status === 429) fail("RATE_LIMITED", "Google 요청이 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.");
      if (method === "POST" && response.status >= 500) fail("BACKUP_RESULT_UNKNOWN", "백업 저장 결과를 확인하지 못했습니다. 이미 저장되었을 수 있으니 백업 목록을 확인한 뒤 다시 시도해 주세요.");
      if (!response.ok) fail("GOOGLE_UNAVAILABLE", "Google 요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      const value = await parseJson(response, maxBytes);
      await checkSession(session);
      return value;
    } catch (error) {
      if (error instanceof CloudError) error.stage ||= stage;
      if (error instanceof CloudError && ["AUTH_REQUIRED", "ACCOUNT_CHANGED"].includes(error.code)) throw error;
      assertEpoch(session.epoch);
      if (error instanceof CloudError) throw error;
      if (method === "POST") fail("BACKUP_RESULT_UNKNOWN", "백업 저장 결과를 확인하지 못했습니다. 이미 저장되었을 수 있으니 백업 목록을 확인한 뒤 다시 시도해 주세요.", stage);
      if (controller.signal.aborted) fail("TIMEOUT", "Google 응답 시간이 초과되었습니다. 연결 상태를 확인해 주세요.", stage);
      fail("NETWORK_ERROR", "Google에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.", stage);
    } finally {
      // Close unread response bodies on header/metadata errors as well as on a
      // timeout; a refused oversized download must not continue in background.
      controller.abort();
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }
  async function beginSession(accountId, operationEpoch) {
    if (typeof accountId !== "string" || !SAFE_ID.test(accountId)) fail("ACCOUNT_CONFIRMATION_REQUIRED", "표시된 Google 계정을 확인한 뒤 진행해 주세요.");
    const session = { epoch: operationEpoch, accountId };
    await checkSession(session);
    try { session.token = await token(false, operationEpoch); }
    catch (error) {
      if (error instanceof CloudError && ["AUTH_REQUIRED", "PERMISSION_REQUIRED", "AUTH_DENIED", "AUTH_ACCOUNT_UNAVAILABLE"].includes(error.code)) {
        try { await writeConnection({ connected: false, account: null }, operationEpoch); } catch { /* Authentication remains unavailable. */ }
      }
      throw error;
    }
    const account = accountFromUserInfo(await request(session, "/oauth2/v3/userinfo", { maxBytes: 64 * 1024 }));
    if (account.id !== accountId) await invalidate(session, "ACCOUNT_CHANGED");
    return { ...session, account };
  }
  async function currentCatalog(expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail("INVALID_REQUEST", "현재 목록의 저장 버전을 확인해 주세요.");
    const stored = (await api.storage.local.get(FAVMOA_STORAGE_KEY))[FAVMOA_STORAGE_KEY];
    const value = stored === undefined ? { revision: 0, catalog: createCatalog() } : stored;
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0) fail("INVALID_CATALOG", "로컬 목록을 검증하지 못했습니다. 백업하지 않았습니다.");
    if (value.revision !== expectedRevision) fail("CONFLICT", "로컬 목록이 변경되었습니다. 최신 목록을 확인한 뒤 다시 백업해 주세요.");
    try { return validateCatalog(value.catalog); } catch { fail("INVALID_CATALOG", "로컬 목록을 검증하지 못했습니다. 백업하지 않았습니다."); }
  }
  async function execute(message, operationEpoch) {
    assertEpoch(operationEpoch);
    if (message.type === "FAVMOA_CLOUD_STATUS") return status();
    if (message.type === "FAVMOA_CLOUD_DISCONNECT") {
      await writeConnection({ connected: false, account: null }, operationEpoch);
      try { await api.identity.clearAllCachedAuthTokens(); }
      catch { return { ...await status(), ok: false, code: "DISCONNECT_PARTIAL", error: "FAVMOA 연결은 해제했지만 인증 캐시 정리를 완료하지 못했습니다. 확장을 새로고침해 주세요." }; }
      assertEpoch(operationEpoch);
      return status();
    }
    if (!identityAvailable) fail("IDENTITY_UNAVAILABLE", "이 브라우저에서는 Chrome 인증 기능을 사용할 수 없습니다. 데스크톱 Chrome에 설치한 확장에서 연결해 주세요.", "configuration");
    if (!configured) return { ok: false, code: "CONFIG_REQUIRED", stage: "configuration", error: "Google OAuth 클라이언트 유형을 Chrome 확장 프로그램으로 만들고 현재 확장 ID를 등록해야 합니다. 웹 애플리케이션용 ID는 사용할 수 없습니다.", extensionId: runtimeId, clientId };
    if (!(await storageReady)) fail("STORAGE_UNAVAILABLE", "안전한 로컬 저장소를 사용할 수 없습니다.");
    if (message.type === "FAVMOA_CLOUD_CONNECT") {
      const session = { epoch: operationEpoch, connecting: true, token: await token(true, operationEpoch) };
      const account = accountFromUserInfo(await request(session, "/oauth2/v3/userinfo", { maxBytes: 64 * 1024 }));
      const previous = await readConnection();
      const value = { connected: true, account, ...(previous.account?.id === account.id && previous.lastBackupAt ? { lastBackupAt: previous.lastBackupAt } : {}) };
      await writeConnection(value, operationEpoch);
      return status();
    }
    if (message.type === "FAVMOA_CLOUD_UPLOAD") await currentCatalog(message.expectedRevision);
    const session = await beginSession(message.accountId, operationEpoch);
    if (message.type === "FAVMOA_CLOUD_UPLOAD") {
      const catalog = await currentCatalog(message.expectedRevision);
      const createdAt = now().toISOString();
      const backup = JSON.stringify({ format: "favmoa-backup", version: 1, createdAt, catalog });
      if (new TextEncoder().encode(backup).length > MAX_BACKUP_BYTES) fail("BACKUP_TOO_LARGE", "Drive 백업은 최대 4MB입니다. 로컬 목록은 그대로 유지됩니다. JSON 내보내기로 보관하거나 목록을 줄인 뒤 다시 시도해 주세요.");
      const name = `favmoa-backup-${createdAt.replaceAll(":", "-")}.json`;
      const metadata = { name, mimeType: "application/json", parents: ["appDataFolder"], appProperties: { favmoaType: "backup-v1" } };
      const boundary = `favmoa_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${backup}\r\n--${boundary}--\r\n`;
      const uploaded = await request(session, "/upload/drive/v3/files", { method: "POST", query: { uploadType: "multipart", fields: "id,name,createdTime" }, contentType: `multipart/related; boundary=${boundary}`, body });
      if (!SAFE_ID.test(uploaded?.id || "")) fail("INVALID_RESPONSE", "백업 저장 결과를 확인하지 못했습니다. 중복 백업을 피하려면 목록부터 확인해 주세요.");
      await checkSession(session);
      await writeConnection({ connected: true, account: session.account, lastBackupAt: createdAt }, operationEpoch);
      return { ok: true, backup: { id: uploaded.id, name, createdTime: uploaded.createdTime || createdAt }, lastBackupAt: createdAt, revision: message.expectedRevision, account: session.account };
    }
    if (message.type === "FAVMOA_CLOUD_LIST") {
      const backups = [];
      let pageToken;
      for (let page = 0; page < 5; page += 1) {
        const data = await request(session, "/drive/v3/files", { query: { spaces: "appDataFolder", q: "trashed = false and appProperties has { key='favmoaType' and value='backup-v1' }", fields: "nextPageToken,files(id,name,createdTime,size,mimeType,appProperties,spaces,parents)", orderBy: "createdTime desc", pageSize: 100, ...(pageToken ? { pageToken } : {}) } });
        if (!Array.isArray(data.files) || data.files.length > 100) fail("INVALID_RESPONSE", "백업 목록 형식을 확인하지 못했습니다.");
        for (const file of data.files) {
          try { backups.push(backupMetadata(file)); } catch { /* Only bounded, verified FAVMOA files are offered for restore. */ }
        }
        pageToken = data.nextPageToken;
        if (!pageToken) break;
        if (typeof pageToken !== "string" || pageToken.length > 2048) fail("INVALID_RESPONSE", "백업 목록의 다음 페이지 정보를 확인하지 못했습니다.");
      }
      return { ok: true, backups, hasMore: Boolean(pageToken), account: session.account };
    }
    if (message.type === "FAVMOA_CLOUD_READ") {
      if (typeof message.fileId !== "string" || !SAFE_ID.test(message.fileId)) fail("INVALID_REQUEST", "올바른 백업 파일을 선택해 주세요.");
      const path = `/drive/v3/files/${message.fileId}`;
      const metadata = backupMetadata(await request(session, path, { query: { fields: "id,name,createdTime,size,mimeType,trashed,appProperties,spaces,parents" } }));
      if (metadata.id !== message.fileId) fail("INVALID_BACKUP", "선택한 백업 파일과 응답이 일치하지 않습니다.");
      const backup = await request(session, path, { query: { alt: "media" }, maxBytes: MAX_BACKUP_BYTES });
      if (!backup || Object.keys(backup).some(key => !["format", "version", "createdAt", "catalog"].includes(key)) || backup.format !== "favmoa-backup" || backup.version !== 1 || typeof backup.createdAt !== "string" || !Number.isFinite(Date.parse(backup.createdAt))) fail("INVALID_BACKUP", "지원하지 않는 백업 형식입니다. 로컬 목록은 변경하지 않았습니다.");
      let catalog;
      try { catalog = validateCatalog(backup.catalog); } catch { fail("INVALID_BACKUP", "백업 목록을 검증하지 못했습니다. 로컬 목록은 변경하지 않았습니다."); }
      await checkSession(session);
      return { ok: true, catalog, createdAt: backup.createdAt, backup: metadata, account: session.account };
    }
    fail("UNKNOWN_REQUEST", "지원하지 않는 Google 요청입니다.");
  }
  return {
    accepts: message => TYPES.has(message?.type),
    handle(message, sender) {
      if (!TYPES.has(message?.type)) return Promise.resolve({ ok: false, code: "UNKNOWN_REQUEST", error: "지원하지 않는 요청입니다." });
      if (!isTrustedFavmoaSender(sender, runtimeId)) return Promise.resolve({ ok: false, code: "UNTRUSTED_SENDER", error: "이 요청은 FAVMOA 화면에서만 사용할 수 있습니다." });
      // Reading local diagnostics must not wait behind an unresolved consent UI.
      if (message.type === "FAVMOA_CLOUD_STATUS") return status().catch(error => resultError(error, "storage"));
      if (message.type === "FAVMOA_CLOUD_DISCONNECT") {
        epoch += 1;
        for (const controller of controllers) controller.abort();
        pendingAuth?.cancel();
      }
      const operationEpoch = epoch;
      const task = queue.catch(() => undefined).then(() => execute(message, operationEpoch));
      queue = task;
      const stage = message.type === "FAVMOA_CLOUD_CONNECT" || message.type === "FAVMOA_CLOUD_DISCONNECT" ? "authorization" : "drive";
      return task.catch(error => resultError(error, stage));
    }
  };
}

if (typeof globalThis.document === "undefined" && globalThis.chrome?.runtime?.onMessage && globalThis.chrome?.runtime?.getManifest && globalThis.chrome?.storage?.local) {
  const cloud = createGoogleDriveCloud({ chrome: chrome });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!cloud.accepts(message)) return false;
    cloud.handle(message, sender).then(respond);
    return true;
  });
}
