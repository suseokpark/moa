import { CLOUD_ENABLED, cloudPausedResponse } from "./feature-flags.js";

// Only the trusted extension background receives Google credentials.
export function createCloudClient(chromeApi = globalThis.chrome) {
  if (!CLOUD_ENABLED) {
    const paused = async () => cloudPausedResponse();
    return { status: paused, connect: paused, disconnect: paused, upload: paused, list: paused, read: paused };
  }
  const extension = Boolean(chromeApi?.runtime?.id && globalThis.location?.protocol === "chrome-extension:");
  async function send(operation, payload = {}) {
    if (!extension) return { ok: false, code: "DEMO_ONLY", error: "실제 Google 연결은 설치한 Chrome 확장에서 사용할 수 있습니다. 미리보기는 데이터를 전송하지 않습니다." };
    try {
      const response = await chromeApi.runtime.sendMessage({ type: `FAVMOA_CLOUD_${operation}`, ...payload });
      return response || { ok: false, code: "BACKGROUND_UNAVAILABLE", stage: "runtime", error: "확장 백그라운드에서 응답을 받지 못했습니다. 확장을 새로고침한 뒤 다시 시도해 주세요." };
    } catch { return { ok: false, code: "BACKGROUND_UNAVAILABLE", stage: "runtime", error: "Google 연결 요청을 처리하지 못했습니다. 확장을 새로고침해 주세요." }; }
  }
  return {
    status: () => extension ? send("STATUS") : Promise.resolve({ ok: true, configured: true, connected: false, demo: true, account: null }),
    connect: () => send("CONNECT"),
    disconnect: () => send("DISCONNECT"),
    upload: (expectedRevision, accountId) => send("UPLOAD", { expectedRevision, accountId }),
    list: (accountId) => send("LIST", { accountId }),
    read: (fileId, accountId) => send("READ", { fileId, accountId })
  };
}
