const isId = value => typeof value === "string" && value.length > 0;
const idSet = values => new Set(
  values && typeof values !== "string" && typeof values[Symbol.iterator] === "function"
    ? [...values].filter(isId) : []
);

/** Ephemeral link selection, scoped to one library. Pass all link IDs to reconcile. */
export function createLinkSelection() {
  let libraryId = null, active = false, valid = new Set();
  const selected = new Set();

  const stop = () => {
    const changed = active || selected.size > 0;
    active = false; selected.clear();
    return changed;
  };
  const reconcile = (nextLibraryId, validIds) => {
    const nextId = isId(nextLibraryId) ? nextLibraryId : null;
    let changed = false;
    if (nextId !== libraryId || nextId === null) changed = stop();
    libraryId = nextId;
    valid = nextId === null ? new Set() : idSet(validIds);
    for (const id of selected) {
      if (!valid.has(id)) { selected.delete(id); changed = true; }
    }
    return changed;
  };

  return {
    isActive: () => active,
    selected: () => [...selected],
    has: id => selected.has(id),
    count: () => selected.size,
    start(nextLibraryId, validIds) {
      let changed = false;
      if (validIds !== undefined || nextLibraryId !== libraryId) {
        changed = reconcile(nextLibraryId, validIds);
      }
      if (libraryId === null) return changed;
      changed = !active || changed;
      active = true;
      return changed;
    },
    stop,
    reconcile,
    toggle(id) {
      if (!active || !valid.has(id)) return false;
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return true;
    },
    toggleVisible(visibleIds) {
      if (!active) return false;
      const visible = [...idSet(visibleIds)].filter(id => valid.has(id));
      if (visible.length === 0) return false;
      const deselect = visible.every(id => selected.has(id));
      for (const id of visible) {
        if (deselect) selected.delete(id);
        else selected.add(id);
      }
      return true;
    }
  };
}
