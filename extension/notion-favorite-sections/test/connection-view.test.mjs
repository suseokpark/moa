import test from "node:test";
import assert from "node:assert/strict";
import { connectionGuide, connectionDiagnostic } from "../src/connection-view.js";

test("connection failures give distinct recovery actions and unknown errors stay private", () => {
  assert.match(connectionGuide("OAUTH_CONFIG").action, /확장 ID/);
  assert.match(connectionGuide("AUTH_CANCELLED").action, /로그인하지 않아도/);
  assert.match(connectionGuide("AUTH_DENIED").action, /테스트 사용자/);
  assert.equal(connectionGuide("token=private").code, "AUTH_FAILED");
});
test("diagnostic allowlist excludes account, raw exception, catalog and token", () => {
  const text = connectionDiagnostic({ version: "0.1.13", extensionId: "a".repeat(32), configured: true, identityAvailable: true, account: {email:"secret@example.com"}, token:"private-token", catalog:"private-link" }, { code:"bad-token", message:"private-error" });
  assert.match(text, /Cloud 등록 상태 미검증/);
  assert.doesNotMatch(text, /secret@example|private-|bad-token/);
});
test("diagnostic rejects values that inject extra report fields", () => {
  const text = connectionDiagnostic({version:"0.1.13\nprivate",clientId:"token=secret", extensionId:"<img>"});
  assert.doesNotMatch(text, /private|token=secret|<img>/);
});
