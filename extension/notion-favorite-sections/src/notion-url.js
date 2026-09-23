(function initializeNotionUrls(root) {
  "use strict";

  const APP_ORIGIN = "https://app.notion.com";
  const LEGACY_ORIGIN = "https://www.notion.so";
  const ID_SOURCE = "(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
  const EXACT_ID = new RegExp(`^${ID_SOURCE}$`, "i");
  const SUFFIX_ID = new RegExp(`(?:^|[-_])(${ID_SOURCE})$`, "i");
  const MAX_URL_LENGTH = 4096;

  function normalizePageId(value) {
    if (typeof value !== "string" || !EXACT_ID.test(value.trim())) return null;
    return value.trim().replaceAll("-", "").toLowerCase();
  }

  function parsePageUrl(value, { base, allowLegacyHost = false } = {}) {
    const raw = typeof value === "string" ? value : value?.href;
    if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(raw)) return null;
    try {
      const baseHref = typeof base === "string" ? base : base?.href || base?.origin || APP_ORIGIN;
      const url = new URL(raw.trim(), baseHref);
      if (url.href.length > MAX_URL_LENGTH || url.protocol !== "https:" || url.username || url.password ||
        (url.origin !== APP_ORIGIN && !(allowLegacyHost && url.origin === LEGACY_ORIGIN))) return null;
      const segments = url.pathname.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
      if (segments.some(segment => /[/\\\u0000-\u001f\u007f-\u009f]/u.test(segment))) return null;
      const match = segments.at(-1)?.match(SUFFIX_ID);
      const pageId = match ? normalizePageId(match[1]) : null;
      return pageId ? { url, pageId, segments } : null;
    } catch { return null; }
  }

  function extractPageId(value, base) {
    return parsePageUrl(value, { base })?.pageId || null;
  }

  function safePageUrl(value, options = {}) {
    const parsed = parsePageUrl(value, options);
    if (!parsed || (options.pageId !== undefined && normalizePageId(options.pageId) !== parsed.pageId)) return null;
    return parsed.url.href;
  }

  // Choose among observed addresses only. Never synthesize a workspace route
  // from a different page, or downgrade a known scoped URL to an ID-only one.
  // First candidate wins equally specific ties; a verified current URL can be
  // used directly by the caller when the actual location is authoritative.
  function preferredPageUrl(pageId, values, options = {}) {
    const id = normalizePageId(pageId);
    if (!id || !Array.isArray(values)) return null;
    let best = null;
    let bestRank = -1;
    for (const value of values) {
      const parsed = parsePageUrl(value, options);
      if (!parsed || parsed.pageId !== id) continue;
      const { segments } = parsed;
      const rank = (segments[0] === "p" ? segments.length >= 3 : segments.length >= 2)
        ? 3 : segments.length > 1 || !EXACT_ID.test(segments[0]) ? 2 : 1;
      if (rank > bestRank) { best = parsed.url.href; bestRank = rank; }
    }
    return best;
  }

  const namespace = root.NotionFavoriteSections = root.NotionFavoriteSections || {};
  namespace.urls = Object.freeze({ normalizePageId, extractPageId, safePageUrl, preferredPageUrl });
})(globalThis);
