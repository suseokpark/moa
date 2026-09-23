(function initializeNotionTreePanel(globalScope) {
  "use strict";

  const namespace = globalScope.NotionFavoriteSections || {};
  const activeShells = new WeakMap();
  const SURFACE_BACKGROUND = "rgb(249, 248, 247)";
  let shellSequence = 0;

  const TRIGGER_STYLE_TEXT = `
    :host {
      display: contents !important;
      color-scheme: inherit;
    }

    *, *::before, *::after { box-sizing: border-box; }
    button { color: inherit; font: inherit; }

    .ntree-trigger-shell {
      display: contents;
      color: inherit;
      font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .ntree-trigger {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      min-width: 58px;
      height: 32px;
      margin: 0;
      padding: 0 6px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      white-space: nowrap;
    }

    .ntree-trigger-icon {
      display: block;
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      align-self: center;
      color: inherit;
    }

    .ntree-trigger-label {
      display: block;
      line-height: 1;
    }

    .ntree-trigger[data-compact] { min-width: 32px; padding: 0 8px; }
    .ntree-trigger[data-compact] .ntree-trigger-label { display: none; }

    .ntree-trigger:hover,
    .ntree-trigger:focus-visible,
    .ntree-trigger[aria-expanded="true"] {
      background: rgba(127, 127, 127, .14);
      outline: none;
    }

    .ntree-trigger:focus-visible {
      box-shadow: inset 0 0 0 2px #2383e2;
    }
  `;

  const PANEL_STYLE_TEXT = `
    :host {
      display: block;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      background: var(--ntree-surface, ${SURFACE_BACKGROUND});
      color: var(--ntree-text, rgb(55, 53, 47));
      color-scheme: inherit;
      font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    :host([hidden]) { display: none !important; }

    *, *::before, *::after { box-sizing: border-box; }
    button { color: inherit; font: inherit; }
    [hidden] { display: none !important; }

    .ntree-panel {
      display: flex;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      flex-direction: column;
      overflow: hidden;
      background: var(--ntree-surface, ${SURFACE_BACKGROUND});
      color: inherit;
    }

    .ntree-panel-header {
      display: flex;
      align-items: center;
      min-height: 42px;
      padding: 6px 7px 6px 12px;
      flex: 0 0 auto;
      gap: 8px;
      border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
      background: var(--ntree-surface, ${SURFACE_BACKGROUND});
    }

    .ntree-panel-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ntree-panel-icon {
      display: block;
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
    }

    .ntree-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }

    .ntree-close:hover,
    .ntree-close:focus-visible {
      background: color-mix(in srgb, currentColor 8%, transparent);
      outline: none;
    }

    .ntree-close:focus-visible {
      box-shadow: inset 0 0 0 2px #2383e2;
    }

    .ntree-panel-scroll {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      flex: 1 1 auto;
      overflow: auto;
      overscroll-behavior: contain;
      background: var(--ntree-surface, ${SURFACE_BACKGROUND});
    }

    .ntree-content-host {
      display: flex;
      flex-direction: column;
      flex: 1 0 auto;
      min-width: 0;
      min-height: 0;
      background: var(--ntree-surface, ${SURFACE_BACKGROUND});
    }
  `;

  function element(documentRef, tagName, options = {}) {
    const node = documentRef.createElement(tagName);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = String(options.text);
    for (const [name, value] of Object.entries(options.attributes || {})) {
      if (value !== null && value !== undefined) {
        node.setAttribute(name, String(value));
      }
    }
    return node;
  }

  function eventPathContains(event, node) {
    if (!event || !node) return false;
    if (typeof event.composedPath === "function") {
      try {
        if (event.composedPath().includes(node)) return true;
      } catch (_error) {
        // Fall through to the target containment check.
      }
    }
    const target = event.target;
    return Boolean(
      target &&
        (target === node ||
          (typeof node.contains === "function" && node.contains(target)))
    );
  }

  function deepActiveElement(documentRef) {
    let active = documentRef.activeElement || null;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function rgbaChannels(value) {
    const match = String(value || "").match(/^rgba?\(([^)]+)\)$/iu);
    if (!match) return null;
    const tokens = match[1].split(/[\s,/]+/u).filter(Boolean);
    if (tokens.length < 3 || tokens.length > 4) return null;
    const values = tokens.map((token, index) => Number.parseFloat(token) * (token.endsWith("%") ? (index === 3 ? 0.01 : 2.55) : 1));
    if (values.some((value) => !Number.isFinite(value))) return null;
    return [Math.min(255, Math.max(0, values[0])), Math.min(255, Math.max(0, values[1])), Math.min(255, Math.max(0, values[2])), Math.min(1, Math.max(0, values[3] ?? 1))];
  }

  function createPanelShell(options) {
    const host = options?.host;
    const viewHost = options?.viewHost;
    if (
      !host ||
      typeof host.attachShadow !== "function" ||
      !host.ownerDocument ||
      !host.style
    ) {
      throw new TypeError("FAVMOA panel requires a trigger host element.");
    }
    if (
      !viewHost ||
      typeof viewHost.attachShadow !== "function" ||
      viewHost.ownerDocument !== host.ownerDocument ||
      !viewHost.style
    ) {
      throw new TypeError("FAVMOA panel requires an internal view host element.");
    }
    if (
      options.onOpenChange !== undefined &&
      typeof options.onOpenChange !== "function"
    ) {
      throw new TypeError("onOpenChange must be a function when provided.");
    }

    activeShells.get(host)?.destroy();

    const documentRef = host.ownerDocument;
    const windowRef = documentRef.defaultView || globalScope;
    const shadowRoot = host.shadowRoot || host.attachShadow({ mode: "open" });
    const panelShadowRoot =
      viewHost.shadowRoot || viewHost.attachShadow({ mode: "open" });
    const onOpenChange = options.onOpenChange || null;
    const shellId = ++shellSequence;
    const panelId = `ntree-panel-${shellId}`;
    const titleId = `ntree-panel-title-${shellId}`;

    const triggerStyle = element(documentRef, "style", {
      text: TRIGGER_STYLE_TEXT
    });
    const triggerShell = element(documentRef, "div", {
      className: "ntree-trigger-shell"
    });
    const trigger = element(documentRef, "button", {
      className: "ntree-trigger",
      attributes: {
        type: "button",
        title: "FAVMOA · 즐겨찾기 정리",
        "aria-label": "FAVMOA",
        "aria-expanded": "false"
      }
    });
    const triggerIcon = namespace.brand.createIcon(documentRef, { className: "ntree-trigger-icon" });
    const triggerLabel = element(documentRef, "span", {
      className: "ntree-trigger-label",
      text: "FAVMOA"
    });
    trigger.append(triggerIcon, triggerLabel);

    const panelStyle = element(documentRef, "style", { text: PANEL_STYLE_TEXT });
    const panel = element(documentRef, "section", {
      className: "ntree-panel",
      attributes: {
        id: panelId,
        role: "region",
        tabindex: "-1",
        "aria-labelledby": titleId,
        "aria-hidden": "true"
      }
    });
    const header = element(documentRef, "header", {
      className: "ntree-panel-header"
    });
    const title = element(documentRef, "div", {
      className: "ntree-panel-title",
      text: "FAVMOA",
      attributes: { id: titleId }
    });
    const closeButton = element(documentRef, "button", {
      className: "ntree-close",
      text: "×",
      attributes: {
        type: "button",
        title: "FAVMOA 닫기",
        "aria-label": "FAVMOA 패널 닫기"
      }
    });
    const scrollShell = element(documentRef, "div", {
      className: "ntree-panel-scroll"
    });
    const contentHost = element(documentRef, "div", {
      className: "ntree-content-host",
      attributes: {
        "data-notion-tree-panel-content-host": "",
        "aria-label": "FAVMOA 즐겨찾기 트리"
      }
    });

    triggerShell.append(trigger);
    shadowRoot.replaceChildren(triggerStyle, triggerShell);
    scrollShell.append(contentHost);
    header.append(namespace.brand.createIcon(documentRef, { size: 20, className: "ntree-panel-icon" }), title, closeButton);
    panel.append(header, scrollShell);
    panelShadowRoot.replaceChildren(panelStyle, panel);

    host.style.display = "contents";
    viewHost.style.position = "absolute";
    viewHost.style.inset = "0px";
    viewHost.style.zIndex = "2147483645";
    viewHost.style.isolation = "isolate";
    viewHost.style.overflow = "hidden";
    viewHost.style.backgroundColor = SURFACE_BACKGROUND;
    viewHost.style.color = "rgb(55, 53, 47)";
    viewHost.hidden = true;
    panel.hidden = true;

    let openState = false;
    let destroyed = false;
    let focusBeforeOpen = null;
    const navigation = host.closest?.('[role="tablist"]') || null;
    const sidebar = host.closest?.("nav") || navigation || host.parentElement;
    const themeAncestors = [];
    for (let node = sidebar; node; node = node.parentElement) themeAncestors.push(node);
    function syncTheme() {
      if (destroyed) return;
      // Composite the rendered ancestor backgrounds into an opaque surface.
      // Alpha from Notion styling never allows the covered native panel through.
      let background = [249, 248, 247];
      for (const node of [...themeAncestors].reverse()) {
        const layer = rgbaChannels(windowRef.getComputedStyle?.(node)?.backgroundColor);
        if (!layer) continue;
        background = background.map((channel, index) => Math.round(layer[index] * layer[3] + channel * (1 - layer[3])));
      }
      const dark = background[0] * 0.299 + background[1] * 0.587 + background[2] * 0.114 < 128;
      const nativeColor = rgbaChannels(windowRef.getComputedStyle?.(sidebar)?.color);
      const foreground = nativeColor && nativeColor[3] > 0.8
        ? nativeColor.slice(0, 3).map(Math.round)
        : dark ? [241, 241, 239] : [55, 53, 47];
      const surface = `rgb(${background.join(", ")})`;
      const text = `rgb(${foreground.join(", ")})`;
      viewHost.style.backgroundColor = surface;
      viewHost.style.color = text;
      viewHost.style.colorScheme = dark ? "dark" : "light";
      viewHost.style.setProperty("--ntree-surface", surface);
      viewHost.style.setProperty("--ntree-text", text);
      host.style.colorScheme = dark ? "dark" : "light";
      for (const node of [host, viewHost]) {
        node.style.setProperty("--moa-ink", dark ? namespace.brand.colors.mint : namespace.brand.colors.ink);
        node.style.setProperty("--moa-mint", dark ? namespace.brand.colors.ink : namespace.brand.colors.mint);
      }
    }
    function fitTrigger() {
      if (!navigation || destroyed) return;
      const navigationRect = navigation.getBoundingClientRect?.();
      const width = navigation.clientWidth || navigationRect?.width || 0;
      if (!width) return;
      const scale = (navigationRect?.width || width) / (navigation.offsetWidth || width);
      const nativeTabs = Array.from(navigation.querySelectorAll?.('[role="tab"]') || []);
      const occupied = nativeTabs.reduce((sum, tab) => sum + Math.max((tab.getBoundingClientRect?.().width || 0) / scale, tab.scrollWidth || 0), 0);
      const gap = Number.parseFloat(windowRef.getComputedStyle?.(navigation)?.columnGap) || 0;
      const wrapped = nativeTabs.some((tab) => {
        const rect = tab.getBoundingClientRect?.();
        const lineHeight = Number.parseFloat(windowRef.getComputedStyle?.(tab)?.lineHeight) || 18;
        return (tab.scrollWidth || 0) > (tab.clientWidth || (rect?.width || 0) / scale) + 1 || (rect?.height || 0) / scale > lineHeight * 2 + 8;
      });
      if ((nativeTabs.length >= 4 && width < 320) || wrapped || width - occupied - gap * nativeTabs.length < 64) trigger.setAttribute("data-compact", "");
      else trigger.removeAttribute("data-compact");
    }
    const resizeObserver = typeof windowRef.ResizeObserver === "function"
      ? new windowRef.ResizeObserver(fitTrigger)
      : null;
    if (navigation) resizeObserver?.observe(navigation);
    const themeObserver = typeof windowRef.MutationObserver === "function"
      ? new windowRef.MutationObserver(syncTheme)
      : null;
    for (const node of themeAncestors) themeObserver?.observe(node, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-mode"] });
    const themeQuery = windowRef.matchMedia?.("(prefers-color-scheme: dark)");
    themeQuery?.addEventListener?.("change", syncTheme);
    windowRef.addEventListener?.("resize", fitTrigger);
    syncTheme();
    fitTrigger();

    function notifyOpenChange() {
      if (!onOpenChange) return;
      try {
        onOpenChange(openState);
      } catch (error) {
        globalScope.console?.warn?.("FAVMOA panel callback failed.", error);
      }
    }

    function onDocumentPointerDown(event) {
      if (
        !openState ||
        eventPathContains(event, host) ||
        eventPathContains(event, viewHost)
      ) {
        return;
      }
      close({ restoreFocus: false });
    }

    function onPanelKeyDown(event) {
      // Inner pickers and forms receive Escape first in the bubbling phase.
      if (!openState || event?.defaultPrevented) return;
      if (event?.key === "Escape") {
        const contentShadowRoot = contentHost.shadowRoot || null;
        const activeContentElement = contentShadowRoot
          ? deepActiveElement(contentShadowRoot)
          : null;
        const focusedDetails = activeContentElement?.closest?.("details") || null;
        const focusedDetailsSummary = Array.from(focusedDetails?.children || []).find(
          (child) => child.tagName === "SUMMARY"
        );
        if (
          focusedDetails &&
          focusedDetailsSummary &&
          (focusedDetails.open === true || focusedDetails.hasAttribute?.("open"))
        ) {
          event.preventDefault?.();
          focusedDetails.open = false;
          focusedDetails.removeAttribute?.("open");
          focusedDetailsSummary.focus?.({ preventScroll: true });
          return;
        }
        event.preventDefault?.();
        close();
        return;
      }
    }

    function onDocumentFocusIn(event) {
      if (
        !openState ||
        eventPathContains(event, host) ||
        eventPathContains(event, viewHost)
      ) {
        return;
      }
      // This is an internal region, not a modal. Let keyboard users continue
      // into Notion and reveal the native surface at their destination.
      close({ restoreFocus: false });
    }

    function startOpenListeners() {
      documentRef.addEventListener?.("pointerdown", onDocumentPointerDown, true);
      documentRef.addEventListener?.("focusin", onDocumentFocusIn, true);
    }

    function stopOpenListeners() {
      documentRef.removeEventListener?.("pointerdown", onDocumentPointerDown, true);
      documentRef.removeEventListener?.("focusin", onDocumentFocusIn, true);
    }

    function open() {
      if (destroyed || openState) return false;
      syncTheme();
      fitTrigger();
      focusBeforeOpen = deepActiveElement(documentRef) || trigger;
      openState = true;
      viewHost.hidden = false;
      panel.hidden = false;
      panel.setAttribute("aria-hidden", "false");
      trigger.setAttribute("aria-expanded", "true");
      startOpenListeners();
      notifyOpenChange();

      const focusCloseButton = () => {
        if (!destroyed && openState) closeButton.focus?.({ preventScroll: true });
      };
      if (typeof windowRef.requestAnimationFrame === "function") {
        windowRef.requestAnimationFrame(focusCloseButton);
      } else {
        focusCloseButton();
      }
      return true;
    }

    function close(options = {}) {
      if (destroyed || !openState) return false;
      const restoreFocus = options?.restoreFocus !== false;
      openState = false;
      panel.hidden = true;
      panel.setAttribute("aria-hidden", "true");
      viewHost.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      stopOpenListeners();
      notifyOpenChange();

      if (restoreFocus) {
        const target =
          focusBeforeOpen && focusBeforeOpen.isConnected !== false
            ? focusBeforeOpen
            : trigger;
        target.focus?.({ preventScroll: true });
      }
      focusBeforeOpen = null;
      return true;
    }

    function toggle() {
      return openState ? close() : open();
    }

    function update(next = {}) {
      if (destroyed) return false;
      if (Object.prototype.hasOwnProperty.call(next, "open")) {
        if (typeof next.open !== "boolean") {
          throw new TypeError("Panel open state must be boolean.");
        }
        return next.open ? open() : close();
      }
      return false;
    }

    const stoppedEvents = ["click", "mousedown", "pointerdown", "keydown"];
    const stopPropagation = (event) => event.stopPropagation();
    panel.addEventListener("keydown", onPanelKeyDown);
    triggerShell.addEventListener("keydown", onPanelKeyDown);
    for (const eventName of stoppedEvents) {
      triggerShell.addEventListener(eventName, stopPropagation);
      panel.addEventListener(eventName, stopPropagation);
    }
    const onTriggerClick = () => open();
    const onCloseClick = () => close();
    trigger.addEventListener("click", onTriggerClick);
    closeButton.addEventListener("click", onCloseClick);

    function destroy() {
      if (destroyed) return false;
      if (openState) close({ restoreFocus: false });
      destroyed = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      themeQuery?.removeEventListener?.("change", syncTheme);
      windowRef.removeEventListener?.("resize", fitTrigger);
      stopOpenListeners();
      trigger.removeEventListener?.("click", onTriggerClick);
      closeButton.removeEventListener?.("click", onCloseClick);
      panel.removeEventListener?.("keydown", onPanelKeyDown);
      triggerShell.removeEventListener?.("keydown", onPanelKeyDown);
      for (const eventName of stoppedEvents) {
        triggerShell.removeEventListener?.(eventName, stopPropagation);
        panel.removeEventListener?.(eventName, stopPropagation);
      }
      shadowRoot.replaceChildren();
      panelShadowRoot.replaceChildren();
      viewHost.remove?.();
      activeShells.delete(host);
      return true;
    }

    const api = Object.freeze({
      contentHost,
      update,
      open,
      close,
      toggle,
      destroy,
      shadowRoot,
      overlayHost: viewHost,
      viewHost,
      panelShadowRoot
    });
    activeShells.set(host, api);
    return api;
  }

  namespace.panel = Object.freeze({ createPanelShell });
  globalScope.NotionFavoriteSections = namespace;
})(globalThis);
