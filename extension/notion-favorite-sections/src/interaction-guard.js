/** Keep DOM replacements out of a pointer gesture, including its final click. */
export function createInteractionGuard({
  eventTarget = globalThis.document,
  windowTarget = globalThis.window,
  onIdle = () => {},
  schedule = callback => setTimeout(callback, 0),
  cancel = clearTimeout
} = {}) {
  let active = false, destroyed = false, pointerId = null;
  let releaseTask = null, releaseGeneration = 0;

  const cancelRelease = () => {
    releaseGeneration += 1;
    if (releaseTask !== null) cancel(releaseTask);
    releaseTask = null;
  };
  const releaseAfterDispatch = () => {
    if (!active || destroyed) return;
    cancelRelease();
    const generation = releaseGeneration;
    releaseTask = schedule(() => {
      if (destroyed || generation !== releaseGeneration || !active) return;
      releaseTask = null;
      active = false; pointerId = null;
      onIdle();
    });
  };
  const start = event => {
    // Middle/right mouse buttons are primary pointers too. Ignore extra touches.
    if (destroyed || event.isPrimary === false) return;
    cancelRelease();
    active = true; pointerId = event.pointerId ?? null;
  };
  const end = event => {
    if (!active || event.isPrimary === false || (event.pointerId ?? null) !== pointerId) return;
    // pointerup precedes click/auxclick; a microtask would release too early.
    releaseAfterDispatch();
  };
  const visibilityChanged = () => {
    if (eventTarget?.visibilityState === "hidden") releaseAfterDispatch();
  };

  eventTarget?.addEventListener("pointerdown", start, true);
  eventTarget?.addEventListener("pointerup", end, true);
  eventTarget?.addEventListener("pointercancel", end, true);
  eventTarget?.addEventListener("visibilitychange", visibilityChanged);
  windowTarget?.addEventListener("blur", releaseAfterDispatch);

  return {
    isActive: () => active,
    destroy() {
      destroyed = true; cancelRelease();
      active = false; pointerId = null;
      eventTarget?.removeEventListener("pointerdown", start, true);
      eventTarget?.removeEventListener("pointerup", end, true);
      eventTarget?.removeEventListener("pointercancel", end, true);
      eventTarget?.removeEventListener("visibilitychange", visibilityChanged);
      windowTarget?.removeEventListener("blur", releaseAfterDispatch);
    }
  };
}
