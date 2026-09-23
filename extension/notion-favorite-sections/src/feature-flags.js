// Cloud integration is deferred for the local-storage + JSON-backup release.
// Re-enabling it requires restoring its explicit permissions and runtime wiring.
export const CLOUD_ENABLED = false;

export function cloudPausedResponse() {
  return {
    ok: false,
    code: "CLOUD_PAUSED",
    error: "Google 연결과 클라우드 백업은 준비 중입니다. 현재는 이 브라우저에 저장하고 JSON 파일로 백업·복원할 수 있습니다."
  };
}
