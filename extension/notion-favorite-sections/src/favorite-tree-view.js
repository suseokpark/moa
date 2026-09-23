(function initializeFavoriteTreeView(globalScope) {
  "use strict";

  const namespace = globalScope.NotionFavoriteSections =
    globalScope.NotionFavoriteSections || {};
  const urls = namespace.urls;
  let viewSequence = 0;

  const STYLE_TEXT = `
    :host {
      --nfs-purple: #8b5cf6;
      --nfs-red: #ef4444;
      --nfs-blue: #3b82f6;
      --nfs-green: #22c55e;
      --nfs-orange: #f59e0b;
      --nfs-pink: #ec4899;
      --nfs-gray: #9ca3af;
      display: flex;
      flex-direction: column;
      color: inherit;
      font: inherit;
      contain: content;
    }

    *, *::before, *::after { box-sizing: border-box; }
    button, input, select { color: inherit; font: inherit; }
    button { border: 0; }

    .nfs-root {
      display: flex;
      flex-direction: column;
      flex: 1 0 auto;
      min-width: 0;
      min-height: 100%;
      padding: 2px 4px 8px;
      color: inherit;
      font-size: 14px;
      line-height: 1.35;
    }

    .nfs-topbar {
      display: flex;
      align-items: center;
      min-height: 40px;
      margin: 0 4px 5px;
      padding: 4px 4px 4px 7px;
      gap: 8px;
      border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
      background: Canvas;
    }

    .nfs-topbar-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      font-size: 12px;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .nfs-topbar-actions {
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 4px;
    }

    .nfs-reset-zone {
      display: flex;
      align-items: center;
      margin: auto 4px 2px;
      padding: 10px 4px 2px;
      gap: 10px;
      border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
    }

    .nfs-reset-zone-copy {
      flex: 1;
      min-width: 0;
      color: color-mix(in srgb, currentColor 52%, transparent);
      font-size: 12px;
      line-height: 1.45;
    }

    .nfs-reset-zone-title {
      display: block;
      margin-bottom: 2px;
      color: inherit;
      font-size: 12px;
      font-weight: 700;
    }

    .nfs-add-favorite-button,
    .nfs-refresh-button,
    .nfs-reset-button {
      min-height: 32px;
      padding: 3px 9px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
    }

    .nfs-add-favorite-button {
      border: 1px solid color-mix(in srgb, var(--nfs-blue) 35%, transparent);
      background: color-mix(in srgb, var(--nfs-blue) 12%, transparent);
      color: color-mix(in srgb, var(--nfs-blue) 85%, currentColor);
    }

    .nfs-refresh-button {
      width: auto;
      padding: 3px 8px;
      border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
      background: transparent;
      color: color-mix(in srgb, currentColor 68%, transparent);
    }

    .nfs-reset-button {
      border: 1px solid color-mix(in srgb, var(--nfs-red) 30%, transparent);
      background: color-mix(in srgb, var(--nfs-red) 8%, transparent);
      color: color-mix(in srgb, var(--nfs-red) 82%, currentColor);
    }

    .nfs-add-favorite-button:hover:not([disabled]) {
      background: color-mix(in srgb, var(--nfs-blue) 20%, transparent);
    }

    .nfs-refresh-button:hover:not([disabled]) {
      background: color-mix(in srgb, currentColor 8%, transparent);
    }

    .nfs-reset-button:hover:not([disabled]) {
      background: color-mix(in srgb, var(--nfs-red) 15%, transparent);
    }

    .nfs-add-favorite-button[disabled],
    .nfs-refresh-button[disabled],
    .nfs-reset-button[disabled] {
      cursor: default;
      opacity: .45;
    }

    .nfs-favorite-picker {
      margin: 0 4px 8px;
      padding: 6px;
      border: 1px solid color-mix(in srgb, currentColor 13%, transparent);
      border-radius: 8px;
      background: Canvas;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
    }

    .nfs-picker-title {
      padding: 3px 5px 6px;
      color: color-mix(in srgb, currentColor 58%, transparent);
      font-size: 10px;
      font-weight: 700;
    }

    .nfs-picker-search {
      width: 100%;
      min-height: 32px;
      margin: 0 0 6px;
      padding: 5px 9px;
      border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius: 6px;
      background: Canvas;
    }

    .nfs-picker-search:focus-visible {
      border-color: var(--nfs-blue);
      outline: 2px solid color-mix(in srgb, var(--nfs-blue) 35%, transparent);
      outline-offset: 0;
    }

    .nfs-picker-current {
      margin: 0 0 6px;
      padding: 5px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--nfs-blue) 7%, Canvas);
    }

    .nfs-picker-current-label,
    .nfs-picker-result-count {
      display: block;
      padding: 2px 5px 4px;
      color: color-mix(in srgb, currentColor 68%, transparent);
      font-size: 11px;
      font-weight: 600;
    }

    .nfs-picker-current .nfs-picker-option {
      background: Canvas;
    }

    .nfs-picker-current-state {
      flex: 0 0 auto;
      color: color-mix(in srgb, currentColor 62%, transparent);
      font-size: 11px;
      font-weight: 600;
    }

    .nfs-picker-list {
      max-height: 240px;
      margin: 0;
      padding: 0;
      overflow: auto;
      list-style: none;
    }

    .nfs-picker-option {
      display: flex;
      align-items: center;
      width: 100%;
      min-height: 32px;
      padding: 3px 6px;
      gap: 6px;
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      text-align: left;
    }

    .nfs-picker-option input[type="checkbox"] {
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      margin: 0;
      accent-color: var(--nfs-blue);
    }

    .nfs-picker-option[data-selected="true"] {
      background: color-mix(in srgb, var(--nfs-blue) 10%, Canvas);
    }

    .nfs-picker-option:hover {
      background: color-mix(in srgb, currentColor 8%, transparent);
    }

    .nfs-picker-option[disabled] {
      cursor: default;
      opacity: .45;
    }

    .nfs-picker-option:focus-visible {
      outline: 2px solid var(--nfs-blue);
      outline-offset: -2px;
    }

    .nfs-picker-option-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .nfs-picker-empty {
      padding: 8px 6px;
      color: color-mix(in srgb, currentColor 55%, transparent);
      font-size: 11px;
    }

    .nfs-picker-actions {
      position: sticky;
      bottom: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      margin-top: 6px;
      padding: 8px 4px 3px;
      gap: 6px;
      border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
      background: Canvas;
    }

    .nfs-picker-destination-label {
      grid-column: 1 / -1;
      color: color-mix(in srgb, currentColor 68%, transparent);
      font-size: 11px;
      font-weight: 600;
    }

    .nfs-picker-destination {
      width: 100%;
      min-width: 0;
      min-height: 32px;
      padding: 4px 7px;
      border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius: 6px;
      background: Canvas;
    }

    .nfs-picker-submit {
      min-height: 32px;
      padding: 4px 10px;
      border-radius: 6px;
      background: var(--nfs-blue);
      color: white;
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }

    .nfs-picker-submit[disabled] {
      cursor: default;
      opacity: .45;
    }

    .nfs-picker-submit:focus-visible,
    .nfs-picker-destination:focus-visible {
      outline: 2px solid var(--nfs-blue);
      outline-offset: 1px;
    }

    .nfs-picker-selection-count {
      grid-column: 1 / -1;
      color: color-mix(in srgb, currentColor 60%, transparent);
      font-size: 11px;
    }

    .nfs-header,
    .nfs-row {
      display: flex;
      align-items: center;
      min-width: 0;
    }

    .nfs-header {
      min-height: 30px;
      padding: 0 4px 0 8px;
      gap: 6px;
    }

    .nfs-heading {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      color: color-mix(in srgb, currentColor 66%, transparent);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .04em;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .nfs-tree,
    .nfs-section-list,
    .nfs-favorite-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .nfs-group,
    .nfs-section,
    .nfs-favorite {
      position: relative;
      min-width: 0;
      border-radius: 5px;
    }

    .nfs-group + .nfs-group { margin-top: 1px; }
    .nfs-section-list {
      margin-left: 12px;
      padding-left: 5px;
      border-left: 1px solid color-mix(in srgb, currentColor 12%, transparent);
    }
    .nfs-favorite-list { padding-left: 12px; }

    .nfs-row {
      min-height: 32px;
      border-radius: 5px;
      gap: 2px;
    }

    .nfs-row:hover,
    .nfs-row:focus-within,
    .nfs-drop-before > .nfs-row {
      background: color-mix(in srgb, currentColor 7%, transparent);
    }

    .nfs-drop-inside > .nfs-row {
      outline: 1px solid color-mix(in srgb, var(--nfs-blue) 75%, transparent);
      outline-offset: -1px;
    }

    .nfs-toggle,
    .nfs-icon-button,
    .nfs-drag-handle,
    .nfs-menu-summary,
    .nfs-add-button,
    .nfs-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border-radius: 4px;
      cursor: pointer;
    }

    .nfs-toggle,
    .nfs-icon-button,
    .nfs-drag-handle,
    .nfs-menu-summary {
      width: 32px;
      height: 32px;
      flex: 0 0 32px;
      padding: 0;
    }

    .nfs-toggle:hover,
    .nfs-icon-button:hover,
    .nfs-drag-handle:hover,
    .nfs-menu-summary:hover,
    .nfs-add-button:hover,
    .nfs-action:hover {
      background: color-mix(in srgb, currentColor 10%, transparent);
    }

    .nfs-toggle:focus-visible,
    .nfs-icon-button:focus-visible,
    .nfs-drag-handle:focus-visible,
    .nfs-menu-summary:focus-visible,
    .nfs-add-button:focus-visible,
    .nfs-action:focus-visible,
    .nfs-favorite-link:focus-visible,
    select:focus-visible {
      outline: 2px solid var(--nfs-blue);
      outline-offset: -2px;
    }

    .nfs-chevron {
      display: inline-block;
      color: color-mix(in srgb, currentColor 60%, transparent);
      font-size: 12px;
      transform: rotate(0deg);
      transition: transform 100ms ease;
    }

    .nfs-add-button {
      min-height: 32px;
      padding: 2px 7px;
      color: color-mix(in srgb, currentColor 68%, transparent);
      font-size: 12px;
    }

    [aria-expanded="false"] .nfs-chevron { transform: rotate(-90deg); }

    .nfs-color {
      width: 7px;
      height: 7px;
      flex: 0 0 7px;
      border-radius: 999px;
      background: var(--nfs-gray);
    }

    [data-color="purple"] > .nfs-row .nfs-color { background: var(--nfs-purple); }
    [data-color="red"] > .nfs-row .nfs-color { background: var(--nfs-red); }
    [data-color="blue"] > .nfs-row .nfs-color { background: var(--nfs-blue); }
    [data-color="green"] > .nfs-row .nfs-color { background: var(--nfs-green); }
    [data-color="orange"] > .nfs-row .nfs-color { background: var(--nfs-orange); }
    [data-color="pink"] > .nfs-row .nfs-color { background: var(--nfs-pink); }

    .nfs-label-button {
      display: flex;
      flex: 1;
      align-items: center;
      min-width: 0;
      height: 32px;
      padding: 0 2px;
      gap: 6px;
      background: transparent;
      cursor: pointer;
      text-align: left;
    }

    .nfs-label,
    .nfs-favorite-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .nfs-label { flex: 1; font-weight: 650; }
    .nfs-section .nfs-label { font-weight: 400; }

    .nfs-count {
      flex: 0 0 auto;
      padding: 0 3px;
      color: color-mix(in srgb, currentColor 45%, transparent);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }

    .nfs-emoji,
    .nfs-page-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 18px;
      width: 18px;
      height: 18px;
      overflow: hidden;
      font-size: 14px;
      line-height: 1;
      white-space: nowrap;
    }

    .nfs-page-icon svg { display: block; width: 14px; height: 14px; flex: none; }

    .nfs-favorite-link {
      display: flex;
      flex: 1;
      align-items: center;
      min-width: 0;
      min-height: 32px;
      padding: 0 4px;
      gap: 5px;
      border-radius: 4px;
      color: inherit;
      text-decoration: none;
    }

    .nfs-favorite-link:hover { text-decoration: none; }

    .nfs-favorite-active > .nfs-row {
      background: color-mix(in srgb, var(--nfs-blue) 13%, transparent);
      box-shadow: inset 3px 0 0 var(--nfs-blue);
    }

    .nfs-favorite-active > .nfs-row > .nfs-favorite-link > .nfs-favorite-title { font-weight: 600; }

    .nfs-current-page {
      margin: 1px 4px 9px;
      padding: 8px;
      border: 1px solid color-mix(in srgb, currentColor 13%, transparent);
      border-radius: 8px;
      background: Canvas;
    }

    .nfs-current-page-heading {
      margin: 0 0 5px;
      color: color-mix(in srgb, currentColor 68%, transparent);
      font-size: 11px;
      font-weight: 700;
    }

    .nfs-page-tree-list { list-style: none; margin: 0; padding: 0; }
    .nfs-page-tree-children {
      margin-left: 15px;
      padding-left: 5px;
      border-left: 1px solid color-mix(in srgb, currentColor 14%, transparent);
    }
    .nfs-page-tree-item { min-width: 0; }
    .nfs-page-tree-item > .nfs-row { display: flex; }
    .nfs-page-toggle { width: 26px; flex-basis: 26px; }
    .nfs-page-toggle-spacer { width: 26px; flex: 0 0 26px; }
    .nfs-page-tree-item[data-current="true"] > .nfs-row {
      background: color-mix(in srgb, var(--nfs-blue) 13%, transparent);
      box-shadow: inset 3px 0 0 var(--nfs-blue);
    }
    .nfs-page-tree-item[data-current="true"] > .nfs-row > .nfs-favorite-link > .nfs-favorite-title { font-weight: 600; }
    .nfs-page-navigation-note, .nfs-page-navigation-helper {
      margin: 6px 4px 2px;
      color: color-mix(in srgb, currentColor 65%, transparent);
      font-size: 11px;
      line-height: 1.5;
    }
    .nfs-page-navigation-note { margin: 0 12px 8px; }

    .nfs-menu {
      position: relative;
      flex: 0 0 32px;
    }

    .nfs-drag-handle {
      width: 24px;
      height: 32px;
      flex: 0 0 24px;
      padding: 0;
      color: color-mix(in srgb, currentColor 45%, transparent);
      cursor: grab;
      opacity: 0;
    }

    .nfs-drag-handle:active { cursor: grabbing; }
    .nfs-row:hover .nfs-drag-handle,
    .nfs-row:focus-within .nfs-drag-handle { opacity: 1; }

    .nfs-menu-summary {
      list-style: none;
      opacity: 0;
    }

    .nfs-menu-summary::-webkit-details-marker { display: none; }
    .nfs-row:hover .nfs-menu-summary,
    .nfs-row:focus-within .nfs-menu-summary,
    .nfs-menu[open] .nfs-menu-summary { opacity: 1; }

    .nfs-menu-panel {
      position: absolute;
      z-index: 2147483646;
      top: 34px;
      right: 0;
      width: 190px;
      max-height: 320px;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 5px;
      border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
      border-radius: 7px;
      background: Canvas;
      color: CanvasText;
      box-shadow: 0 5px 18px rgba(0, 0, 0, .16);
    }

    .nfs-action {
      width: 100%;
      min-height: 32px;
      padding: 4px 8px;
      justify-content: flex-start;
      text-align: left;
    }

    .nfs-action[disabled] { cursor: default; opacity: .4; }
    .nfs-action-danger { color: #dc2626; }

    .nfs-field-label {
      display: block;
      padding: 4px 6px 2px;
      color: color-mix(in srgb, currentColor 65%, transparent);
      font-size: 11px;
    }

    .nfs-select {
      width: calc(100% - 8px);
      min-height: 32px;
      margin: 0 4px 4px;
      border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius: 5px;
      background: Canvas;
      padding: 2px 5px;
    }

    .nfs-divider {
      height: 1px;
      margin: 4px;
      background: color-mix(in srgb, currentColor 12%, transparent);
    }

    .nfs-empty,
    .nfs-status {
      margin: 2px 8px 5px;
      color: color-mix(in srgb, currentColor 55%, transparent);
      font-size: 12px;
    }

    .nfs-empty { padding: 5px 7px; }

    .nfs-status {
      padding: 5px 7px;
      border-radius: 5px;
      background: color-mix(in srgb, currentColor 5%, transparent);
    }

    .nfs-status[data-tone="warning"] { color: #b45309; }
    .nfs-status[data-tone="error"] { color: #dc2626; }
    .nfs-status[data-tone="success"] { color: #15803d; }

    .nfs-label-button.nfs-toggle { width: auto; flex: 1; justify-content: flex-start; padding: 0 5px; }
    .nfs-label-button .nfs-chevron { width: 14px; flex: 0 0 14px; text-align: center; }
    .nfs-menu-summary { opacity: .65; }
    .nfs-inline-form, .nfs-onboarding {
      margin: 8px; padding: 12px; border-radius: 8px;
      border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      background: Canvas; color: CanvasText;
    }
    .nfs-inline-form h3, .nfs-onboarding h3 { margin: 0 0 6px; font-size: 14px; }
    .nfs-inline-form p, .nfs-onboarding p { margin: 0 0 10px; font-size: 12px; line-height: 1.5; }
    .nfs-inline-form label { display: block; font-size: 12px; margin-bottom: 5px; }
    .nfs-inline-input { width: 100%; min-height: 36px; padding: 6px 8px; border: 1px solid GrayText; border-radius: 5px; background: Canvas; }
    .nfs-inline-input:focus-visible { outline: 2px solid var(--nfs-blue); outline-offset: 2px; }
    .nfs-inline-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }
    .nfs-inline-actions .nfs-action { width: auto; min-width: 60px; justify-content: center; }
    .nfs-primary { background: #2563eb; color: white; }
    .nfs-action.nfs-primary:hover { background: #1d4ed8; }
    .nfs-picker-title, .nfs-picker-current-label, .nfs-picker-result-count,
    .nfs-picker-current-state, .nfs-picker-empty, .nfs-picker-destination-label,
    .nfs-picker-selection-count, .nfs-picker-submit, .nfs-add-favorite-button,
    .nfs-refresh-button, .nfs-reset-button { font-size: 12px; }
    .nfs-inline-error { margin-top: 6px; color: #dc2626; font-size: 12px; }
    .nfs-undo { display: flex; align-items: center; gap: 6px; }
    .nfs-undo span { flex: 1; }
    .nfs-undo .nfs-action { width: auto; white-space: nowrap; color: inherit; text-decoration: underline; }

    .nfs-visually-hidden {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      padding: 0 !important;
      margin: -1px !important;
      overflow: hidden !important;
      clip: rect(0, 0, 0, 0) !important;
      white-space: nowrap !important;
      border: 0 !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .nfs-chevron { transition: none; }
    }
  `;

  const COLOR_TOKENS = new Set([
    "gray",
    "purple",
    "red",
    "blue",
    "green",
    "orange",
    "pink"
  ]);

  function element(documentRef, tagName, options = {}) {
    const node = documentRef.createElement(tagName);

    if (options.className) {
      node.className = options.className;
    }
    if (options.text !== undefined) {
      node.textContent = String(options.text);
    }
    if (options.attributes) {
      for (const [name, value] of Object.entries(options.attributes)) {
        if (value !== undefined && value !== null) {
          node.setAttribute(name, String(value));
        }
      }
    }

    return node;
  }

  function safeDomId(value) {
    return String(value || "item").replace(/[^a-zA-Z0-9_-]/g, "-");
  }

  function validColor(value) {
    return COLOR_TOKENS.has(value) ? value : "gray";
  }

  function entityLabel(name, type) {
    const text = String(name || "");
    return text.endsWith(type) ? text : `${text} ${type}`;
  }

  function favoriteCount(group) {
    return (group.sections || []).reduce(
      (total, section) => total + activeFavorites(section).length,
      0
    );
  }

  function activeFavorites(section) {
    return section.favorites || [];
  }

  function visibleSections(group) {
    return (group.sections || []).filter(
      (section) => !section.system || activeFavorites(section).length > 0
    );
  }

  function visibleGroups(groups) {
    return (groups || []).filter(
      (group) => !group.system || favoriteCount(group) > 0
    );
  }

  function sectionContainsPage(section, pageId) {
    if (!pageId) return false;
    return activeFavorites(section).some(
      (favorite) => String(favorite.pageId || "") === String(pageId)
    );
  }

  function groupContainsPage(group, pageId) {
    return (group.sections || []).some((section) =>
      sectionContainsPage(section, pageId)
    );
  }

  function favoriteMetadataMap(favorites) {
    return new Map(
      (favorites || [])
        .filter((favorite) => favorite && favorite.pageId)
        .map((favorite) => [String(favorite.pageId), favorite])
    );
  }

  function managedFavoriteIds(workspace) {
    const pageIds = new Set();
    for (const group of workspace?.groups || []) {
      for (const section of group.sections || []) {
        for (const favorite of section.favorites || []) {
          if (favorite?.pageId) pageIds.add(String(favorite.pageId));
        }
      }
    }
    return pageIds;
  }

  function safeFavoriteHref(value) {
    return urls.safePageUrl(value, { allowLegacyHost: true });
  }

  function favoriteIconText(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    // A role=img label is often "Change page icon", not an icon. Only allow
    // one complete emoji sequence; paths, labels and mixed text never render.
    const emoji = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)$/u;
    return normalized.length <= 64 && emoji.test(normalized) ? normalized : null;
  }

  function pageIcon(documentRef, value) {
    const text = favoriteIconText(value);
    const icon = element(documentRef, "span", {
      className: "nfs-page-icon",
      attributes: { "aria-hidden": "true" },
      text: text || ""
    });
    if (!text) {
      const svg = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
      const path = documentRef.createElementNS("http://www.w3.org/2000/svg", "path");
      for (const [key, attributeValue] of Object.entries({
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.8",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
        focusable: "false"
      })) svg.setAttribute(key, attributeValue);
      path.setAttribute("d", "M7 17 17 7M7 7h10v10");
      svg.append(path);
      icon.append(svg);
    }
    return icon;
  }

  function closeMenuFrom(node) {
    const menu = node && node.closest ? node.closest("details") : null;
    if (menu) {
      menu.open = false;
    }
  }

  function safeNavigationHref(value, pageId) {
    return urls.safePageUrl(value, { pageId, allowLegacyHost: true });
  }

  // Navigation is a bounded, read-only projection of the currently loaded DOM.
  // Never retain DOM nodes, mutate managed Favorites, or trust recursive input.
  function normalizePageNavigation(value) {
    if (!value || typeof value !== "object") return null;
    const safe = value.scopeSafe === true;
    let remaining = 400;
    function copyNode(node, ancestors = new Set(), depth = 0) {
      if (!node || typeof node !== "object" || depth > 12 || remaining <= 0) return null;
      const pageId = typeof node.pageId === "string" ? node.pageId.trim() : "";
      if (!pageId || pageId.length > 128 || ancestors.has(pageId)) return null;
      remaining -= 1;
      const nextAncestors = new Set(ancestors).add(pageId);
      const siblingIds = new Set();
      const children = [];
      for (const child of safe && Array.isArray(node.children) ? node.children : []) {
        if (remaining <= 0) break;
        if (!child?.pageId || siblingIds.has(child.pageId)) continue;
        siblingIds.add(child.pageId);
        const copied = copyNode(child, nextAncestors, depth + 1);
        if (copied) children.push(copied);
      }
      return { pageId, title: String(node.title || "제목 없는 페이지").slice(0, 500), href: safeNavigationHref(node.href, pageId), icon: favoriteIconText(node.iconText || node.icon), children };
    }
    const currentPage = copyNode(value.currentPage);
    const roots = [];
    const rootIds = new Set();
    if (safe) for (const node of Array.isArray(value.roots) ? value.roots : []) {
      if (remaining <= 0) break;
      if (!node?.pageId || rootIds.has(node.pageId)) continue;
      rootIds.add(node.pageId);
      const copied = copyNode(node);
      if (copied) roots.push(copied);
    }
    return { currentPage, roots, scopeSafe: safe, renderedOnly: true, reason: String(value.reason || "").slice(0, 200) };
  }

  function createFavoriteTreeView(options) {
    if (!options || !options.host) {
      throw new TypeError("Favorite tree view requires a host element.");
    }

    const host = options.host;
    const documentRef = host.ownerDocument || globalScope.document;
    const pickerId = `nfs-favorite-picker-${++viewSequence}`;
    const shadowRoot = host.shadowRoot || host.attachShadow({ mode: "open" });
    const style = element(documentRef, "style", { text: STYLE_TEXT });
    const root = element(documentRef, "section", {
      className: "nfs-root",
      attributes: {
        "aria-label": "즐겨찾기 그룹"
      }
    });
    const liveRegion = element(documentRef, "div", {
      className: "nfs-visually-hidden",
      attributes: {
        "aria-live": "polite",
        "aria-atomic": "true"
      }
    });

    for (const eventName of [
      "click",
      "mousedown",
      "pointerdown",
      "dragstart",
      "dragover",
      "drop"
    ]) {
      root.addEventListener(eventName, (event) => event.stopPropagation());
    }

    shadowRoot.replaceChildren(style, root, liveRegion);

    let callbacks = options.callbacks || {};
    let currentWorkspace = options.workspace || { groups: [] };
    let currentFavorites = options.favorites || [];
    let currentFavoriteMetadata = favoriteMetadataMap(options.favoriteMetadata || []);
    let currentStatus = options.status || null;
    let currentImportPreview = options.importPreview || null;
    let currentActivePageId = options.activePageId || null;
    let currentPageNavigation = normalizePageNavigation(options.pageNavigation);
    let navigationById = new Map();
    let activeNavigationAncestors = new Set();
    let remainingNavigationRows = 1000;
    const pageBranchStates = new Map();
    let currentWorkspaceRevision = options.workspaceRevision;
    let currentWorkspaceKey = options.workspaceKey;
    let currentUndoState = options.undoState || null;
    let inlineForm = null;
    let actionPending = false;
    let destroyed = false;
    let dragged = null;
    let pickerOpen = false;
    let pickerQuery = "";
    let pickerDestinationSectionId = null;
    let lastPickerDestinationSectionId = null;
    let statusTimer = null;
    const pickerSelectedIds = new Set();
    let lastScrolledActivePageId = null;
    const suppressedActiveGroups = new Set();
    const suppressedActiveSections = new Set();
    const menuLayouts = new Map();
    const menuScrollSurface = host.parentElement;

    function menuViewportBounds() {
      const hostRect = host.getBoundingClientRect();
      const bounds = {
        top: Math.max(0, hostRect.top),
        bottom: Math.min(globalScope.innerHeight || documentRef.documentElement.clientHeight, hostRect.bottom),
        left: Math.max(0, hostRect.left),
        right: Math.min(globalScope.innerWidth || documentRef.documentElement.clientWidth, hostRect.right)
      };
      // Notion's scroll surface lives outside this view's shadow root. Its
      // clipping rectangle, rather than the full document, bounds row menus.
      let ancestor = host.parentElement;
      while (ancestor) {
        const computed = globalScope.getComputedStyle(ancestor);
        if (/auto|scroll|hidden|clip/.test(`${computed.overflowX} ${computed.overflowY}`)) {
          const rect = ancestor.getBoundingClientRect();
          bounds.top = Math.max(bounds.top, rect.top);
          bounds.bottom = Math.min(bounds.bottom, rect.bottom);
          bounds.left = Math.max(bounds.left, rect.left);
          bounds.right = Math.min(bounds.right, rect.right);
        }
        ancestor = ancestor.parentElement || ancestor.getRootNode?.().host || null;
      }
      return bounds;
    }

    function positionOpenMenus(event) {
      for (const [details, layout] of menuLayouts) {
        const insideMenu = event?.target?.nodeType && layout.panel.contains(event.target);
        if (details.open && !insideMenu) layout.position();
      }
    }

    menuScrollSurface?.addEventListener("scroll", positionOpenMenus, true);
    globalScope.addEventListener?.("resize", positionOpenMenus);

    function announce(message) {
      liveRegion.textContent = "";
      globalScope.requestAnimationFrame
        ? globalScope.requestAnimationFrame(() => {
            liveRegion.textContent = message;
          })
        : (liveRegion.textContent = message);
    }

    function setStatus(message, tone = "info") {
      if (destroyed) return;
      if (statusTimer !== null) {
        globalScope.clearTimeout(statusTimer);
        statusTimer = null;
      }
      currentStatus = message ? { message: String(message), tone } : null;
      render();
      if (message && tone !== "error" && typeof globalScope.setTimeout === "function") {
        statusTimer = globalScope.setTimeout(() => {
          statusTimer = null;
          currentStatus = null;
          render();
        }, 4500);
      }
    }

    async function invoke(name, ...args) {
      if (actionPending) return { ok: false, error: new Error("저장 중입니다. 잠시 후 다시 시도해 주세요.") };
      const callback = callbacks[name];
      if (typeof callback !== "function") {
        const error = new Error("요청한 작업을 실행할 수 없습니다.");
        setStatus(error.message, "error");
        return { ok: false, error };
      }

      try {
        actionPending = true;
        root.setAttribute("aria-busy", "true");
        const value = await callback(...args);
        if (["onMoveFavorite", "onMoveFavoriteToGroup", "onMoveGroup", "onMoveSection"].includes(name)) {
          setStatus("위치를 옮겼습니다.", "success");
        }
        return { ok: true, value };
      } catch (error) {
        setStatus(
          error && error.message ? error.message : "변경 사항을 저장하지 못했습니다.",
          "error"
        );
        return { ok: false, error };
      } finally {
        actionPending = false;
        root.setAttribute("aria-busy", "false");
      }
    }

    function focusKey(node) {
      return node?.getAttribute?.("data-focus-key") || null;
    }

    function focusByKey(key) {
      const target = [...root.querySelectorAll("[data-focus-key]")].find(
        (node) => focusKey(node) === key
      );
      const available = target && !target.disabled && !target.closest("[hidden]");
      if (available) target.focus?.({ preventScroll: true });
      return Boolean(available);
    }

    function closeInlineForm() {
      const returnKey = inlineForm?.returnKey;
      inlineForm = null;
      render();
      if (!focusByKey(returnKey)) root.querySelector('[aria-label="그룹 추가"]')?.focus?.();
    }

    function openInlineForm(config) {
      if (actionPending || inlineForm?.pending) return;
      const active = shadowRoot.activeElement;
      const summary = active?.closest?.("details")?.querySelector("summary");
      inlineForm = {
        ...config,
        value: config.initialValue || "",
        error: "",
        pending: false,
        expectedRevision: currentWorkspaceRevision,
        workspaceKey: currentWorkspaceKey,
        returnKey: focusKey(summary || active)
      };
      render();
      const target = root.querySelector(config.kind === "name" ? ".nfs-inline-input" : "[data-form-cancel]");
      target?.focus?.();
      target?.scrollIntoView?.({ block: "nearest" });
      if (config.kind === "name") target?.select?.();
    }

    function requestName(title, callback, args = [], initialValue = "") {
      openInlineForm({ kind: "name", title, callback, args, initialValue, submitLabel: initialValue ? "저장" : "만들기" });
    }

    function requestConfirmation(title, description, callback, args = [], submitLabel = "삭제") {
      openInlineForm({ kind: "confirm", title, description, callback, args, submitLabel });
    }

    function renderInlineForm() {
      const config = inlineForm;
      const formId = `${pickerId}-form`;
      const form = element(documentRef, "form", {
        className: "nfs-inline-form",
        attributes: { "aria-labelledby": `${formId}-title`, "aria-busy": String(config.pending) }
      });
      form.append(element(documentRef, "h3", { text: config.title, attributes: { id: `${formId}-title` } }));
      if (config.description) form.append(element(documentRef, "p", { text: config.description }));
      if (config.kind === "name") {
        form.append(element(documentRef, "label", { text: "이름", attributes: { for: `${formId}-name` } }));
        const input = element(documentRef, "input", {
          className: "nfs-inline-input",
          attributes: { id: `${formId}-name`, type: "text", maxlength: "80", autocomplete: "off", "aria-label": config.title, "aria-describedby": config.error ? `${formId}-error` : null, "aria-invalid": config.error ? "true" : null }
        });
        input.value = config.value;
        input.disabled = config.pending;
        input.addEventListener("input", () => { config.value = input.value; });
        form.append(input);
      }
      if (config.error) form.append(element(documentRef, "div", { className: "nfs-inline-error", text: config.error, attributes: { id: `${formId}-error`, role: "alert" } }));
      const actions = element(documentRef, "div", { className: "nfs-inline-actions" });
      const cancel = actionButton("취소", closeInlineForm, { disabled: config.pending });
      cancel.setAttribute("data-form-cancel", "");
      const submit = element(documentRef, "button", {
        className: `nfs-action ${config.kind === "confirm" ? "nfs-action-danger" : "nfs-primary"}`,
        text: config.pending ? "저장 중…" : config.submitLabel,
        attributes: { type: "submit", "data-form-submit": "" }
      });
      submit.disabled = config.pending;
      actions.append(cancel, submit);
      form.append(actions);
      form.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (!config.pending) closeInlineForm();
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (config.pending || inlineForm !== config) return;
        const name = config.value.trim();
        if (config.kind === "name" && !name) {
          config.error = "이름을 입력해 주세요.";
          render();
          root.querySelector(".nfs-inline-input")?.focus?.();
          return;
        }
        config.pending = true;
        config.error = "";
        render();
        const args = config.kind === "name"
          ? [...config.args, name]
          : [...config.args, { expectedRevision: config.expectedRevision, workspaceKey: config.workspaceKey }];
        const result = await invoke(config.callback, ...args);
        config.pending = false;
        if (inlineForm !== config) return;
        if (!result.ok) {
          config.error = result.error?.message || "저장하지 못했습니다. 다시 시도해 주세요.";
          if (config.kind === "confirm") config.error += " 취소한 뒤 최신 목록에서 다시 선택해 주세요.";
          render();
          root.querySelector(".nfs-inline-input, [data-form-cancel]")?.focus?.();
          return;
        }
        closeInlineForm();
        setStatus(config.kind === "name" ? `“${name}” ${config.initialValue ? "이름을 변경했습니다." : "만들었습니다."}` : "변경 사항을 저장했습니다.", "success");
      });
      return form;
    }

    function normalizedSearchText(value) {
      return String(value || "").trim().toLocaleLowerCase();
    }

    function focusPickerSearch() {
      const input = root.querySelector('input[aria-label="즐겨찾기 검색"]');
      input?.focus?.({ preventScroll: true });
      input?.setSelectionRange?.(input.value.length, input.value.length);
    }

    function applyPickerFilter(picker, query) {
      const normalizedQuery = normalizedSearchText(query);
      let visibleCount = 0;
      for (const item of picker.querySelectorAll("[data-picker-search-text]")) {
        const matches =
          !normalizedQuery ||
          String(item.getAttribute("data-picker-search-text") || "").includes(
            normalizedQuery
          );
        item.hidden = !matches;
        if (matches) visibleCount += 1;
      }
      const count = picker.querySelector("[data-picker-result-count]");
      if (count) count.textContent = `검색 결과 ${visibleCount}개`;
      const empty = picker.querySelector("[data-picker-no-results]");
      if (empty) {
        empty.hidden = visibleCount !== 0;
        empty.textContent = normalizedQuery
          ? `“${String(query).trim()}”와 일치하는 즐겨찾기가 없습니다.`
          : "추가할 수 있는 즐겨찾기가 없습니다.";
      }
    }

    function pickerDestinations() {
      const destinations = [];
      for (const group of currentWorkspace?.groups || []) {
        for (const section of group.sections || []) {
          if (!section?.id) continue;
          destinations.push({
            sectionId: String(section.id),
            label: `${group.name || "이름 없는 그룹"} / ${
              section.name || "이름 없는 섹션"
            }`,
            system: Boolean(group.system || section.system)
          });
        }
      }
      return destinations;
    }

    function updatePickerActions(picker) {
      const count = picker.querySelector("[data-picker-selection-count]");
      if (count) count.textContent = `${pickerSelectedIds.size}개 선택`;
      const submit = picker.querySelector("[data-picker-submit]");
      if (submit) {
        submit.textContent = `선택한 ${pickerSelectedIds.size}개 추가`;
        submit.disabled =
          pickerSelectedIds.size === 0 ||
          !pickerDestinationSectionId ||
          currentImportPreview?.canManage === false ||
          currentImportPreview?.busy === true;
      }
      for (const checkbox of picker.querySelectorAll(
        'input[type="checkbox"][data-picker-page-id]'
      )) {
        const selected = pickerSelectedIds.has(
          String(checkbox.getAttribute("data-picker-page-id") || "")
        );
        checkbox.checked = selected;
        checkbox.closest(".nfs-picker-option")?.setAttribute(
          "data-selected",
          String(selected)
        );
      }
    }

    function closeFavoritePicker({ restoreFocus = true } = {}) {
      pickerOpen = false;
      pickerQuery = "";
      pickerSelectedIds.clear();
      render();
      if (restoreFocus) {
        root
          .querySelector('button[aria-label="Notion 즐겨찾기 추가"]')
          ?.focus?.({ preventScroll: true });
      }
    }

    async function submitPickerSelection(picker) {
      const selectedIds = [...pickerSelectedIds];
      const destination = pickerDestinations().find(
        (candidate) => candidate.sectionId === pickerDestinationSectionId
      );
      if (selectedIds.length === 0 || !destination) return;
      const submit = picker.querySelector("[data-picker-submit]");
      if (submit) {
        submit.disabled = true;
        submit.textContent = "추가 중…";
      }
      const result = await invoke(
        "onAddFavorites",
        selectedIds,
        destination.sectionId
      );
      if (!result?.ok) {
        pickerOpen = true;
        pickerDestinationSectionId = destination.sectionId;
        pickerSelectedIds.clear();
        selectedIds.forEach((pageId) => pickerSelectedIds.add(pageId));
        render();
        focusPickerSearch();
        return;
      }
      lastPickerDestinationSectionId = destination.sectionId;
      pickerDestinationSectionId = destination.sectionId;
      pickerOpen = false;
      pickerQuery = "";
      pickerSelectedIds.clear();
      const addedCount = Number.isInteger(result.value?.addedCount) ? result.value.addedCount : selectedIds.length;
      const skippedCount = Number.isInteger(result.value?.skippedCount) ? result.value.skippedCount : 0;
      setStatus(
        `${addedCount}개를 ${destination.label.replace(" / ", " > ")}에 추가했습니다.${skippedCount ? ` 이미 추가된 ${skippedCount}개는 유지했습니다.` : ""}`,
        "success"
      );
      root
        .querySelector('button[aria-label="Notion 즐겨찾기 추가"]')
        ?.focus?.({ preventScroll: true });
    }

    function renderFavoritePicker() {
      const preview = currentImportPreview || {};
      const managedIds = managedFavoriteIds(currentWorkspace);
      const available = (currentFavorites || []).filter(
        (favorite) => favorite?.pageId && !managedIds.has(String(favorite.pageId))
      );
      const availableIds = new Set(
        available.map((favorite) => String(favorite.pageId))
      );
      for (const selectedId of pickerSelectedIds) {
        if (!availableIds.has(selectedId)) pickerSelectedIds.delete(selectedId);
      }
      const destinations = pickerDestinations();
      const validDestinationIds = new Set(
        destinations.map((destination) => destination.sectionId)
      );
      if (!validDestinationIds.has(pickerDestinationSectionId)) {
        pickerDestinationSectionId = validDestinationIds.has(
          lastPickerDestinationSectionId
        )
          ? lastPickerDestinationSectionId
          : null;
      }
      const userDestinations = destinations.filter(
        (destination) => !destination.system
      );
      if (!pickerDestinationSectionId && (userDestinations.length === 1 || destinations.length === 1)) {
        pickerDestinationSectionId = (userDestinations[0] || destinations[0]).sectionId;
      }
      const activeFavorite = (currentFavorites || []).find(
        (favorite) =>
          favorite?.pageId &&
          String(favorite.pageId) === String(currentActivePageId || "")
      );
      const currentPageId = activeFavorite ? String(activeFavorite.pageId) : null;
      const searchable = available.filter(
        (favorite) => String(favorite.pageId) !== currentPageId
      );
      const picker = element(documentRef, "section", {
        className: "nfs-favorite-picker",
        attributes: {
          id: pickerId,
          "aria-label": "Notion 즐겨찾기 선택"
        }
      });
      picker.append(
        element(documentRef, "div", {
          className: "nfs-picker-title",
          text: "Notion 즐겨찾기에서 추가"
        })
      );

      const search = element(documentRef, "input", {
        className: "nfs-picker-search",
        attributes: {
          type: "search",
          value: pickerQuery,
          placeholder: "즐겨찾기 검색…",
          autocomplete: "off",
          autofocus: "",
          "aria-label": "즐겨찾기 검색"
        }
      });
      search.value = pickerQuery;
      search.addEventListener("input", (event) => {
        pickerQuery = event.currentTarget.value;
        applyPickerFilter(picker, pickerQuery);
      });
      picker.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.target === search && pickerQuery) {
          pickerQuery = "";
          search.value = "";
          applyPickerFilter(picker, "");
        } else {
          closeFavoritePicker();
        }
      });
      picker.append(search);

      if (activeFavorite) {
        const current = element(documentRef, "div", {
          className: "nfs-picker-current",
          attributes: { "aria-label": "현재 페이지" }
        });
        current.append(
          element(documentRef, "span", {
            className: "nfs-picker-current-label",
            text: "현재 페이지"
          })
        );
        const currentButton = element(documentRef, "label", {
          className: "nfs-picker-option",
          attributes: {
            "data-selected": String(pickerSelectedIds.has(currentPageId)),
            title: managedIds.has(currentPageId)
              ? "현재 페이지는 이미 FAVMOA에 있습니다."
              : "현재 페이지 선택"
          }
        });
        const currentCheckbox = element(documentRef, "input", {
          attributes: {
            type: "checkbox",
            "data-picker-page-id": currentPageId,
            "aria-label": `${activeFavorite.title || "현재 페이지"} 선택`
          }
        });
        currentCheckbox.checked = pickerSelectedIds.has(currentPageId);
        currentCheckbox.disabled =
          managedIds.has(currentPageId) ||
          preview.canManage === false ||
          preview.busy === true;
        currentButton.append(
          currentCheckbox,
          pageIcon(documentRef, activeFavorite.iconText || activeFavorite.icon),
          element(documentRef, "span", {
            className: "nfs-picker-option-title",
            text: activeFavorite.title || activeFavorite.name || "제목 없는 즐겨찾기"
          }),
          element(documentRef, "span", {
            className: "nfs-picker-current-state",
            text: managedIds.has(currentPageId) ? "추가됨" : "선택"
          })
        );
        if (!managedIds.has(currentPageId)) {
          currentCheckbox.addEventListener("change", () => {
            if (currentCheckbox.checked) pickerSelectedIds.add(currentPageId);
            else pickerSelectedIds.delete(currentPageId);
            updatePickerActions(picker);
          });
        }
        current.append(currentButton);
        picker.append(current);
      }

      picker.append(
        element(documentRef, "span", {
          className: "nfs-picker-result-count",
          text: `검색 결과 ${searchable.length}개`,
          attributes: {
            "data-picker-result-count": "",
            "aria-live": "polite"
          }
        })
      );

      const list = element(documentRef, "ul", {
        className: "nfs-picker-list"
      });
      if (searchable.length === 0) {
        list.append(
          element(documentRef, "li", {
            className: "nfs-picker-empty",
            text:
              preview.canManage === false
                ? "현재 Notion 즐겨찾기를 안전하게 읽을 수 없습니다."
                : "추가할 수 있는 즐겨찾기가 없습니다."
          })
        );
      } else {
        const titleCounts = new Map();
        for (const favorite of searchable) {
          const title = String(
            favorite.title || favorite.name || "제목 없는 즐겨찾기"
          ).trim();
          const key = title.toLocaleLowerCase();
          titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
        }
        for (const favorite of searchable) {
          const pageId = String(favorite.pageId);
          const title = String(
            favorite.title || favorite.name || "제목 없는 즐겨찾기"
          ).trim();
          const duplicateTitle =
            (titleCounts.get(title.toLocaleLowerCase()) || 0) > 1;
          const displayTitle = duplicateTitle
            ? `${title} · …${pageId.slice(-6)}`
            : title;
          const item = element(documentRef, "li", {
            attributes: {
              "data-picker-search-text": normalizedSearchText(displayTitle)
            }
          });
          const option = element(documentRef, "label", {
            className: "nfs-picker-option",
            attributes: {
              title: `${displayTitle} 선택`,
              "data-selected": String(pickerSelectedIds.has(pageId))
            }
          });
          const checkbox = element(documentRef, "input", {
            attributes: {
              type: "checkbox",
              "data-picker-page-id": pageId,
              "aria-label": `${displayTitle} 선택`
            }
          });
          checkbox.checked = pickerSelectedIds.has(pageId);
          checkbox.disabled =
            preview.canManage === false || preview.busy === true;
          option.append(
            checkbox,
            pageIcon(documentRef, favorite.iconText || favorite.icon),
            element(documentRef, "span", {
              className: "nfs-picker-option-title",
              text: displayTitle
            })
          );
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) pickerSelectedIds.add(pageId);
            else pickerSelectedIds.delete(pageId);
            updatePickerActions(picker);
          });
          item.append(option);
          list.append(item);
        }
        list.append(
          element(documentRef, "li", {
            className: "nfs-picker-empty",
            text: "추가할 수 있는 즐겨찾기가 없습니다.",
            attributes: {
              hidden: "",
              "data-picker-no-results": ""
            }
          })
        );
      }
      picker.append(list);
      const actions = element(documentRef, "div", {
        className: "nfs-picker-actions"
      });
      actions.append(
        element(documentRef, "label", {
          className: "nfs-picker-destination-label",
          text: "추가할 그룹 / 섹션",
          attributes: { for: `${pickerId}-destination` }
        })
      );
      const destinationSelect = element(documentRef, "select", {
        className: "nfs-picker-destination",
        attributes: {
          id: `${pickerId}-destination`,
          "aria-label": "즐겨찾기 추가 목적지"
        }
      });
      destinationSelect.append(
        element(documentRef, "option", {
          text: "목적지 선택",
          attributes: { value: "" }
        })
      );
      for (const destination of destinations) {
        const option = element(documentRef, "option", {
          text: destination.label,
          attributes: { value: destination.sectionId }
        });
        option.selected = destination.sectionId === pickerDestinationSectionId;
        destinationSelect.append(option);
      }
      destinationSelect.value = pickerDestinationSectionId || "";
      destinationSelect.disabled =
        preview.canManage === false || preview.busy === true;
      destinationSelect.addEventListener("change", (event) => {
        pickerDestinationSectionId = event.currentTarget.value || null;
        updatePickerActions(picker);
      });
      const submit = element(documentRef, "button", {
        className: "nfs-picker-submit",
        text: `선택한 ${pickerSelectedIds.size}개 추가`,
        attributes: {
          type: "button",
          "data-picker-submit": "",
          "aria-label": "선택한 즐겨찾기 추가"
        }
      });
      submit.addEventListener("click", () => submitPickerSelection(picker));
      actions.append(
        destinationSelect,
        submit,
        element(documentRef, "span", {
          className: "nfs-picker-selection-count",
          text: `${pickerSelectedIds.size}개 선택`,
          attributes: {
            "data-picker-selection-count": "",
            "aria-live": "polite"
          }
        })
      );
      picker.append(actions);
      applyPickerFilter(picker, pickerQuery);
      updatePickerActions(picker);
      return picker;
    }

    function renderTopBar() {
      const preview = currentImportPreview || {};
      const topbar = element(documentRef, "div", { className: "nfs-topbar" });
      const addFavoriteButton = element(documentRef, "button", {
        className: "nfs-add-favorite-button",
        text: "+ 즐겨찾기",
        attributes: {
          type: "button",
          title: "현재 Notion 즐겨찾기에서 골라 추가",
          "aria-label": "Notion 즐겨찾기 추가",
          "aria-expanded": pickerOpen ? "true" : "false",
          "aria-controls": pickerId
        }
      });
      addFavoriteButton.disabled =
        preview.canManage === false || preview.busy === true;
      addFavoriteButton.addEventListener("click", () => {
        if (actionPending || inlineForm?.pending) return;
        const willOpen = !pickerOpen;
        pickerOpen = willOpen;
        pickerQuery = "";
        pickerSelectedIds.clear();
        if (willOpen) {
          const destinationIds = new Set(
            pickerDestinations().map((destination) => destination.sectionId)
          );
          pickerDestinationSectionId = destinationIds.has(
            lastPickerDestinationSectionId
          )
            ? lastPickerDestinationSectionId
            : null;
        }
        render();
        if (pickerOpen) {
          focusPickerSearch();
        } else {
          root
            .querySelector('button[aria-label="Notion 즐겨찾기 추가"]')
            ?.focus?.({ preventScroll: true });
        }
      });

      const refreshButton = element(documentRef, "button", {
        className: "nfs-refresh-button",
        text: preview.busy ? "갱신 중…" : "목록 갱신",
        attributes: {
          type: "button",
          title: "관리 중인 즐겨찾기 상태 새로고침",
          "aria-label": "즐겨찾기 목록 갱신"
        }
      });
      refreshButton.disabled =
        preview.canManage === false || preview.busy === true;
      refreshButton.addEventListener("click", async () => {
        const result = await invoke("onRefreshManagedFavorites");
        if (result?.ok) {
          setStatus(
            "즐겨찾기 목록을 갱신했습니다.",
            "success"
          );
        }
      });

      const actions = element(documentRef, "span", {
        className: "nfs-topbar-actions"
      });
      actions.append(addFavoriteButton, refreshButton);
      topbar.append(
        element(documentRef, "span", {
          className: "nfs-topbar-title",
          text: "즐겨찾기"
        }),
        actions
      );
      return topbar;
    }

    function renderResetZone() {
      const preview = currentImportPreview || {};
      const zone = element(documentRef, "section", {
        className: "nfs-reset-zone",
        attributes: { "aria-label": "FAVMOA 관리" }
      });
      const copy = element(documentRef, "div", {
        className: "nfs-reset-zone-copy"
      });
      copy.append(
        element(documentRef, "span", {
          className: "nfs-reset-zone-title",
          text: "FAVMOA 관리"
        }),
        documentRef.createTextNode(
          "이 브라우저에 저장된 내 정리 목록"
        )
      );

      const resetButton = element(documentRef, "button", {
        className: "nfs-reset-button",
        text: "초기화",
        attributes: {
          type: "button",
          title: "FAVMOA의 그룹·섹션·즐겨찾기를 모두 초기화",
          "aria-label": "즐겨찾기 트리 초기화"
        }
      });
      resetButton.disabled =
        preview.canReset === false || preview.busy === true;
      resetButton.addEventListener("click", () => {
        requestConfirmation("FAVMOA를 초기화할까요?", "내가 만든 그룹, 섹션과 추가한 즐겨찾기가 모두 지워집니다. Notion의 원본 즐겨찾기는 그대로입니다.", "onResetTree", [], "초기화");
      });

      zone.append(copy, resetButton);
      return zone;
    }

    function actionButton(label, onActivate, options = {}) {
      const button = element(documentRef, "button", {
        className: `nfs-action${options.danger ? " nfs-action-danger" : ""}`,
        text: label,
        attributes: {
          type: "button",
          disabled: options.disabled ? "" : null
        }
      });
      button.disabled = Boolean(options.disabled);
      button.addEventListener("click", (event) => {
        if (actionPending || inlineForm?.pending) return;
        closeMenuFrom(event.currentTarget);
        onActivate(event);
      });
      return button;
    }

    function iconButton(label, glyph, onActivate) {
      const button = element(documentRef, "button", {
        className: "nfs-icon-button",
        text: glyph,
        attributes: {
          type: "button",
          title: label,
          "aria-label": label
        }
      });
      button.addEventListener("click", (event) => {
        if (actionPending || inlineForm?.pending) return;
        onActivate(event);
      });
      return button;
    }

    function dragHandle(label) {
      return element(documentRef, "button", {
        className: "nfs-drag-handle",
        text: "⠿",
        attributes: {
          type: "button",
          title: label,
          "aria-label": label,
          tabindex: "-1"
        }
      });
    }

    function menu(summaryLabel) {
      const details = element(documentRef, "details", { className: "nfs-menu" });
      const summary = element(documentRef, "summary", {
        className: "nfs-menu-summary",
        text: "⋯",
        attributes: {
          title: summaryLabel,
          "aria-label": summaryLabel
        }
      });
      const panel = element(documentRef, "div", {
        className: "nfs-menu-panel",
        attributes: { role: "group", "aria-label": summaryLabel }
      });
      details.append(summary, panel);
      const position = () => {
        if (!details.open || !details.isConnected) return;
        const bounds = menuViewportBounds();
        const anchor = details.getBoundingClientRect();
        const gap = 4;
        const above = Math.max(0, anchor.top - bounds.top - gap);
        const below = Math.max(0, bounds.bottom - anchor.bottom - gap);
        panel.style.width = `${Math.max(0, Math.min(190, bounds.right - bounds.left - gap * 2))}px`;
        panel.style.maxHeight = "320px";
        const desiredHeight = Math.min(320, panel.scrollHeight + 2);
        const openAbove = below < desiredHeight && above > below;
        panel.style.maxHeight = `${Math.max(0, openAbove ? above : below)}px`;
        panel.style.top = openAbove ? "auto" : `${anchor.height + gap}px`;
        panel.style.bottom = openAbove ? `${anchor.height + gap}px` : "auto";
        panel.style.left = "auto";
        panel.style.right = `${Math.max(0, anchor.right - bounds.right + gap)}px`;
        const placed = panel.getBoundingClientRect();
        if (placed.left < bounds.left + gap) {
          panel.style.right = "auto";
          panel.style.left = `${bounds.left + gap - anchor.left}px`;
        }
      };
      menuLayouts.set(details, { panel, position });
      details.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !details.open) return;
        event.preventDefault();
        event.stopPropagation();
        details.open = false;
        summary.focus?.({ preventScroll: true });
      });
      details.addEventListener("toggle", () => {
        if (!details.open) return;
        for (const other of root.querySelectorAll("details[open]")) {
          if (other !== details) other.open = false;
        }
        position();
      });
      return { details, panel };
    }

    function divider() {
      return element(documentRef, "div", {
        className: "nfs-divider",
        attributes: { role: "separator" }
      });
    }

    function movementSelect(labelText, optionsList, currentValue, onChange) {
      const label = element(documentRef, "label", {
        className: "nfs-field-label",
        text: labelText
      });
      const select = element(documentRef, "select", {
        className: "nfs-select",
        attributes: { "aria-label": labelText }
      });

      for (const optionData of optionsList) {
        const option = element(documentRef, "option", {
          text: optionData.label,
          attributes: { value: optionData.value }
        });
        option.selected = optionData.value === currentValue;
        select.append(option);
      }

      select.addEventListener("change", (event) => {
        const value = event.currentTarget.value;
        closeMenuFrom(event.currentTarget);
        onChange(value);
      });
      return [label, select];
    }

    function installDragSource(handle, payload, sourceNode = handle) {
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) => {
        event.stopPropagation();
        dragged = payload;
        sourceNode.setAttribute("aria-grabbed", "true");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(
            "application/x-notion-favorite-sections",
            JSON.stringify(payload)
          );
          event.dataTransfer.setData("text/plain", `${payload.kind}:${payload.id}`);
        }
      });
      handle.addEventListener("dragend", (event) => {
        event.stopPropagation();
        dragged = null;
        sourceNode.removeAttribute("aria-grabbed");
        for (const target of shadowRoot.querySelectorAll(
          ".nfs-drop-before, .nfs-drop-inside"
        )) {
          target.classList.remove("nfs-drop-before", "nfs-drop-inside");
        }
      });
    }

    function installDropTarget(node, accepts, onDrop, className = "nfs-drop-inside") {
      node.addEventListener("dragover", (event) => {
        if (event.target?.closest?.(".nfs-page-tree-list")) return;
        if (!dragged || !accepts(dragged)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
        node.classList.add(className);
      });
      node.addEventListener("dragleave", (event) => {
        if (!node.contains(event.relatedTarget)) {
          node.classList.remove(className);
        }
      });
      node.addEventListener("drop", (event) => {
        if (event.target?.closest?.(".nfs-page-tree-list")) return;
        if (!dragged || !accepts(dragged)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        node.classList.remove(className);
        const payload = dragged;
        dragged = null;
        onDrop(payload);
      });
    }

    function renderGroupMenu(group, groupIndex, groups) {
      const { details, panel } = menu(`${entityLabel(group.name, "그룹")} 메뉴`);
      const userGroups = groups.filter((candidate) => !candidate.system);
      const userIndex = userGroups.findIndex((candidate) => candidate.id === group.id);

      panel.append(
        actionButton("그룹 이름 변경", () => {
          requestName("그룹 이름 변경", "onRenameGroup", [group.id], group.name);
        })
      );
      panel.append(
        actionButton(
          "위로 이동",
          () => invoke("onMoveGroup", group.id, userIndex - 1),
          { disabled: userIndex === 0 }
        ),
        actionButton(
          "아래로 이동",
          () => invoke("onMoveGroup", group.id, userIndex + 1),
          { disabled: userIndex === userGroups.length - 1 }
        )
      );
      panel.append(
        divider(),
        actionButton(
          "그룹 삭제",
          () => {
            requestConfirmation("그룹을 삭제할까요?", `“${group.name}”의 섹션과 즐겨찾기는 미분류 그룹으로 이동합니다.`, "onDeleteGroup", [group.id]);
          },
          { danger: true }
        )
      );

      return details;
    }

    function renderSectionMenu(section, sectionIndex, group, groups) {
      const { details, panel } = menu(`${entityLabel(section.name, "섹션")} 메뉴`);
      const isSystem = Boolean(section.system);
      const userSections = (group.sections || []).filter(
        (candidate) => !candidate.system
      );
      const userIndex = userSections.findIndex(
        (candidate) => candidate.id === section.id
      );

      if (!isSystem) {
        panel.append(
          actionButton("섹션 이름 변경", () => {
            requestName("섹션 이름 변경", "onRenameSection", [section.id], section.name);
          })
        );
      }

      panel.append(
        actionButton(
          "위로 이동",
          () => invoke("onMoveSection", section.id, group.id, userIndex - 1),
          { disabled: userIndex === 0 }
        ),
        actionButton(
          "아래로 이동",
          () => invoke("onMoveSection", section.id, group.id, userIndex + 1),
          { disabled: userIndex === userSections.length - 1 }
        )
      );

      if (!isSystem && groups.length > 1) {
        const selectParts = movementSelect(
          "다른 그룹으로 이동",
          groups.map((candidate) => ({
            label: candidate.name,
            value: candidate.id
          })),
          group.id,
          (targetGroupId) => {
            if (targetGroupId !== group.id) {
              invoke("onMoveSection", section.id, targetGroupId);
            }
          }
        );
        panel.append(divider(), ...selectParts);
      }

      if (!isSystem) {
        panel.append(
          divider(),
          actionButton(
            "섹션 삭제",
            () => {
              requestConfirmation("섹션을 삭제할까요?", `“${section.name}”의 즐겨찾기는 이 그룹의 미분류 섹션으로 이동합니다.`, "onDeleteSection", [section.id]);
            },
            { danger: true }
          )
        );
      }

      return details;
    }

    function renderFavoriteMenu(favorite, section, groups) {
      const { details, panel } = menu(`${favorite.title || "즐겨찾기"} 메뉴`);
      const sectionOptions = [];

      for (const group of groups) {
        for (const candidate of group.sections || []) {
          sectionOptions.push({
            label: `${group.name} / ${candidate.name}`,
            value: candidate.id
          });
        }
      }

      const orderedFavorites = activeFavorites(section);
      const favoriteIndex = orderedFavorites.findIndex((item) => item.pageId === favorite.pageId);
      panel.append(
        actionButton("위로 이동", () => invoke("onMoveFavorite", favorite.pageId, section.id, favoriteIndex - 1), { disabled: favoriteIndex <= 0 }),
        actionButton("아래로 이동", () => invoke("onMoveFavorite", favorite.pageId, section.id, favoriteIndex + 1), { disabled: favoriteIndex === orderedFavorites.length - 1 }),
        divider(),
        ...movementSelect(
          "그룹 / 섹션으로 이동",
          sectionOptions,
          section.id,
          (targetSectionId) => {
            if (targetSectionId !== section.id) {
              invoke("onMoveFavorite", favorite.pageId, targetSectionId);
            }
          }
        )
      );

      panel.append(
        divider(),
        actionButton(
          "FAVMOA에서 제거",
          () => {
            requestConfirmation("FAVMOA에서 제거할까요?", `“${favorite.title || "즐겨찾기"}”를 내 정리 목록에서 뺍니다. Notion의 원본 즐겨찾기는 그대로입니다.`, "onRemoveFavorite", [favorite.pageId], "제거");
          },
          { danger: true }
        )
      );

      return details;
    }

    function indexPageNavigation() {
      navigationById = new Map();
      activeNavigationAncestors = new Set();
      function visit(node, ancestors = []) {
        if (!node) return;
        const existing = navigationById.get(node.pageId);
        if (!existing || existing.children.length < node.children.length) navigationById.set(node.pageId, node);
        if (node.pageId === String(currentActivePageId || "")) {
          for (const id of [...ancestors, node.pageId]) activeNavigationAncestors.add(id);
        }
        for (const child of node.children) visit(child, [...ancestors, node.pageId]);
      }
      for (const node of currentPageNavigation?.roots || []) visit(node);
      visit(currentPageNavigation?.currentPage);
      const current = currentPageNavigation?.currentPage;
      if (current && current.pageId === String(currentActivePageId || "") && current.href) {
        const indexed = navigationById.get(current.pageId);
        navigationById.set(current.pageId, { ...indexed, href: current.href });
      }
    }

    function sectionContainsActivePage(section) {
      return sectionContainsPage(section, currentActivePageId) || activeFavorites(section).some(
        favorite => activeNavigationAncestors.has(String(favorite.pageId || ""))
      );
    }

    function pageBranchId(location, path) {
      const encoded = Array.from(`${location}:${path}`).map(char => char.codePointAt(0).toString(16)).join("-");
      return `${pickerId}-children-${encoded}`;
    }

    function appendPageBranch(item, row, node, location, path, { defaultOpen = false } = {}) {
      if (!node?.children?.length) return false;
      const branchKey = `${location}:${path}`;
      const expanded = pageBranchStates.has(branchKey)
        ? pageBranchStates.get(branchKey)
        : defaultOpen || activeNavigationAncestors.has(node.pageId) && node.pageId !== String(currentActivePageId || "");
      const listId = pageBranchId(location, path);
      const toggle = element(documentRef, "button", {
        className: "nfs-toggle nfs-page-toggle",
        attributes: {
          type: "button", "aria-label": `${node.title} 하위 페이지 ${expanded ? "접기" : "펼치기"}`,
          "aria-expanded": String(expanded), "aria-controls": listId,
          "data-focus-key": `navigation:${branchKey}:toggle`
        }
      });
      toggle.append(element(documentRef, "span", { className: "nfs-chevron", text: "⌄", attributes: { "aria-hidden": "true" } }));
      const setExpanded = next => {
        pageBranchStates.set(branchKey, next);
        render();
      };
      toggle.addEventListener("click", () => setExpanded(!expanded));
      toggle.addEventListener("keydown", event => {
        if (event.key === "ArrowRight" && !expanded || event.key === "ArrowLeft" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(event.key === "ArrowRight");
        }
      });
      row.prepend(toggle);
      const list = element(documentRef, "ul", {
        className: "nfs-page-tree-list nfs-page-tree-children",
        attributes: { id: listId, "aria-label": `${node.title} 하위 페이지`, hidden: expanded ? null : "" }
      });
      list.hidden = !expanded;
      for (const child of node.children) {
        if (remainingNavigationRows <= 0) {
          list.append(element(documentRef, "li", { className: "nfs-page-navigation-helper", text: "표시할 페이지가 많아요. 필요한 하위 페이지를 Notion에서 직접 열어 주세요." }));
          break;
        }
        list.append(renderPageNode(child, location, `${path}/${child.pageId}`));
      }
      item.append(list);
      return true;
    }

    function renderPageNode(node, location, path, { defaultOpen = false } = {}) {
      remainingNavigationRows -= 1;
      const isCurrent = node.pageId === String(currentActivePageId || "");
      const item = element(documentRef, "li", {
        className: "nfs-page-tree-item",
        attributes: { "data-page-id": node.pageId, "data-location": location, "data-navigation-path": path, "data-current": isCurrent ? "true" : null }
      });
      const row = element(documentRef, "div", { className: "nfs-row" });
      const link = element(documentRef, node.href ? "a" : "span", {
        className: "nfs-favorite-link",
        attributes: {
          href: node.href, "aria-current": isCurrent ? "page" : null,
          title: node.href ? node.title : `${node.title} · Notion에서 이 페이지를 한 번 열거나 즐겨찾기 목록을 펼쳐 주소를 확인해 주세요.`,
          "data-focus-key": node.href ? `navigation:${location}:${path}:link` : null
        }
      });
      link.append(pageIcon(documentRef, node.icon), element(documentRef, "span", { className: "nfs-favorite-title", text: node.title }));
      row.append(link);
      item.append(row);
      if (!appendPageBranch(item, row, node, location, path, { defaultOpen })) row.prepend(element(documentRef, "span", { className: "nfs-page-toggle-spacer", attributes: { "aria-hidden": "true" } }));
      return item;
    }

    function renderCurrentPage() {
      const card = element(documentRef, "section", { className: "nfs-current-page", attributes: { "aria-label": "현재 열린 페이지" } });
      card.append(element(documentRef, "h3", { className: "nfs-current-page-heading", text: "현재 열린 페이지" }));
      const node = currentPageNavigation?.currentPage;
      if (node) {
        const list = element(documentRef, "ul", { className: "nfs-page-tree-list" });
        list.append(renderPageNode(node, "current", node.pageId, { defaultOpen: true }));
        card.append(list);
      }
      if (!node || !node.children.length || !currentPageNavigation.scopeSafe) {
        const text = !currentPageNavigation.scopeSafe
          ? "워크스페이스를 확인한 뒤 하위 페이지를 표시할 수 있어요."
          : !node
            ? "Notion 페이지를 열면 여기에 표시됩니다."
            : "아직 하위 페이지를 확인하지 못했어요. Notion에서 페이지 목록을 펼친 뒤 목록 갱신을 눌러 주세요.";
        card.append(element(documentRef, "p", { className: "nfs-page-navigation-helper", text }));
      }
      return card;
    }

    function renderFavorite(
      favoriteRef,
      favoriteIndex,
      section,
      group,
      groups,
      metadataById
    ) {
      const pageId = String(favoriteRef.pageId || "");
      const navigationNode = navigationById.get(pageId);
      const cached = currentFavoriteMetadata.get(pageId) || {};
      const metadata = metadataById.get(pageId) || {};
      const navigationTitle = ["현재 열린 페이지", "제목 없음"].includes(navigationNode?.title) ? "" : navigationNode?.title;
      const currentHref = pageId === String(currentActivePageId || "") && currentPageNavigation?.currentPage?.pageId === pageId
        ? safeNavigationHref(currentPageNavigation.currentPage.href, pageId) : null;
      const favorite = {
        pageId,
        title: metadata.title || metadata.name || navigationTitle || cached.title || `제목을 불러오지 못한 페이지 · ${pageId.slice(-6)}`,
        href: currentHref || urls.preferredPageUrl(pageId, [metadata.href || metadata.url, navigationNode?.href, cached.href], { allowLegacyHost: true }),
        iconText: favoriteIconText(metadata.iconText || metadata.icon || navigationNode?.icon || cached.icon)
      };
      const item = element(documentRef, "li", {
        className:
          pageId === String(currentActivePageId || "")
            ? "nfs-favorite nfs-favorite-active"
            : "nfs-favorite",
        attributes: {
          "data-page-id": pageId,
          "data-location": `favorite:${section.id}:${pageId}`
        }
      });
      const row = element(documentRef, "div", { className: "nfs-row" });
      const href = safeFavoriteHref(favorite.href);
      const link = element(documentRef, href ? "a" : "span", {
        className: "nfs-favorite-link",
        attributes: href
          ? {
              href,
              title: favorite.title,
              "aria-current": pageId === String(currentActivePageId || "") ? "page" : null
            }
          : { "aria-disabled": "true", title: "Notion에서 이 페이지를 한 번 열거나 즐겨찾기 목록을 펼친 뒤 목록 갱신을 눌러 주세요." }
      });
      const icon = pageIcon(documentRef, favorite.iconText);
      const title = element(documentRef, "span", {
        className: "nfs-favorite-title",
        text: favorite.title
      });
      const handle = dragHandle(`${favorite.title} 즐겨찾기 이동`);

      link.append(icon, title);
      if (!href) link.append(element(documentRef, "span", {
        className: "nfs-page-navigation-helper", text: "주소 확인 필요"
      }));
      row.append(link, handle, renderFavoriteMenu(favorite, section, groups));
      item.append(row);
      appendPageBranch(item, row, navigationNode, `favorite:${section.id}:${pageId}`, pageId);

      installDragSource(
        handle,
        {
          kind: "favorite",
          id: pageId,
          sectionId: section.id
        },
        item
      );
      installDropTarget(
        item,
        (payload) => payload.kind === "favorite" && payload.id !== pageId,
        (payload) => {
          invoke("onMoveFavorite", payload.id, section.id, { beforeId: pageId });
        },
        "nfs-drop-before"
      );

      return item;
    }

    function renderSection(section, sectionIndex, group, groups, metadataById) {
      const forcedOpen =
        sectionContainsActivePage(section) &&
        !suppressedActiveSections.has(section.id);
      const renderedCollapsed = Boolean(section.collapsed && !forcedOpen);
      const item = element(documentRef, "li", {
        className: "nfs-section",
        attributes: {
          "data-section-id": section.id,
          "data-color": validColor(section.color),
          "data-auto-expanded": forcedOpen && section.collapsed ? "true" : null
        }
      });
      const row = element(documentRef, "div", { className: "nfs-row" });
      const favoritesId = `nfs-favorites-${safeDomId(section.id)}`;
      const toggle = element(documentRef, "button", {
        className: "nfs-toggle",
        attributes: {
          type: "button",
          "aria-label": `${entityLabel(section.name, "섹션")} ${renderedCollapsed ? "펼치기" : "접기"}`,
          "aria-expanded": String(!renderedCollapsed),
          "aria-controls": favoritesId
        }
      });
      toggle.append(
        element(documentRef, "span", {
          className: "nfs-chevron",
          text: "⌄",
          attributes: { "aria-hidden": "true" }
        })
      );
      const toggleSection = () => {
        if (actionPending || inlineForm?.pending) return;
        if (!renderedCollapsed) suppressedActiveSections.add(section.id);
        else suppressedActiveSections.delete(section.id);
        if (Boolean(section.collapsed) === !renderedCollapsed) {
          render();
          return;
        }
        invoke("onToggleSection", section.id);
      };
      toggle.addEventListener("click", toggleSection);

      const labelButton = toggle;
      labelButton.className = "nfs-toggle nfs-label-button";
      labelButton.setAttribute("title", section.name);
      if (section.emoji) {
        labelButton.append(
          element(documentRef, "span", {
            className: "nfs-emoji",
            text: section.emoji,
            attributes: { "aria-hidden": "true" }
          })
        );
      } else {
        labelButton.append(
          element(documentRef, "span", {
            className: "nfs-color",
            attributes: { "aria-hidden": "true" }
          })
        );
      }
      labelButton.append(
        element(documentRef, "span", { className: "nfs-label", text: section.name }),
        element(documentRef, "span", {
          className: "nfs-count",
          text: activeFavorites(section).length,
          attributes: { "aria-label": `즐겨찾기 ${activeFavorites(section).length}개` }
        })
      );
      row.append(toggle);
      if (!section.system) {
        const handle = dragHandle(`${section.name} 섹션 이동`);
        row.append(handle);
        installDragSource(
          handle,
          {
            kind: "section",
            id: section.id,
            groupId: group.id
          },
          item
        );
        row.append(renderSectionMenu(section, sectionIndex, group, groups));
      }
      item.append(row);

      const favoriteList = element(documentRef, "ul", {
        className: "nfs-favorite-list",
        attributes: {
          id: favoritesId,
          hidden: renderedCollapsed ? "" : null,
          "aria-label": `${section.name} 섹션 즐겨찾기`
        }
      });
      favoriteList.hidden = renderedCollapsed;

      const visibleFavorites = activeFavorites(section);
      if (visibleFavorites.length === 0) {
        favoriteList.append(
          element(documentRef, "li", {
            className: "nfs-empty",
            text: "즐겨찾기를 추가해 보세요."
          })
        );
      } else {
        visibleFavorites.forEach((favorite, favoriteIndex) => {
          favoriteList.append(
            renderFavorite(
              favorite,
              favoriteIndex,
              section,
              group,
              groups,
              metadataById
            )
          );
        });
      }
      item.append(favoriteList);

      installDropTarget(
        row,
        (payload) =>
          (payload.kind === "section" && payload.id !== section.id) ||
          payload.kind === "favorite",
        (payload) => {
          if (payload.kind === "section") {
            invoke(
              "onMoveSection",
              payload.id,
              group.id,
              section.system ? undefined : { beforeId: section.id }
            );
          } else {
            invoke("onMoveFavorite", payload.id, section.id);
          }
        }
      );

      return item;
    }

    function renderGroup(group, groupIndex, groups, metadataById) {
      const forcedOpen =
        (group.sections || []).some(sectionContainsActivePage) &&
        !suppressedActiveGroups.has(group.id);
      const renderedCollapsed = Boolean(group.collapsed && !forcedOpen);
      const item = element(documentRef, "li", {
        className: "nfs-group",
        attributes: {
          "data-group-id": group.id,
          "data-color": validColor(group.color),
          "data-auto-expanded": forcedOpen && group.collapsed ? "true" : null
        }
      });
      const row = element(documentRef, "div", { className: "nfs-row" });
      const sectionsId = `nfs-sections-${safeDomId(group.id)}`;
      const toggle = element(documentRef, "button", {
        className: "nfs-toggle",
        attributes: {
          type: "button",
          "aria-label": `${entityLabel(group.name, "그룹")} ${renderedCollapsed ? "펼치기" : "접기"}`,
          "aria-expanded": String(!renderedCollapsed),
          "aria-controls": sectionsId
        }
      });
      toggle.append(
        element(documentRef, "span", {
          className: "nfs-chevron",
          text: "⌄",
          attributes: { "aria-hidden": "true" }
        })
      );
      const toggleGroup = () => {
        if (actionPending || inlineForm?.pending) return;
        if (!renderedCollapsed) suppressedActiveGroups.add(group.id);
        else suppressedActiveGroups.delete(group.id);
        if (Boolean(group.collapsed) === !renderedCollapsed) {
          render();
          return;
        }
        invoke("onToggleGroup", group.id);
      };
      toggle.addEventListener("click", toggleGroup);

      const labelButton = toggle;
      labelButton.className = "nfs-toggle nfs-label-button";
      labelButton.setAttribute("title", group.name);
      if (group.emoji) {
        labelButton.append(
          element(documentRef, "span", {
            className: "nfs-emoji",
            text: group.emoji,
            attributes: { "aria-hidden": "true" }
          })
        );
      } else {
        labelButton.append(
          element(documentRef, "span", {
            className: "nfs-color",
            attributes: { "aria-hidden": "true" }
          })
        );
      }
      labelButton.append(
        element(documentRef, "span", { className: "nfs-label", text: group.name }),
        element(documentRef, "span", {
          className: "nfs-count",
          text: favoriteCount(group),
          attributes: { "aria-label": `즐겨찾기 ${favoriteCount(group)}개` }
        })
      );
      const addSection = iconButton(`${group.name}에 섹션 추가`, "+", () => {
        requestName("새 섹션 이름", "onCreateSection", [group.id]);
      });

      row.append(toggle, addSection);
      if (!group.system) {
        const handle = dragHandle(`${group.name} 그룹 이동`);
        row.append(handle);
        installDragSource(handle, { kind: "group", id: group.id }, item);
        row.append(renderGroupMenu(group, groupIndex, groups));
      }
      item.append(row);

      const sectionList = element(documentRef, "ul", {
        className: "nfs-section-list",
        attributes: {
          id: sectionsId,
          hidden: renderedCollapsed ? "" : null,
          "aria-label": `${group.name} 그룹 섹션`
        }
      });
      sectionList.hidden = renderedCollapsed;

      const renderedSections = visibleSections(group);
      if (renderedSections.length === 0) {
        sectionList.append(
          element(documentRef, "li", {
            className: "nfs-empty",
            text: "오른쪽 +로 섹션을 만들어 즐겨찾기를 정리해 보세요."
          })
        );
      } else {
        renderedSections.forEach((section) => {
          const sectionIndex = (group.sections || []).indexOf(section);
          sectionList.append(
            renderSection(section, sectionIndex, group, groups, metadataById)
          );
        });
      }
      item.append(sectionList);

      installDropTarget(
        row,
        (payload) =>
          (payload.kind === "group" && payload.id !== group.id) ||
          payload.kind === "section" ||
          payload.kind === "favorite",
        (payload) => {
          if (payload.kind === "group") {
            invoke(
              "onMoveGroup",
              payload.id,
              group.system ? undefined : { beforeId: group.id }
            );
          } else if (payload.kind === "section") {
            invoke("onMoveSection", payload.id, group.id);
          } else {
            invoke("onMoveFavoriteToGroup", payload.id, group.id);
          }
        }
      );

      return item;
    }

    function render() {
      if (destroyed) {
        return;
      }

      const rawFocused = shadowRoot.activeElement;
      const focused = rawFocused?.closest?.("details:not([open])")?.querySelector("summary") || rawFocused;
      const focusedKey = focusKey(focused);
      const focusedMenuKey = focusKey(focused?.closest?.("details[open]")?.querySelector("summary"));
      const selection = focused?.selectionStart !== undefined && focused?.selectionStart !== null
        ? { start: focused.selectionStart, end: focused.selectionEnd }
        : null;
      const scrollTop = root.scrollTop;
      menuLayouts.clear();
      remainingNavigationRows = 1000;
      indexPageNavigation();

      const groups = Array.isArray(currentWorkspace.groups)
        ? currentWorkspace.groups
        : [];
      const renderedGroups = visibleGroups(groups);
      const metadataById = favoriteMetadataMap(currentFavorites);
      const header = element(documentRef, "div", { className: "nfs-header" });
      const addGroupButton = element(documentRef, "button", {
        className: "nfs-add-button",
        text: "+ 그룹",
        attributes: {
          type: "button",
          title: "그룹 추가",
          "aria-label": "그룹 추가"
        }
      });
      addGroupButton.addEventListener("click", () => {
        requestName("새 그룹 이름", "onCreateGroup");
      });
      header.append(
        element(documentRef, "span", {
          className: "nfs-heading",
          text: "그룹"
        }),
        addGroupButton
      );

      const fragment = documentRef.createDocumentFragment();
      fragment.append(renderTopBar());
      if (currentPageNavigation) {
        fragment.append(renderCurrentPage(), element(documentRef, "p", { className: "nfs-page-navigation-note", text: "Notion 화면에 로드된 하위 페이지만 표시합니다. 하위 링크는 즐겨찾기에 자동 추가되지 않아요." }));
      }
      if (pickerOpen) {
        fragment.append(renderFavoritePicker());
      }
      if (inlineForm) fragment.append(renderInlineForm());
      fragment.append(header);

      if (currentStatus && currentStatus.message) {
        fragment.append(
          element(documentRef, "div", {
            className: "nfs-status",
            text: currentStatus.message,
            attributes: {
              role: currentStatus.tone === "error" ? "alert" : "status",
              "data-tone": currentStatus.tone || "info"
            }
          })
        );
      }

      const tree = element(documentRef, "ul", {
        className: "nfs-tree",
        attributes: { "aria-label": "그룹, 섹션, 즐겨찾기 트리" }
      });
      if (renderedGroups.length === 0) {
        const onboarding = element(documentRef, "li", { className: "nfs-onboarding" });
        onboarding.append(
          element(documentRef, "h3", { text: "자주 쓰는 페이지를 한곳에" }),
          element(documentRef, "p", { text: "Notion 즐겨찾기에서 페이지를 골라 담으세요. 그룹과 섹션으로 나누어 접고 펼칠 수 있어요." })
        );
        const start = actionButton("즐겨찾기 추가하기", () => {
          pickerOpen = true;
          render();
          focusPickerSearch();
        }, { disabled: currentImportPreview?.canManage === false || currentImportPreview?.busy === true });
        start.className += " nfs-primary";
        onboarding.append(start);
        if (currentImportPreview?.canManage === false) onboarding.append(element(documentRef, "p", { text: "FAVMOA를 닫고 Notion의 즐겨찾기 목록을 펼친 뒤 다시 열어 주세요." }));
        tree.append(onboarding);
      } else {
        renderedGroups.forEach((group) => {
          const groupIndex = groups.indexOf(group);
          tree.append(renderGroup(group, groupIndex, groups, metadataById));
        });
      }
      if (currentUndoState?.canUndo) {
        const undo = element(documentRef, "div", { className: "nfs-status nfs-undo" });
        undo.append(element(documentRef, "span", { text: currentUndoState.label ? `최근 변경: ${currentUndoState.label.replace(/\s*되돌리기$/, "")}` : "마지막 변경을 되돌릴 수 있어요." }));
        const undoButton = actionButton("되돌리기", async () => {
          const result = await invoke("onUndo");
          if (result.ok) setStatus("마지막 변경을 되돌렸습니다.", "success");
        });
        undoButton.setAttribute("aria-label", "마지막 작업 되돌리기");
        undo.append(undoButton);
        fragment.append(undo);
      }
      fragment.append(tree, renderResetZone());
      root.replaceChildren(fragment);

      // Stable focus identities survive updates without storing titles or DOM nodes.
      const keyCounts = new Map();
      for (const control of root.querySelectorAll("button, input, select, summary, a[href]")) {
        if (control.hasAttribute("data-focus-key")) continue;
        const owner = control.closest("[data-page-id], [data-section-id], [data-group-id]");
        const ownerId = owner?.getAttribute("data-page-id") || owner?.getAttribute("data-section-id") || owner?.getAttribute("data-group-id") || "view";
        const isToggle = control.classList.contains("nfs-toggle");
        const label = isToggle ? "disclosure" : control.tagName === "SUMMARY" ? "menu" : control.tagName === "A" ? "page-link" : control.getAttribute("aria-label") || control.getAttribute("data-picker-page-id") || control.className + ":" + (control.textContent || "");
        const formScope = control.closest(".nfs-inline-form") ? "form:" : "";
        const location = control.closest("[data-location]")?.getAttribute("data-location") || "managed";
        const base = `${formScope}${location}:${ownerId}:${control.tagName}:${label}`;
        const index = keyCounts.get(base) || 0;
        keyCounts.set(base, index + 1);
        control.setAttribute("data-focus-key", `${base}:${index}`);
      }
      if (focusedMenuKey) {
        const summary = [...root.querySelectorAll("summary")].find((node) => focusKey(node) === focusedMenuKey);
        if (summary) summary.closest("details").open = true;
      }
      if (focusedKey) {
        const restored = focusByKey(focusedKey);
        if (restored && selection) shadowRoot.activeElement?.setSelectionRange?.(selection.start, selection.end);
        if (!restored && !inlineForm) root.querySelector('[aria-label="그룹 추가"]')?.focus?.({ preventScroll: true });
      }
      root.scrollTop = scrollTop;

      if (currentActivePageId && currentActivePageId !== lastScrolledActivePageId) {
        lastScrolledActivePageId = currentActivePageId;
        const activeItem = root.querySelector('.nfs-current-page [aria-current="page"]') || root.querySelector('.nfs-tree [aria-current="page"]');
        const reveal = () => {
          if (activeItem && typeof activeItem.scrollIntoView === "function") {
            activeItem.scrollIntoView({ block: "nearest" });
          }
        };
        if (typeof globalScope.requestAnimationFrame === "function") {
          globalScope.requestAnimationFrame(reveal);
        } else {
          reveal();
        }
      }
    }

    function update(next = {}) {
      if (Object.prototype.hasOwnProperty.call(next, "workspaceKey")) {
        if (currentWorkspaceKey !== undefined && currentWorkspaceKey !== next.workspaceKey) {
          inlineForm = null;
          pickerOpen = false;
          pickerSelectedIds.clear();
          suppressedActiveGroups.clear();
          suppressedActiveSections.clear();
          pageBranchStates.clear();
          currentPageNavigation = null;
          currentFavoriteMetadata = new Map();
          lastScrolledActivePageId = null;
        }
        currentWorkspaceKey = next.workspaceKey;
      }
      if (Object.prototype.hasOwnProperty.call(next, "workspaceRevision")) currentWorkspaceRevision = next.workspaceRevision;
      if (Object.prototype.hasOwnProperty.call(next, "undoState")) currentUndoState = next.undoState;
      if (Object.prototype.hasOwnProperty.call(next, "workspace")) {
        currentWorkspace = next.workspace || { groups: [] };
      }
      if (Object.prototype.hasOwnProperty.call(next, "favorites")) {
        currentFavorites = next.favorites || [];
      }
      if (Object.prototype.hasOwnProperty.call(next, "favoriteMetadata")) currentFavoriteMetadata = favoriteMetadataMap(next.favoriteMetadata || []);
      if (Object.prototype.hasOwnProperty.call(next, "pageNavigation")) currentPageNavigation = normalizePageNavigation(next.pageNavigation);
      if (Object.prototype.hasOwnProperty.call(next, "callbacks")) {
        callbacks = next.callbacks || {};
      }
      if (Object.prototype.hasOwnProperty.call(next, "status")) {
        currentStatus = next.status;
      }
      if (Object.prototype.hasOwnProperty.call(next, "importPreview")) {
        currentImportPreview = next.importPreview || null;
      }
      if (Object.prototype.hasOwnProperty.call(next, "activePageId")) {
        const nextActivePageId = next.activePageId || null;
        if (nextActivePageId !== currentActivePageId) {
          lastScrolledActivePageId = null;
          suppressedActiveGroups.clear();
          suppressedActiveSections.clear();
          pageBranchStates.clear();
        }
        currentActivePageId = nextActivePageId;
      }
      render();
    }

    function destroy() {
      destroyed = true;
      dragged = null;
      if (statusTimer !== null) globalScope.clearTimeout(statusTimer);
      statusTimer = null;
      menuScrollSurface?.removeEventListener("scroll", positionOpenMenus, true);
      globalScope.removeEventListener?.("resize", positionOpenMenus);
      menuLayouts.clear();
      shadowRoot.replaceChildren();
    }

    render();

    return {
      update,
      render: update,
      setStatus,
      announce,
      destroy,
      get shadowRoot() {
        return shadowRoot;
      }
    };
  }

  namespace.view = Object.freeze({
    createFavoriteTreeView
  });
})(globalThis);
