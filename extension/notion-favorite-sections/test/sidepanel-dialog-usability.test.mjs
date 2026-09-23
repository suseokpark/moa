import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { prepareLinkInput } from "../src/link-entry.js";

// The shipped dialog functions and submit handler run against a small synthetic
// DOM. This covers form state, not native modal layout or Chrome runtime APIs.
const source = readFileSync(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
const declarations = [...source.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gmu)];
function shipped(name) {
  const index = declarations.findIndex(match => match[1] === name);
  return index < 0 ? "" : source.slice(declarations[index].index, declarations[index + 1]?.index ?? source.length);
}
class Element {
  constructor(tag, documentRef) {
    this.tagName = tag.toUpperCase(); this.documentRef = documentRef;
    this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = new Map();
    this.disabled = false; this.open = false; this.isConnected = true; this.value = ""; this.textContent = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.textContent = ""; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  emit(name) { return this.listeners.get(name)?.({ target: this, currentTarget: this, preventDefault() {} }); }
  focus() { if (!this.disabled) this.documentRef.activeElement = this; }
  closest() { return null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  querySelectorAll(selector) {
    const tags = selector.split(",").map(tag => tag.trim().toUpperCase());
    return this.children.flatMap(child => [child, ...child.querySelectorAll("*")]).filter(child => selector === "*" || tags.includes(child.tagName));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function fixture() {
  const elements = new Map(), actions = [];
  const document = { activeElement: null, createElement: tag => new Element(tag, document), querySelectorAll: () => [] };
  for (const [id, tag] of Object.entries({
    dialog: "dialog", "dialog-form": "form", "dialog-title": "h2", "dialog-body": "div", "dialog-error": "p",
    "dialog-submit": "button", "dialog-close": "button", "dialog-cancel": "button", "add-group": "button"
  })) elements.set(id, document.createElement(tag));
  const $ = id => elements.get(id);
  $("dialog").append($("dialog-form"));
  $("dialog-form").append($("dialog-close"), $("dialog-body"), $("dialog-error"), $("dialog-cancel"), $("dialog-submit"));
  $("add-group").focus();
  let dispatch = action => { actions.push(action); return true; };
  const context = vm.createContext({
    $, document, prepareLinkInput, state: { revision: 7 }, libraryId: "library-test",
    dialogBusy: false, dialogSubmit: null, dialogOrigin: null, dialogReturnKeys: [], dialogDisabledStates: new Map(), dialogBusyFocus: null,
    dispatch: (...args) => dispatch(...args),
    destinationFields(parent) {
      const group = document.createElement("select"); group.value = "group-test";
      group.selectedOptions = [{ textContent: "테스트 그룹" }]; parent.append(group); return { group };
    }
  });
  vm.runInContext(["node", "field", "setDialogBusy", "closeDialog", "restoreDialogFocus", "showDialog", "linkDialog"].map(shipped).join("\n"), context);
  const start = source.indexOf('$("dialog-form").addEventListener("submit"');
  vm.runInContext(source.slice(start, source.indexOf('treeDrag.bindTarget($("root-drop")', start)), context);
  context.linkDialog();
  const [url, title] = $("dialog-body").querySelectorAll("input");
  url.value = "https://example.com/document"; title.value = "예시 문서";
  return { context, document, $, url, title, actions, setDispatch: callback => { dispatch = callback; }, submit: () => $("dialog-form").emit("submit") };
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
  assert.equal(f.actions[0].link.url, "https://example.com/fixed");
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
