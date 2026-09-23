import { flattenGroups, identifyUrl } from "./link-library.js";

export function findSavedPage(catalog, url, preferredLibraryId) {
  let key;
  try { key = identifyUrl(url).key; } catch { return null; }
  const libraries = [...(catalog?.libraries || [])].sort((a, b) => Number(b.id === preferredLibraryId) - Number(a.id === preferredLibraryId));
  for (const library of libraries) for (const { group, path } of flattenGroups(library)) {
    const link = group.links.find(item => { try { return identifyUrl(item.url).key === key; } catch { return false; } });
    if (link) return { library, group, path, link };
  }
  return null;
}
