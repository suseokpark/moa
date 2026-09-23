import { DEFAULT_THEME, THEME_PRESETS, validateTheme, resolveTheme } from "./theme.js";
import { createThemeStore } from "./theme-store.js";

const COLORS = [
  ["accent", "theme-accent"], ["lightBackground", "theme-light"], ["darkBackground", "theme-dark"]
];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Themes live outside the catalog: preview, cancel and reset never edit links.
export function initializeThemeSettings({ documentRef = document, store = createThemeStore(), mediaQuery = window.matchMedia("(prefers-color-scheme: dark)") } = {}) {
  const $ = id => documentRef.getElementById(id);
  const dialog = $("theme-dialog");
  let saved = { ...DEFAULT_THEME }, draft = { ...DEFAULT_THEME };
  let loaded = false, saving = false, externalChanges = 0;
  let loadPromise = null;
  let conflict = false, warning = "";
  const presetButtons = [];
  const feedback = message => { $("theme-feedback").textContent = message; };
  const error = message => { $("theme-error").textContent = message; };

  function apply(theme) {
    const resolved = resolveTheme(theme, mediaQuery.matches);
    const root = documentRef.documentElement;
    for (const [key, value] of Object.entries(resolved.tokens)) root.style.setProperty(`--${key}`, value);
    root.style.colorScheme = resolved.mode;
    root.dataset.themeMode = resolved.mode;
    return resolved;
  }
  function controlsBusy(value) {
    for (const element of $("theme-form").querySelectorAll("input,select,button")) element.disabled = value;
    $("theme-form").setAttribute("aria-busy", String(value));
  }
  function reflectPreset() {
    for (const [preset, control] of presetButtons) {
      const selected = COLORS.every(([key]) => preset[key] === draft[key]);
      control.setAttribute("aria-pressed", String(selected));
    }
  }
  function preview() {
    let invalid = false;
    for (const [, id] of COLORS) {
      const field = $(`${id}-hex`);
      const valid = /^#[0-9a-f]{6}$/iu.test(field.value.trim());
      field.setAttribute("aria-invalid", String(!valid));
      invalid ||= !valid;
    }
    $("theme-save").disabled = saving || !loaded || invalid;
    if (invalid) { error("색상은 #과 6자리 영문·숫자로 입력해 주세요. 예: #176b55"); return; }
    draft = validateTheme({ schemaVersion: 1, mode: $("theme-mode").value,
      ...Object.fromEntries(COLORS.map(([key, id]) => [key, $(`${id}-hex`).value.trim()])) });
    for (const [key, id] of COLORS) $(`${id}-picker`).value = draft[key];
    const resolved = apply(draft);
    reflectPreset();
    error("");
    feedback(conflict ? "다른 화면에서 테마가 변경됐습니다. 저장하면 지금 선택으로 바뀌고, 취소하면 최신 테마를 사용합니다."
      : warning || (resolved.adjusted ? "선택한 색을 바탕으로 읽기 좋은 강조색을 미리 보여 드립니다. 저장하면 적용됩니다." : "미리보기 중 · 저장하면 다음에 열 때도 유지됩니다."));
  }
  function fill(theme) {
    draft = { ...theme };
    $("theme-mode").value = draft.mode;
    for (const [key, id] of COLORS) { $(`${id}-picker`).value = draft[key]; $(`${id}-hex`).value = draft[key]; }
    preview();
  }
  function loadingControls(value) {
    for (const element of $("theme-form").querySelectorAll("input,select")) element.disabled = value;
    for (const [, element] of presetButtons) element.disabled = value;
    $("theme-reset").disabled = value;
    $("theme-save").disabled = value || saving;
  }
  function load() {
    if (loadPromise) return loadPromise;
    loadingControls(true);
    const generation = externalChanges;
    loadPromise = Promise.resolve().then(() => store.load()).then(result => {
      if (generation !== externalChanges) return;
      if (!result.ok) { loaded = false; error(`${result.error} 창을 닫았다 다시 열면 재시도합니다.`); return; }
      saved = { ...result.theme }; loaded = true; warning = result.warning || "";
      if (dialog.open) fill(saved); else apply(saved);
    }).catch(() => {
      loaded = false; error("테마 설정을 읽지 못했습니다. 창을 닫았다 다시 열어 주세요.");
    }).finally(() => { loadPromise = null; loadingControls(!loaded); });
    return loadPromise;
  }
  function close() {
    if (saving) return;
    apply(saved); dialog.close(); conflict = false; $("theme-open").focus();
  }
  $("theme-open").addEventListener("click", () => {
    conflict = false; error(""); fill(saved); dialog.showModal(); $("theme-mode").focus();
    if (!loaded) load().catch(() => error("테마 설정을 읽지 못했습니다. 창을 닫았다 다시 열어 주세요."));
  });
  for (const preset of THEME_PRESETS) {
    const control = documentRef.createElement("button");
    control.type = "button"; control.className = "theme-preset";
    control.setAttribute("aria-label", `${preset.name} 테마`);
    const swatch = documentRef.createElement("span"); swatch.className = "theme-swatch";
    swatch.style.backgroundColor = preset.accent; swatch.setAttribute("aria-hidden", "true");
    control.append(swatch, documentRef.createTextNode(preset.name));
    control.addEventListener("click", () => { warning = ""; fill({ schemaVersion: 1, mode: draft.mode, ...Object.fromEntries(COLORS.map(([key]) => [key, preset[key]])) }); });
    presetButtons.push([preset, control]); $("theme-presets").append(control);
  }
  for (const [, id] of COLORS) {
    $(`${id}-picker`).addEventListener("input", () => { warning = ""; $(`${id}-hex`).value = $(`${id}-picker`).value; preview(); });
    $(`${id}-hex`).addEventListener("input", () => { warning = ""; preview(); });
  }
  $("theme-mode").addEventListener("change", preview);
  $("theme-reset").addEventListener("click", () => { warning = ""; fill(DEFAULT_THEME); feedback("기본 테마 미리보기입니다. 저장하면 테마 설정만 초기화됩니다."); });
  $("theme-close").addEventListener("click", close);
  $("theme-cancel").addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  $("theme-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (saving || !loaded) return;
    preview(); if ($("theme-save").disabled) return;
    saving = true; controlsBusy(true); error("");
    const generation = externalChanges;
    try {
      const result = await store.save(draft);
      if (!result.ok) { error(`${result.error} 선택한 색은 아직 저장되지 않았습니다.`); return; }
      // A later storage event can arrive before this save promise completes.
      // Keep the latest observed settings rather than resurrecting its result.
      const superseded = generation !== externalChanges && !same(saved, result.theme);
      if (!superseded) saved = { ...result.theme };
      warning = ""; conflict = false;
      apply(saved); dialog.close(); $("theme-open").focus();
      $("theme-announcement").textContent = superseded || result.superseded ? "다른 화면에서 나중에 저장한 최신 테마를 적용했습니다." : "테마를 이 브라우저에 저장했습니다.";
    } catch { error("테마를 저장하지 못했습니다. 다시 시도하거나 취소해 주세요."); }
    finally { saving = false; controlsBusy(false); }
  });
  const unsubscribe = store.subscribe(theme => {
    externalChanges += 1;
    const changed = !same(saved, theme); saved = { ...theme }; loaded = true;
    if (!dialog.open) apply(saved);
    else if (changed && !saving) { conflict = true; preview(); }
  });
  const modeChanged = () => { if (dialog.open) preview(); else apply(saved); };
  mediaQuery.addEventListener("change", modeChanged);
  apply(saved);
  const ready = load().catch(() => { error("테마 설정을 읽지 못했습니다. 창을 닫았다 다시 열어 주세요."); });
  return { ready, dispose() { unsubscribe(); mediaQuery.removeEventListener("change", modeChanged); } };
}

if (typeof document !== "undefined" && document.getElementById("theme-open")) initializeThemeSettings();
