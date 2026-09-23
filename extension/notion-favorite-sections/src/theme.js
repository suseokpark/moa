// Local appearance preferences are independent of bookmark/backup data. Keep
// user-picked colors intact; only the computed UI palette is contrast-corrected.
export const DEFAULT_THEME = Object.freeze({
  schemaVersion: 1,
  mode: "system",
  accent: "#176b55",
  lightBackground: "#ffffff",
  darkBackground: "#191d1b",
});

export const THEME_PRESETS = Object.freeze([
  { id: "forest", name: "숲", accent: "#176b55", lightBackground: "#ffffff", darkBackground: "#191d1b" },
  { id: "ocean", name: "바다", accent: "#2664ad", lightBackground: "#f7fafc", darkBackground: "#171e27" },
  { id: "lavender", name: "라벤더", accent: "#7854a3", lightBackground: "#fbf9fe", darkBackground: "#211c29" },
  { id: "rose", name: "장미", accent: "#a34865", lightBackground: "#fff9fb", darkBackground: "#291d23" },
  { id: "sunset", name: "노을", accent: "#a55321", lightBackground: "#fffbf5", darkBackground: "#282019" },
  { id: "graphite", name: "흑연", accent: "#535e69", lightBackground: "#f8f9fa", darkBackground: "#1d2024" },
].map((preset) => Object.freeze(preset)));

const THEME_KEYS = Object.keys(DEFAULT_THEME).sort();
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function validateTheme(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Object.getOwnPropertySymbols(raw).length
    || Object.getOwnPropertyNames(raw).sort().join(",") !== THEME_KEYS.join(",")
    || Object.values(Object.getOwnPropertyDescriptors(raw)).some((descriptor) => !Object.hasOwn(descriptor, "value"))) {
    throw new TypeError("테마 설정 형식이 올바르지 않습니다.");
  }
  if (raw.schemaVersion !== 1 || !["system", "light", "dark"].includes(raw.mode)) {
    throw new TypeError("지원하지 않는 테마 설정입니다.");
  }
  for (const key of ["accent", "lightBackground", "darkBackground"]) {
    if (typeof raw[key] !== "string" || !HEX_COLOR.test(raw[key])) {
      throw new TypeError("색상은 #RRGGBB 형식으로 입력해 주세요.");
    }
  }
  return {
    schemaVersion: 1,
    mode: raw.mode,
    accent: raw.accent.toLowerCase(),
    lightBackground: raw.lightBackground.toLowerCase(),
    darkBackground: raw.darkBackground.toLowerCase(),
  };
}

function channels(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function mix(from, toward, amount) {
  const target = channels(toward);
  return `#${channels(from).map((channel, index) => Math.round(channel + (target[index] - channel) * amount)
    .toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex) {
  const linear = channels(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(first, second) {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

function correctContrast(seed, backgrounds, minimum, toward) {
  // Test the rounded final hex colors, not an unrounded intermediate value.
  // At most 256 steps; the supplied endpoint is guaranteed to be legible.
  for (let step = 0; step <= 255; step += 1) {
    const candidate = mix(seed, toward, step / 255);
    if (backgrounds.every((background) => contrast(candidate, background) >= minimum)) return candidate;
  }
  throw new RangeError("테마의 색상 대비를 구성할 수 없습니다.");
}

export function resolveTheme(raw = DEFAULT_THEME, systemDark = false) {
  const theme = validateTheme(raw);
  const mode = theme.mode === "system" ? (systemDark ? "dark" : "light") : theme.mode;
  const bg = mode === "dark" ? theme.darkBackground : theme.lightBackground;
  // Users may choose a dark color in light mode (or the reverse). Foreground
  // polarity must follow the actual background, not the name of the mode.
  const foreground = contrast(bg, "#000000") >= contrast(bg, "#ffffff") ? "#000000" : "#ffffff";
  const backgroundPole = foreground === "#000000" ? "#ffffff" : "#000000";
  const minimumSurfaceContrast = Math.min(7, contrast(bg, foreground));
  const safeSurface = (candidate) => correctContrast(candidate, [foreground], minimumSurfaceContrast, backgroundPole);
  const surface = safeSurface(mix(bg, "#ffffff", 0.04));
  const subtle = safeSurface(mix(bg, foreground, 0.035));
  const hover = safeSurface(mix(bg, foreground, 0.06));
  const tint = safeSurface(mix(bg, theme.accent, 0.08));
  const surfaces = [bg, surface, subtle, hover, tint];
  const accent = correctContrast(theme.accent, surfaces, 4.5, foreground);
  const accentHover = mix(accent, foreground, 0.15);
  const tokens = {
    bg,
    surface,
    subtle,
    text: correctContrast(mix(foreground, bg, 0.14), surfaces, 4.5, foreground),
    muted: correctContrast(mix(foreground, bg, 0.45), surfaces, 4.5, foreground),
    line: mix(bg, foreground, 0.14),
    "input-line": correctContrast(mix(foreground, bg, 0.6), [bg, surface], 3, foreground),
    accent,
    "accent-hover": accentHover,
    "on-accent": backgroundPole,
    tint,
    hover,
    danger: correctContrast(foreground === "#000000" ? "#ac352e" : "#ffb4a9", surfaces, 4.5, foreground),
    shadow: foreground === "#000000" ? "0 12px 36px #172c201a, 0 2px 8px #172c200d" : "0 12px 36px #0005, 0 2px 8px #0003",
  };
  return { mode, tokens, adjusted: accent !== theme.accent };
}
