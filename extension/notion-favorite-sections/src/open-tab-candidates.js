import { identifyUrl } from "./link-library.js";

function candidateTitle(title, url) {
  const clean = typeof title === "string" ? title.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim() : "";
  return (clean || url).slice(0, 300).trim();
}

/** Prepare transient choices only; never retain browser IDs or mutate the source catalog. */
export function prepareOpenTabCandidates(tabs, existingLinks = []) {
  const saved = new Set();
  for (const link of Array.isArray(existingLinks) ? existingLinks : []) {
    try { saved.add(identifyUrl(link?.url).key); } catch { /* Ignore malformed existing metadata. */ }
  }
  const seen = new Set();
  const result = { candidates: [], savedCount: 0, duplicateCount: 0, unsupportedCount: 0 };
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    let identity;
    try {
      if (!tab || tab.incognito) throw new Error("Private tab");
      identity = identifyUrl(tab.url);
    } catch { result.unsupportedCount += 1; continue; }
    // Every tab receives exactly one classification. Repeated saved pages are
    // all counted as saved rather than leaking into the duplicate category.
    if (saved.has(identity.key)) { result.savedCount += 1; continue; }
    if (seen.has(identity.key)) { result.duplicateCount += 1; continue; }
    seen.add(identity.key);
    result.candidates.push({ key: identity.key, title: candidateTitle(tab.title, identity.url), url: identity.url });
  }
  return result;
}
