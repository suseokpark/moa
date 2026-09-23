import { identifyUrl } from "./link-library.js";

function cleanText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim() : "";
}

function prepareCandidates(items, existingLinks, { bookmark = false } = {}) {
  const saved = new Set();
  for (const link of Array.isArray(existingLinks) ? existingLinks : []) {
    try { saved.add(identifyUrl(link?.url).key); } catch { /* Ignore malformed existing metadata. */ }
  }
  const seen = new Set();
  const result = { candidates: [], savedCount: 0, duplicateCount: 0, unsupportedCount: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    let identity;
    try {
      if (!item || (!bookmark && item.incognito)) throw new Error("Unsupported item");
      identity = identifyUrl(item.url);
    } catch { result.unsupportedCount += 1; continue; }
    // Every item receives exactly one classification. Repeated saved pages are
    // all counted as saved rather than leaking into the duplicate category.
    if (saved.has(identity.key)) { result.savedCount += 1; continue; }
    if (seen.has(identity.key)) { result.duplicateCount += 1; continue; }
    seen.add(identity.key);
    result.candidates.push({
      key: identity.key,
      title: (cleanText(item.title) || identity.url).slice(0, 300).trim(),
      url: identity.url,
      ...(bookmark ? { folderPath: cleanText(item.folderPath).slice(0, 1000).trim() } : {})
    });
  }
  return result;
}

/** Prepare transient choices only; never retain browser IDs or mutate the source catalog. */
export function prepareOpenTabCandidates(tabs, existingLinks = []) {
  return prepareCandidates(tabs, existingLinks);
}

/** Folder paths describe source choices only; callers persist selected titles and URLs, not browser metadata. */
export function prepareBookmarkCandidates(items, existingLinks = []) {
  return prepareCandidates(items, existingLinks, { bookmark: true });
}
