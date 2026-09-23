import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createGroupColorEditor, GROUP_COLOR_PRESETS } from "../src/group-colors.js";
import { flattenGroups, identifyUrl, MAX_GROUP_DEPTH, SYSTEM_GROUP_ID } from "../src/link-library.js";
import { findSavedPage } from "../src/link-navigation.js";
import { createLinkSelection } from "../src/link-selection.js";

// Synthetic DOM behavior checks only: layout, native color picker interaction
// and actual Chrome storage are tested separately and are not inferred here.
class Element {
  constructor(tag, documentRef) {
    this.tagName = tag.toUpperCase(); this.documentRef = documentRef;
    this.children = []; this.attributes = {}; this.dataset = {};
    this.className = ""; this.ownText = ""; this.value = "";
    this.listeners = new Map();
    this.style = { setProperty(name, value) { this[name] = value; }, getPropertyValue(name) { return this[name] || ""; } };
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.ownText = ""; this.children = children; }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }
  emit(name) { for (const handler of this.listeners.get(name) || []) handler({ target: this, preventDefault() {} }); }
  focus() { this.documentRef.activeElement = this; }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const withClass = (element, name) => descendants(element).filter(item => item.className.split(" ").includes(name));
function documentFixture() {
  const elements = new Map();
  const documentRef = {
    activeElement: null,
    createElement(tag) { return new Element(tag, documentRef); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, documentRef.createElement("div"));
      return elements.get(id);
    }
  };
  return documentRef;
}
function editorFixture(color) {
  const group = Object.freeze({ id: "work", name: "프로젝트", ...(color ? { color } : {}) });
  const documentRef = documentFixture();
  const editor = createGroupColorEditor({ documentRef, group });
  const nodes = descendants(editor.element);
  return {
    group, documentRef, editor,
    hex: nodes.find(item => item.id === "group-color-hex"),
    picker: nodes.find(item => item.type === "color"),
    error: nodes.find(item => item.id === "group-color-error"),
    preview: withClass(editor.element, "group-color-preview")[0],
    status: editor.element.children[1],
    controls: nodes.filter(item => item.tagName === "BUTTON"),
    choose(name) { const control = nodes.find(item => item.tagName === "BUTTON" && item.textContent === name); assert.ok(control, `missing choice ${name}`); control.emit("click"); }
  };
}

test("uncolored editor starts with theme-adaptive preview and an accessible default choice", () => {
  const { editor, hex, picker, preview, status, controls } = editorFixture();
  assert.equal(editor.getColor(), null);
  assert.equal(hex.value, "");
  assert.equal(picker.value, "#34856a");
  assert.equal(preview.style.getPropertyValue("--group-color"), "var(--muted)");
  assert.match(status.textContent, /기본 색상.*테마/u);
  assert.deepEqual(controls.filter(control => control.getAttribute("aria-pressed") === "true").map(control => control.textContent), ["기본 색상"]);
  assert.equal(hex.getAttribute("aria-describedby"), "group-color-help group-color-error");
  assert.equal(withClass(editor.element, "group-color-dot")[0].getAttribute("aria-hidden"), "true");
});

test("all eight presets are local drafts with coordinated fields, preview and pressed state", () => {
  const fixture = editorFixture("#112233");
  const snapshot = { ...fixture.group };
  assert.equal(GROUP_COLOR_PRESETS.length, 8);
  for (const preset of GROUP_COLOR_PRESETS) {
    fixture.choose(preset.name);
    assert.equal(fixture.editor.getColor(), preset.color);
    assert.equal(fixture.hex.value, preset.color);
    assert.equal(fixture.picker.value, preset.color);
    assert.equal(fixture.preview.style.getPropertyValue("--group-color"), preset.color);
    assert.deepEqual(fixture.controls.filter(control => control.getAttribute("aria-pressed") === "true").map(control => control.textContent), [preset.name]);
  }
  assert.deepEqual(fixture.group, snapshot);
});

test("custom HEX normalizes only the draft, with no forced matching preset", () => {
  const { editor, hex, picker, preview, status, controls, group } = editorFixture("#112233");
  hex.value = "#AbC123"; hex.emit("input");
  assert.equal(editor.getColor(), "#abc123");
  assert.equal(picker.value, "#abc123");
  assert.equal(preview.style.getPropertyValue("--group-color"), "#abc123");
  assert.match(status.textContent, /#ABC123/u);
  assert.equal(controls.some(control => control.getAttribute("aria-pressed") === "true"), false);
  assert.equal(group.color, "#112233");
});

test("picker selection updates HEX draft and preserves the source group", () => {
  const { editor, picker, hex, preview, group } = editorFixture("#112233");
  picker.value = "#ffffff"; picker.emit("input");
  assert.equal(hex.value, "#ffffff");
  assert.equal(editor.getColor(), "#ffffff");
  assert.equal(preview.style.getPropertyValue("--group-color"), "#ffffff");
  assert.equal(group.color, "#112233");
});

test("invalid HEX retains the last valid preview and prevents saving until corrected", () => {
  const fixture = editorFixture("#112233");
  for (const value of ["#123", "#gggggg", "red", "#12345678", "var(--accent)", "#123456;display:none"]) {
    fixture.hex.value = value; fixture.hex.emit("input");
    assert.equal(fixture.hex.getAttribute("aria-invalid"), "true");
    assert.match(fixture.error.textContent, /여섯 자리/u);
    assert.equal(fixture.preview.style.getPropertyValue("--group-color"), "#112233");
    assert.throws(() => fixture.editor.getColor(), /여섯 자리/u);
    assert.equal(fixture.documentRef.activeElement, fixture.hex);
  }
  fixture.hex.value = "#ABC123"; fixture.hex.emit("input");
  assert.equal(fixture.editor.getColor(), "#abc123");
  assert.equal(fixture.hex.getAttribute("aria-invalid"), "false");
  assert.equal(fixture.error.textContent, "");
  assert.equal(fixture.group.color, "#112233");
});

test("clearing HEX or choosing default removes only the draft override and clears validation errors", () => {
  const fixture = editorFixture("#112233");
  fixture.hex.value = ""; fixture.hex.emit("input");
  assert.equal(fixture.editor.getColor(), null);
  assert.equal(fixture.preview.style.getPropertyValue("--group-color"), "var(--muted)");
  fixture.choose("파랑");
  fixture.hex.value = "bad"; fixture.hex.emit("input");
  fixture.choose("기본 색상");
  assert.equal(fixture.editor.getColor(), null);
  assert.equal(fixture.hex.value, "");
  assert.equal(fixture.hex.getAttribute("aria-invalid"), "false");
  assert.equal(fixture.error.textContent, "");
  assert.equal(fixture.group.color, "#112233");
  const reopened = editorFixture(fixture.group.color);
  assert.equal(reopened.editor.getColor(), "#112233", "discarding an editor must not save its draft");
});

test("busy editor disables all color controls and can recover without losing its draft", () => {
  const { editor, hex, picker, controls } = editorFixture("#abcdef");
  editor.setBusy(true);
  assert.equal(editor.element.getAttribute("aria-busy"), "true");
  assert.equal([...controls, hex, picker].every(control => control.disabled), true);
  editor.setBusy(false);
  assert.equal(editor.element.getAttribute("aria-busy"), "false");
  assert.equal([...controls, hex, picker].every(control => control.disabled === false), true);
  assert.equal(editor.getColor(), "#abcdef");
});

const script = await readFile(new URL("../sidepanel/sidepanel.js", import.meta.url), "utf8");
function renderingFixture(groups) {
  const document = documentFixture();
  const context = vm.createContext({
    document, createPlatform: () => ({}), identifyUrl, findSavedPage, createGroupColorEditor, createLinkSelection,
    createTreeDrag: () => ({ bindSource() {}, bindTarget() {}, reset() {}, isDragging: () => false }),
    createInteractionGuard: () => ({ isActive: () => false }),
    SYSTEM_GROUP_ID, flattenGroups, MAX_GROUP_DEPTH, groups
  });
  const boundary = script.indexOf('$("dialog-form").addEventListener("submit"');
  assert.ok(boundary > 0);
  vm.runInContext(script.slice(0, boundary).replace(/^import .+;\n/gmu, ""), context);
  vm.runInContext('libraryId = "library-test"; state = {revision: 7, catalog: {libraries: [{id: libraryId, name: "내 링크", groups}]}};', context);
  return {
    context,
    render(query = "") {
      context.query = query;
      return vm.runInContext('library().groups.map(group => projectGroup(group, query)).filter(Boolean).map(view => renderGroup(view, Boolean(query)))', context);
    }
  };
}
const group = (id, color, groups = []) => ({ id, name: id, collapsed: false, groups, links: [], ...(color ? { color } : {}) });

test("recursive rendering resets each group fallback so a plain child does not inherit its parent's color", () => {
  const source = [group("parent", "#112233", [group("plain"), group("colored", "#abcdef", [group("grandchild")])])];
  const snapshot = structuredClone(source);
  const nodes = renderingFixture(source).render().flatMap(descendants);
  const wrappers = nodes.filter(item => item.className === "group");
  assert.deepEqual(wrappers.map(item => [item.dataset.groupId, item.style["--group-color"], item.style["--group-line"]]), [
    ["parent", "#112233", "#112233"], ["plain", "var(--muted)", "var(--line)"],
    ["colored", "#abcdef", "#abcdef"], ["grandchild", "var(--muted)", "var(--line)"]
  ]);
  const markers = nodes.filter(item => item.className === "group-color-dot");
  assert.equal(markers.length, 4);
  assert.equal(markers.every(item => item.getAttribute("aria-hidden") === "true"), true);
  assert.deepEqual(source, snapshot);
});

test("search projection preserves ancestor/child group colors without modifying source data", () => {
  const source = [group("parent", "#112233", [group("match", "#abcdef"), group("hidden", "#334455")])];
  source[0].collapsed = true;
  const snapshot = structuredClone(source);
  const nodes = renderingFixture(source).render("match").flatMap(descendants);
  assert.deepEqual(nodes.filter(item => item.className === "group").map(item => [item.dataset.groupId, item.style["--group-color"]]), [["parent", "#112233"], ["match", "#abcdef"]]);
  assert.equal(nodes.filter(item => item.className === "fold").every(item => item.disabled), true);
  assert.deepEqual(source, snapshot);
});

test("system group offers color but no protected structure actions; regular groups keep existing actions", () => {
  const rendered = renderingFixture([group(SYSTEM_GROUP_ID), group("custom")]).render();
  const menuLabels = wrapper => {
    const heading = wrapper.children[0];
    const menu = heading.children.at(-1);
    return menu.children[1].children.map(control => control.textContent);
  };
  assert.deepEqual(menuLabels(rendered[0]), ["그룹 색상"]);
  assert.deepEqual(menuLabels(rendered[1]), ["그룹 색상", "그룹 이름 변경", "다른 그룹으로 이동", "위로 이동", "아래로 이동", "그룹만 제거"]);
});

test("group color dialog snapshots its target, rejects invalid input and recovers controls after save failure", async () => {
  const start = script.indexOf("function groupColorDialog(group) {");
  const end = script.indexOf("\nfunction linkDialog(", start);
  assert.ok(start > 0 && end > start);
  const document = documentFixture();
  let submit, body, rejectSave;
  const calls = [];
  const sourceGroup = Object.freeze(group("work", "#112233"));
  const context = vm.createContext({
    state: { revision: 7 }, libraryId: "library-original", document, createGroupColorEditor,
    dispatch: (...args) => { calls.push(args); return new Promise((resolve, reject) => { rejectSave = reject; }); },
    showDialog(title, button, populate, onSubmit) {
      assert.equal(title, "그룹 색상"); assert.equal(button, "저장");
      body = document.createElement("div"); populate(body); submit = onSubmit;
    },
    sourceGroup
  });
  vm.runInContext(`${script.slice(start, end)}\ngroupColorDialog(sourceGroup);`, context);
  assert.equal(calls.length, 0);
  const hex = descendants(body).find(item => item.id === "group-color-hex");
  hex.value = "invalid"; hex.emit("input");
  await assert.rejects(submit(), /여섯 자리/u);
  assert.equal(calls.length, 0);
  assert.notEqual(hex.disabled, true, "invalid input must remain editable");
  hex.value = "#ABCDEF"; hex.emit("input");
  vm.runInContext('state.revision = 99; libraryId = "library-other";', context);
  const pending = submit();
  const colorControls = descendants(body).filter(item => ["BUTTON", "INPUT"].includes(item.tagName));
  assert.equal(colorControls.every(item => item.disabled), true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][0])), { type: "setGroupColor", libraryId: "library-original", groupId: "work", color: "#abcdef" });
  assert.equal(calls[0][1], 7, "stale revisions must reach the service conflict guard, not overwrite new data");
  rejectSave(new Error("저장 실패"));
  await assert.rejects(pending, /저장 실패/u);
  assert.equal(colorControls.every(item => item.disabled === false), true);
  assert.equal(hex.value, "#ABCDEF");
  assert.equal(sourceGroup.color, "#112233");
});
