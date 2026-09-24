import assert from "node:assert/strict";
import test from "node:test";
import { fixture as sidepanelFixture } from "../test-support/candidate-picker-fixture.mjs";

// Run the complete shipped sidepanel through the shared synthetic DOM seam.
// This covers form state, not native modal layout or Chrome runtime APIs.
function fixture() {
  const f = sidepanelFixture();
  f.$("add-group").focus();
  f.run("linkDialog()");
  const [url, title] = f.$("dialog-body").querySelectorAll("input");
  url.value = "https://example.com/document"; title.value = "예시 문서";
  return { ...f, url, title, setDispatch(callback) {
    f.setResponse(async (...args) => {
      const result = await callback(...args);
      return result === true ? { ok: true, catalog: f.run("state.catalog"), revision: f.run("state.revision") + 1 } : result;
    });
  } };
}

test("invalid URL remains editable, associates its error and returns focus to the address", async () => {
  const f = fixture(); f.url.value = "javascript:alert(1)"; f.$("dialog-submit").focus();
  await f.submit();
  assert.equal(f.actions.length, 0);
  assert.equal(f.$("dialog").open, true);
  assert.equal(f.document.activeElement, f.url);
  assert.equal(f.url.getAttribute("aria-invalid"), "true");
  assert.match(f.url.getAttribute("aria-describedby"), /\bdialog-error\b/u);
  assert.match(f.$("dialog-error").textContent, /웹 주소/u);
  assert.equal(f.url.disabled, false);
  f.url.value = "example.com/fixed"; f.url.emit("input");
  assert.notEqual(f.url.getAttribute("aria-invalid"), "true");
  assert.equal(f.$("dialog-error").textContent, "");
  await f.submit();
  assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0].action.link.url, "https://example.com/fixed");
  assert.equal(f.$("dialog").open, false);
});

test("invalid optional title marks the title without blaming the valid URL", async () => {
  const f = fixture(); f.title.value = "잘못된\u0001제목";
  await f.submit();
  assert.equal(f.actions.length, 0);
  assert.equal(f.document.activeElement, f.title);
  assert.equal(f.title.getAttribute("aria-invalid"), "true");
  assert.notEqual(f.url.getAttribute("aria-invalid"), "true");
});

test("editing a field does not erase a newer unrelated save or conflict error", async () => {
  const f = fixture(); f.url.value = "javascript:alert(1)";
  await f.submit();
  f.$("dialog-error").textContent = "다른 화면에서 목록이 변경되었습니다.";
  f.url.value = "example.com"; f.url.emit("input");
  assert.notEqual(f.url.getAttribute("aria-invalid"), "true");
  assert.equal(f.$("dialog-error").textContent, "다른 화면에서 목록이 변경되었습니다.");
});

test("pending save freezes the whole form and cannot be double submitted or cancelled", async () => {
  const f = fixture(); let finish, calls = 0;
  f.setDispatch(() => { calls += 1; return new Promise(resolve => { finish = resolve; }); });
  const pending = f.submit();
  for (const control of f.$("dialog-form").querySelectorAll("input,select,button")) assert.equal(control.disabled, true);
  assert.equal(f.$("dialog-form").getAttribute("aria-busy"), "true");
  await f.submit(); f.context.closeDialog();
  assert.equal(calls, 1); assert.equal(f.$("dialog").open, true);
  finish(true); await pending;
  assert.equal(f.$("dialog").open, false);
  assert.equal(f.$("dialog-form").getAttribute("aria-busy"), "false");
  assert.equal(f.document.activeElement, f.$("add-group"));
});

test("save rejection preserves values and original disabled states, then supports retry", async () => {
  const f = fixture(); let reject;
  const alreadyDisabled = f.document.createElement("input"); alreadyDisabled.disabled = true;
  f.$("dialog-body").append(alreadyDisabled);
  f.setDispatch(() => new Promise((_resolve, rejectSave) => { reject = rejectSave; }));
  const pending = f.submit(); reject(new Error("저장 연결 실패")); await pending;
  assert.equal(f.$("dialog").open, true);
  assert.equal(f.$("dialog-error").textContent, "저장 연결 실패");
  assert.equal(f.url.value, "https://example.com/document"); assert.equal(f.title.value, "예시 문서");
  assert.equal(f.url.disabled, false); assert.equal(f.$("dialog-cancel").disabled, false);
  assert.equal(alreadyDisabled.disabled, true, "pre-disabled fields must not be accidentally enabled");
  assert.notEqual(f.url.getAttribute("aria-invalid"), "true", "storage failure is not a URL validation error");
  f.setDispatch(() => true); await f.submit();
  assert.equal(f.$("dialog").open, false);
});

test("a backend failure returns focus to the re-enabled submit control", async () => {
  const f = fixture(); let reject;
  f.$("dialog-submit").focus();
  f.setDispatch(() => new Promise((_resolve, rejectSave) => { reject = rejectSave; }));
  const pending = f.submit();
  // Native browsers can move focus to body when the focused control disables.
  f.document.activeElement = null;
  reject(new Error("저장 실패")); await pending;
  assert.equal(f.document.activeElement, f.$("dialog-submit"));
  assert.equal(f.$("dialog-submit").disabled, false);
});
