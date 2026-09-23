// Group colors decorate dots, connectors and a soft background; text uses contrast-safe theme tokens.
export const GROUP_COLOR_PRESETS = Object.freeze([
  { name: "초록", color: "#34856a" }, { name: "파랑", color: "#4b80d6" },
  { name: "보라", color: "#9470ce" }, { name: "분홍", color: "#ce668e" },
  { name: "주황", color: "#d38440" }, { name: "노랑", color: "#c7a53c" },
  { name: "청록", color: "#389ba3" }, { name: "회색", color: "#85918c" }
].map(Object.freeze));

/** A local draft only. The caller explicitly saves through the catalog service. */
export function createGroupColorEditor({ documentRef = document, group }) {
  const make = (tag, className, text) => {
    const element = documentRef.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const element = make("div", "group-color-editor");
  const preview = make("div", "group-color-preview");
  const mark = make("span", "group-color-dot");
  mark.setAttribute("aria-hidden", "true");
  preview.append(mark, make("strong", "group-color-name", group.name));
  const status = make("p", "form-note");
  status.setAttribute("aria-live", "polite");
  const choices = make("fieldset", "theme-presets");
  choices.append(make("legend", "", "색상 선택"));
  const grid = make("div", "group-color-grid");
  const buttons = [];
  let draft = group.color ?? null;
  const colorRow = make("div", "theme-color-row group-custom-color");
  const label = make("label", "", "직접 지정");
  label.htmlFor = "group-color-hex";
  const picker = make("input"); picker.type = "color";
  picker.setAttribute("aria-label", "그룹 색상 선택기");
  const hex = make("input"); hex.type = "text"; hex.id = "group-color-hex";
  hex.maxLength = 7; hex.placeholder = "#RRGGBB"; hex.autocomplete = "off"; hex.spellcheck = false;
  hex.setAttribute("aria-describedby", "group-color-help group-color-error");
  const error = make("p", "error"); error.id = "group-color-error";
  error.setAttribute("aria-live", "polite");
  const help = make("p", "form-note", "그룹 표식·연결선과 연한 배경에 적용됩니다. 하위 그룹은 따로 지정하며, 비워두면 기본 색상을 사용합니다.");
  help.id = "group-color-help";
  const paint = () => {
    preview.style.setProperty("--group-color", draft || "var(--muted)");
    status.textContent = draft ? `선택한 색상 · ${draft.toUpperCase()}` : "기본 색상 · 테마에 맞춰 표시";
    for (const [control, value] of buttons) control.setAttribute("aria-pressed", String(value === draft));
  };
  const choose = color => {
    draft = color; hex.value = color || ""; picker.value = color || "#34856a";
    hex.setAttribute("aria-invalid", "false"); error.textContent = ""; paint();
  };
  const choice = (name, color) => {
    const control = make("button", "theme-preset", name); control.type = "button";
    if (color) {
      const swatch = make("span", "theme-swatch");
      swatch.style.backgroundColor = color; swatch.setAttribute("aria-hidden", "true");
      control.prepend(swatch);
    }
    control.addEventListener("click", () => choose(color));
    buttons.push([control, color]); return control;
  };
  for (const { name, color } of GROUP_COLOR_PRESETS) grid.append(choice(name, color));
  choices.append(grid);
  const reset = choice("기본 색상", null); reset.className = "quiet-button";
  const read = () => {
    const value = hex.value.trim();
    const valid = !value || /^#[0-9a-f]{6}$/i.test(value);
    hex.setAttribute("aria-invalid", String(!valid));
    error.textContent = valid ? "" : "#34856A처럼 #과 여섯 자리 색상 코드를 입력해 주세요.";
    if (valid) { draft = value.toLowerCase() || null; if (draft) picker.value = draft; paint(); }
    return valid;
  };
  hex.addEventListener("input", read);
  picker.addEventListener("input", () => choose(picker.value));
  colorRow.append(label, picker, hex);
  element.append(preview, status, choices, colorRow, error, reset, help);
  choose(draft);
  return {
    element,
    setBusy(busy) {
      for (const [control] of buttons) control.disabled = busy;
      picker.disabled = busy; hex.disabled = busy;
      element.setAttribute("aria-busy", String(busy));
    },
    getColor() {
      if (!read()) { hex.focus(); throw new Error(error.textContent); }
      return draft;
    }
  };
}
