import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THEME, THEME_PRESETS, validateTheme, resolveTheme } from "../src/theme.js";

// Independent WCAG calculation so regressions in the engine are not masked by
// testing contrast with the same implementation that generated the palette.
function relativeLuminance(hex) {
  const rgb = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255)
    .map((value) => value > 0.04045 ? ((value + 0.055) / 1.055) ** 2.4 : value / 12.92);
  return rgb.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function assertContrast(first, second, minimum, description) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => a - b);
  const ratio = (values[1] + 0.05) / (values[0] + 0.05);
  assert.ok(ratio >= minimum, `${description}: ${first} on ${second} gives ${ratio}, expected ${minimum}`);
}

function assertPalette(theme, systemDark = false) {
  const { tokens } = resolveTheme(theme, systemDark);
  for (const [name, value] of Object.entries(tokens)) {
    if (name !== "shadow") assert.match(value, /^#[0-9a-f]{6}$/, name);
  }
  for (const background of ["bg", "surface", "subtle", "hover", "tint"]) {
    for (const foreground of ["text", "muted", "accent", "accent-hover", "danger"]) {
      assertContrast(tokens[foreground], tokens[background], 4.5, `${foreground}/${background}`);
    }
  }
  for (const background of ["accent", "accent-hover"]) {
    assertContrast(tokens["on-accent"], tokens[background], 4.5, `on-accent/${background}`);
  }
  for (const background of ["bg", "surface"]) {
    assertContrast(tokens["input-line"], tokens[background], 3, `input-line/${background}`);
  }
}

test("theme defaults and presets are immutable and valid", () => {
  assert.equal(Object.isFrozen(DEFAULT_THEME), true);
  assert.equal(Object.isFrozen(THEME_PRESETS), true);
  assert.equal(THEME_PRESETS.length, 6);
  assert.equal(new Set(THEME_PRESETS.map((preset) => preset.id)).size, THEME_PRESETS.length);
  for (const { id, name, ...colors } of THEME_PRESETS) {
    assert.equal(Object.isFrozen(THEME_PRESETS.find((preset) => preset.id === id)), true);
    assert.ok(name);
    const theme = validateTheme({ ...DEFAULT_THEME, ...colors });
    assertPalette(theme, false);
    assertPalette(theme, true);
  }
});

test("valid theme colors are canonicalized into an independent clone", () => {
  const input = { ...DEFAULT_THEME, accent: "#AABBCC", darkBackground: "#ABCDEF" };
  const snapshot = structuredClone(input);
  const output = validateTheme(input);
  assert.notEqual(input, output);
  assert.equal(output.accent, "#aabbcc");
  assert.equal(output.darkBackground, "#abcdef");
  output.mode = "light";
  assert.deepEqual(input, snapshot);
  assert.deepEqual(validateTheme(Object.assign(Object.create(null), DEFAULT_THEME)), DEFAULT_THEME);
});

test("invalid schemas, unsafe CSS values, missing and extra keys are rejected", () => {
  for (const input of [undefined, null, [], "dark", false, 1, new Date(), {},
    { ...DEFAULT_THEME, schemaVersion: 2 }, { ...DEFAULT_THEME, schemaVersion: "1" },
    { ...DEFAULT_THEME, mode: "auto" }, { ...DEFAULT_THEME, extra: "value" },
    { ...DEFAULT_THEME, [Symbol("extra")]: true }]) {
    assert.throws(() => validateTheme(input), TypeError);
  }
  for (const key of Object.keys(DEFAULT_THEME)) {
    const missing = { ...DEFAULT_THEME };
    delete missing[key];
    assert.throws(() => validateTheme(missing), TypeError);
  }
  const accessorTheme = { ...DEFAULT_THEME };
  Object.defineProperty(accessorTheme, "accent", { get() { throw new Error("Accessor should never run"); } });
  assert.throws(() => validateTheme(accessorTheme), TypeError);
  for (const color of ["#fff", "#00000000", "white", "rgb(0,0,0)", "#gg0000", "000000",
    " #000000", "#000000 ", "#000000\n", "url(https://example.com)", "#000000;display:none", null, 0, {}]) {
    for (const key of ["accent", "lightBackground", "darkBackground"]) {
      assert.throws(() => validateTheme({ ...DEFAULT_THEME, [key]: color }), TypeError);
    }
  }
  assert.throws(() => resolveTheme(null), TypeError);
});

test("system, light and dark modes select the correct unchanged background seed", () => {
  assert.equal(resolveTheme().mode, "light");
  assert.equal(resolveTheme(undefined, true).mode, "dark");
  for (const mode of ["system", "light", "dark"]) {
    for (const systemDark of [false, true]) {
      const theme = { ...DEFAULT_THEME, mode };
      const resolved = resolveTheme(theme, systemDark);
      const expectedMode = mode === "system" ? (systemDark ? "dark" : "light") : mode;
      assert.equal(resolved.mode, expectedMode);
      assert.equal(resolved.tokens.bg, theme[expectedMode === "dark" ? "darkBackground" : "lightBackground"]);
    }
  }
});

test("contrast correction preserves requested colors and reports adjusted accents", () => {
  assert.equal(resolveTheme(DEFAULT_THEME, false).tokens.accent, DEFAULT_THEME.accent);
  assert.equal(resolveTheme(DEFAULT_THEME, false).adjusted, false);
  for (const mode of ["light", "dark"]) {
    const theme = { ...DEFAULT_THEME, mode, accent: mode === "light" ? "#ffffff" : "#000000" };
    const snapshot = structuredClone(theme);
    const resolved = resolveTheme(theme);
    assert.equal(resolved.adjusted, true);
    assert.notEqual(resolved.tokens.accent, theme.accent);
    assert.deepEqual(theme, snapshot);
    assertPalette(theme);
  }
});

test("arbitrary backgrounds and accent extremes remain legible on all UI surfaces", () => {
  const colors = ["#000000", "#ffffff", "#757575", "#767676", "#777777", "#7f7f7f", "#808080",
    "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#00ffff", "#ff00ff", "#176b55", "#101010", "#eeeeee"];
  for (const background of colors) {
    for (const accent of colors) {
      for (const mode of ["light", "dark"]) {
        assertPalette({ ...DEFAULT_THEME, mode, accent, lightBackground: background, darkBackground: background });
      }
    }
  }
});

test("seeded RGB samples and every grayscale background meet contrast thresholds", () => {
  let seed = 123456789;
  const nextColor = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return `#${(seed & 0xffffff).toString(16).padStart(6, "0")}`;
  };
  for (let index = 0; index < 256; index += 1) {
    const channel = index.toString(16).padStart(2, "0");
    const gray = `#${channel.repeat(3)}`;
    assertPalette({ ...DEFAULT_THEME, accent: nextColor(), lightBackground: gray, darkBackground: gray }, index % 2 === 0);
    assertPalette({ ...DEFAULT_THEME, accent: nextColor(), lightBackground: nextColor(), darkBackground: nextColor() }, index % 2 === 0);
  }
});

test("resolved token objects are independent and deterministic", () => {
  const first = resolveTheme();
  const second = resolveTheme();
  assert.deepEqual(first, second);
  assert.notEqual(first.tokens, second.tokens);
  first.tokens.accent = "#000000";
  assert.equal(resolveTheme().tokens.accent, DEFAULT_THEME.accent);
});
