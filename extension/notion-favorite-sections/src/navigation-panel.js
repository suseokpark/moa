(function initializeNotionNavigationPanel(globalScope) {
  "use strict";

  const namespace = globalScope.NotionFavoriteSections =
    globalScope.NotionFavoriteSections || {};

  const STYLE_TEXT = `
    :host {
      position: fixed;
      z-index: 2147483645;
      top: 16px;
      right: 16px;
      color: CanvasText;
      font: 13px/1.4 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    *, *::before, *::after { box-sizing: border-box; }
    button { color: inherit; font: inherit; }

    .nnt-panel {
      width: min(320px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      overflow: hidden;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 12px;
      background: color-mix(in srgb, Canvas 96%, transparent);
      box-shadow: 0 14px 40px rgba(0, 0, 0, .18);
      backdrop-filter: blur(12px);
    }

    .nnt-header {
      display: flex;
      align-items: center;
      min-height: 42px;
      padding: 7px 8px 7px 12px;
      gap: 7px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
    }

    .nnt-heading { flex: 1; min-width: 0; }
    .nnt-title { font-size: 13px; font-weight: 700; }
    .nnt-badge {
      margin-top: 1px;
      color: color-mix(in srgb, CanvasText 52%, transparent);
      font-size: 10px;
    }

    .nnt-icon-button,
    .nnt-reopen {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      cursor: pointer;
    }

    .nnt-icon-button {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: transparent;
    }

    .nnt-icon-button:hover { background: color-mix(in srgb, CanvasText 8%, transparent); }

    .nnt-content {
      max-height: calc(100vh - 75px);
      overflow: auto;
      padding: 7px;
    }

    .nnt-section + .nnt-section { margin-top: 8px; }
    .nnt-section-title {
      padding: 5px 7px;
      color: color-mix(in srgb, CanvasText 58%, transparent);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .05em;
      text-transform: uppercase;
    }

    .nnt-tree,
    .nnt-children {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .nnt-children { padding-left: 14px; }
    .nnt-item { min-width: 0; }
    .nnt-row {
      display: flex;
      align-items: center;
      min-width: 0;
      min-height: 29px;
      border-radius: 6px;
    }

    .nnt-row:hover { background: color-mix(in srgb, CanvasText 7%, transparent); }
    .nnt-item-active > .nnt-row {
      background: color-mix(in srgb, #3b82f6 14%, transparent);
      box-shadow: inset 3px 0 0 #3b82f6;
    }

    .nnt-toggle {
      width: 24px;
      height: 24px;
      flex: 0 0 24px;
      padding: 0;
      border: 0;
      border-radius: 5px;
      background: transparent;
      cursor: pointer;
      color: color-mix(in srgb, CanvasText 55%, transparent);
    }

    .nnt-toggle:hover { background: color-mix(in srgb, CanvasText 8%, transparent); }
    .nnt-toggle-placeholder { width: 24px; flex: 0 0 24px; }
    .nnt-chevron { display: inline-block; transition: transform 100ms ease; }
    .nnt-toggle[aria-expanded="false"] .nnt-chevron { transform: rotate(-90deg); }

    .nnt-link,
    .nnt-label {
      display: flex;
      flex: 1;
      align-items: center;
      min-width: 0;
      min-height: 29px;
      padding: 0 6px 0 2px;
      gap: 6px;
      border-radius: 5px;
      color: inherit;
      text-decoration: none;
    }

    .nnt-icon { width: 18px; flex: 0 0 18px; text-align: center; }
    .nnt-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nnt-item-active .nnt-text { font-weight: 650; }

    .nnt-empty,
    .nnt-status {
      margin: 3px 7px;
      color: color-mix(in srgb, CanvasText 55%, transparent);
      font-size: 11px;
    }

    .nnt-status {
      padding: 7px;
      border-radius: 6px;
      background: color-mix(in srgb, #f59e0b 10%, transparent);
      color: #a16207;
    }

    .nnt-reopen {
      width: 42px;
      height: 42px;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 12px;
      background: Canvas;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .16);
      font-size: 18px;
    }

    [hidden] { display: none !important; }
    @media (prefers-reduced-motion: reduce) { .nnt-chevron { transition: none; } }
  `;

  function element(documentRef, tagName, options = {}) {
    const node = documentRef.createElement(tagName);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = String(options.text);
    for (const [name, value] of Object.entries(options.attributes || {})) {
      if (value !== null && value !== undefined) node.setAttribute(name, String(value));
    }
    return node;
  }

  function safeHref(value) {
    try {
      const url = new URL(String(value || ""), "https://app.notion.com/");
      return url.protocol === "https:" && url.hostname === "app.notion.com"
        ? url.href
        : null;
    } catch (_error) {
      return null;
    }
  }

  function nodeId(node) {
    return String(node?.pageId || node?.id || "");
  }

  function containsPage(node, pageId) {
    if (!node || !pageId) return false;
    if (nodeId(node) === String(pageId)) return true;
    return (node.children || []).some((child) => containsPage(child, pageId));
  }

  function createNavigationPanel(options) {
    if (!options?.host) {
      throw new TypeError("Navigation panel requires a host element.");
    }

    const host = options.host;
    const documentRef = host.ownerDocument || globalScope.document;
    const shadowRoot = host.shadowRoot || host.attachShadow({ mode: "open" });
    const style = element(documentRef, "style", { text: STYLE_TEXT });
    const mount = element(documentRef, "div");
    shadowRoot.replaceChildren(style, mount);

    let currentTrees = options.trees || { personal: [], teamspaces: [] };
    let currentActivePageId = options.activePageId || null;
    let currentStatus = options.status || null;
    let panelHidden = false;
    let destroyed = false;
    const expandedIds = new Set();

    for (const eventName of ["click", "mousedown", "pointerdown", "keydown"]) {
      mount.addEventListener(eventName, (event) => event.stopPropagation());
    }

    function renderNode(node, sourceKind, depth = 0) {
      const id = nodeId(node) || `${sourceKind}:${depth}:${node?.title || "node"}`;
      const children = Array.isArray(node?.children) ? node.children : [];
      const active = nodeId(node) === String(currentActivePageId || "");
      const activePath = containsPage(node, currentActivePageId);
      const open = activePath || expandedIds.has(id) || depth === 0;
      const item = element(documentRef, "li", {
        className: active ? "nnt-item nnt-item-active" : "nnt-item",
        attributes: {
          "data-node-id": id,
          "data-source-kind": sourceKind
        }
      });
      const row = element(documentRef, "div", { className: "nnt-row" });

      if (children.length > 0) {
        const toggle = element(documentRef, "button", {
          className: "nnt-toggle",
          attributes: {
            type: "button",
            "aria-label": `${node.title || "페이지"} ${open ? "접기" : "펼치기"}`,
            "aria-expanded": String(open)
          }
        });
        toggle.append(
          element(documentRef, "span", {
            className: "nnt-chevron",
            text: "⌄",
            attributes: { "aria-hidden": "true" }
          })
        );
        toggle.addEventListener("click", () => {
          if (expandedIds.has(id)) expandedIds.delete(id);
          else expandedIds.add(id);
          render();
        });
        row.append(toggle);
      } else {
        row.append(element(documentRef, "span", { className: "nnt-toggle-placeholder" }));
      }

      const href = safeHref(node?.href || node?.url);
      const label = element(documentRef, href ? "a" : "span", {
        className: href ? "nnt-link" : "nnt-label",
        attributes: href
          ? {
              href,
              title: node.title || "페이지",
              "aria-current": active ? "page" : null
            }
          : { title: node?.title || "페이지" }
      });
      label.append(
        element(documentRef, "span", {
          className: "nnt-icon",
          text: node?.icon || (sourceKind === "teamspace" ? "◆" : "□"),
          attributes: { "aria-hidden": "true" }
        }),
        element(documentRef, "span", {
          className: "nnt-text",
          text: node?.title || "제목 없는 페이지"
        })
      );
      row.append(label);
      item.append(row);

      if (children.length > 0) {
        const list = element(documentRef, "ul", {
          className: "nnt-children",
          attributes: { hidden: open ? null : "" }
        });
        list.hidden = !open;
        for (const child of children) list.append(renderNode(child, sourceKind, depth + 1));
        item.append(list);
      }
      return item;
    }

    function renderSection(title, nodes, sourceKind) {
      const section = element(documentRef, "section", {
        className: "nnt-section",
        attributes: { "aria-label": title }
      });
      section.append(element(documentRef, "div", { className: "nnt-section-title", text: title }));
      if (!Array.isArray(nodes) || nodes.length === 0) {
        section.append(
          element(documentRef, "div", {
            className: "nnt-empty",
            text: "현재 사이드바에 렌더된 페이지가 없습니다."
          })
        );
        return section;
      }
      const tree = element(documentRef, "ul", {
        className: "nnt-tree",
        attributes: { "aria-label": `${title} 트리` }
      });
      for (const node of nodes) tree.append(renderNode(node, sourceKind));
      section.append(tree);
      return section;
    }

    function render() {
      if (destroyed) return;
      if (panelHidden) {
        const reopen = element(documentRef, "button", {
          className: "nnt-reopen",
          text: "☷",
          attributes: {
            type: "button",
            title: "페이지 탐색 열기",
            "aria-label": "페이지 탐색 열기"
          }
        });
        reopen.addEventListener("click", () => {
          panelHidden = false;
          render();
        });
        mount.replaceChildren(reopen);
        return;
      }

      const panel = element(documentRef, "aside", {
        className: "nnt-panel",
        attributes: { "aria-label": "Notion 페이지 탐색" }
      });
      const header = element(documentRef, "header", { className: "nnt-header" });
      const heading = element(documentRef, "div", { className: "nnt-heading" });
      heading.append(
        element(documentRef, "div", { className: "nnt-title", text: "페이지 탐색" }),
        element(documentRef, "div", {
          className: "nnt-badge",
          text: "현재 Notion 사이드바에 렌더된 트리"
        })
      );
      const close = element(documentRef, "button", {
        className: "nnt-icon-button",
        text: "×",
        attributes: { type: "button", title: "패널 접기", "aria-label": "페이지 탐색 접기" }
      });
      close.addEventListener("click", () => {
        panelHidden = true;
        render();
      });
      header.append(heading, close);

      const content = element(documentRef, "div", { className: "nnt-content" });
      if (currentStatus) {
        content.append(
          element(documentRef, "div", {
            className: "nnt-status",
            text: currentStatus,
            attributes: { role: "status" }
          })
        );
      }
      content.append(
        renderSection("개인 페이지", currentTrees.personal || [], "private"),
        renderSection("팀스페이스", currentTrees.teamspaces || [], "teamspace")
      );
      panel.append(header, content);
      mount.replaceChildren(panel);

      const active = mount.querySelector(".nnt-item-active");
      if (active && typeof active.scrollIntoView === "function") {
        const reveal = () => active.scrollIntoView({ block: "nearest" });
        if (typeof globalScope.requestAnimationFrame === "function") {
          globalScope.requestAnimationFrame(reveal);
        } else {
          reveal();
        }
      }
    }

    function update(next = {}) {
      if (Object.prototype.hasOwnProperty.call(next, "trees")) {
        currentTrees = next.trees || { personal: [], teamspaces: [] };
      }
      if (Object.prototype.hasOwnProperty.call(next, "activePageId")) {
        currentActivePageId = next.activePageId || null;
      }
      if (Object.prototype.hasOwnProperty.call(next, "status")) {
        currentStatus = next.status || null;
      }
      render();
    }

    function destroy() {
      destroyed = true;
      shadowRoot.replaceChildren();
      host.remove();
    }

    render();
    return { update, destroy, get shadowRoot() { return shadowRoot; } };
  }

  namespace.navigationView = Object.freeze({ createNavigationPanel });
  globalScope.NotionFavoriteSections = namespace;
})(globalThis);
