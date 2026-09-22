(function initializeNotionSidebarAdapter(root) {
  "use strict";

  const NOTION_ORIGIN = "https://app.notion.com";
  const HOST_ATTRIBUTE = "data-notion-favorite-sections-host";
  const HIDDEN_ROW_ATTRIBUTE = "data-notion-favorite-sections-native-hidden";
  const PRIMARY_NAV_HOST_ATTRIBUTE = "data-notion-tree-primary-navigation-host";
  const PRIMARY_NAV_VIEW_HOST_ATTRIBUTE =
    "data-notion-tree-primary-navigation-view-host";
  const PAGE_ID_SOURCE =
    "(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
  const PAGE_ID_EXACT = new RegExp(`^${PAGE_ID_SOURCE}$`, "i");
  const PAGE_ID_SUFFIX = new RegExp(`(?:^|[-_])(${PAGE_ID_SOURCE})$`, "i");
  const SINGLE_EMOJI = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)$/u;
  const FAVORITES_HEADING = /^(?:favorites?|favourites?|즐겨찾기)(?:\s*(?:\(\d+\)|\d+))?$/iu;
  const PRIVATE_HEADING = /^(?:private(?:\s+pages?)?|personal(?:\s+pages?)?|my\s+private\s+pages?|개인(?:\s*페이지)?|비공개(?:\s*페이지)?|나의\s*페이지)(?:\s*(?:\(\d+\)|\d+))?$/iu;
  const TEAMSPACE_HEADING = /^(?:team\s*spaces?|팀\s*스페이스)(?:\s*(?:\(\d+\)|\d+))?$/iu;
  const RESERVED_PATH_SEGMENTS = new Set([
    "api",
    "calendar",
    "desktop",
    "download",
    "help",
    "home",
    "inbox",
    "integrations",
    "login",
    "logout",
    "marketplace",
    "onboarding",
    "p",
    "pricing",
    "product",
    "search",
    "settings",
    "signup",
    "templates",
  ]);

  const sectionRecords = new WeakMap();
  const liveRecords = new Set();
  const sectionInspections = new WeakMap();
  const primaryNavigationInspections = new WeakMap();
  const primaryNavigationInspectionObjects = new WeakSet();
  const primaryNavigationHosts = new Set();
  const primaryNavigationViewHosts = new Set();

  function normalizePageId(value) {
    if (typeof value !== "string") return null;

    const candidate = value.trim();
    if (!PAGE_ID_EXACT.test(candidate)) return null;
    return candidate.replaceAll("-", "").toLowerCase();
  }

  function toUrl(value, base) {
    if (value instanceof URL) return value;

    const raw = typeof value === "string" ? value.trim() : value?.href;
    if (!raw) return null;

    const baseValue =
      typeof base === "string"
        ? base
        : base?.href || (base?.origin ? `${base.origin}/` : NOTION_ORIGIN);

    try {
      return new URL(raw, baseValue || NOTION_ORIGIN);
    } catch {
      return null;
    }
  }

  function pageIdFromUrl(url) {
    if (
      !url ||
      url.protocol !== "https:" ||
      url.origin !== NOTION_ORIGIN ||
      url.username ||
      url.password
    ) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;

    let finalSegment;
    try {
      finalSegment = decodeURIComponent(segments.at(-1));
    } catch {
      return null;
    }

    if (!finalSegment || finalSegment.includes("/") || finalSegment.includes("\\")) {
      return null;
    }

    const match = finalSegment.match(PAGE_ID_SUFFIX);
    return match ? normalizePageId(match[1]) : null;
  }

  function extractPageId(href, base) {
    return pageIdFromUrl(toUrl(href, base));
  }

  function isAllowedNotionUrl(href, base) {
    return extractPageId(href, base) !== null;
  }

  function normalizeTitle(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      // ZWJ is meaningful inside authored emoji such as 👩🏽‍💻.
      .replace(/[\u200B\u200C\u2060\uFEFF]/gu, "")
      .replace(/[\s\u00A0]+/gu, " ")
      .trim();
  }

  function normalizeEmojiIcon(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return SINGLE_EMOJI.test(text) ? text : null;
  }

  function safeAbsoluteNotionUrl(href, base) {
    const url = toUrl(href, base);
    return pageIdFromUrl(url) ? url.href : null;
  }

  function normalizeFavorite(candidate) {
    if (!candidate || typeof candidate !== "object") return null;

    const candidateUrl = candidate.url || candidate.href || null;
    const pageId =
      normalizePageId(candidate.pageId) ||
      (candidateUrl ? extractPageId(candidateUrl, candidate.base) : null);
    if (!pageId) return null;

    const safeUrl = candidateUrl
      ? safeAbsoluteNotionUrl(candidateUrl, candidate.base)
      : null;

    return {
      pageId,
      title: normalizeTitle(candidate.title),
      url: safeUrl,
      href: safeUrl,
      icon:
        typeof candidate.icon === "string" && candidate.icon.trim()
          ? candidate.icon.trim()
          : null,
    };
  }

  function dedupeFavorites(favorites) {
    if (!Array.isArray(favorites)) return [];

    const byPageId = new Map();
    for (const candidate of favorites) {
      const favorite = normalizeFavorite(candidate);
      if (!favorite) continue;

      const existing = byPageId.get(favorite.pageId);
      if (!existing) {
        byPageId.set(favorite.pageId, favorite);
        continue;
      }

      if (!existing.title && favorite.title) existing.title = favorite.title;
      if (!existing.url && favorite.url) {
        existing.url = favorite.url;
        existing.href = favorite.href;
      }
      if (!existing.icon && favorite.icon) existing.icon = favorite.icon;
    }

    return [...byPageId.values()];
  }

  function queryAll(rootNode, selector) {
    if (!rootNode || typeof rootNode.querySelectorAll !== "function") return [];
    try {
      return Array.from(rootNode.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function getAttribute(node, name) {
    if (!node || typeof node.getAttribute !== "function") return null;
    try {
      return node.getAttribute(name);
    } catch {
      return null;
    }
  }

  function hasAttribute(node, name) {
    if (!node || typeof node.hasAttribute !== "function") return false;
    try {
      return node.hasAttribute(name);
    } catch {
      return false;
    }
  }

  function nodeContains(container, node) {
    if (!container || !node || typeof container.contains !== "function") return false;
    try {
      return container.contains(node);
    } catch {
      return false;
    }
  }

  function headingLabel(value) {
    return normalizeTitle(value).replace(/[：:]$/u, "").trim();
  }

  function isFavoritesHeadingLabel(value) {
    return FAVORITES_HEADING.test(headingLabel(value));
  }

  function nodeHref(node) {
    return getAttribute(node, "href") || (typeof node?.href === "string" ? node.href : null);
  }

  function baseForNode(node) {
    return node?.ownerDocument?.location?.href || root.location?.href || NOTION_ORIGIN;
  }

  function isInsideExtensionHost(node, boundary) {
    let current = node;
    while (current && current !== boundary) {
      if (
        hasAttribute(current, HOST_ATTRIBUTE) ||
        hasAttribute(current, PRIMARY_NAV_HOST_ATTRIBUTE) ||
        hasAttribute(current, PRIMARY_NAV_VIEW_HOST_ATTRIBUTE)
      ) return true;
      current = current.parentElement;
    }
    return false;
  }

  function isInsideNotionPageLink(node) {
    let current = node;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const href = nodeHref(current);
      if (href && extractPageId(href, baseForNode(current))) return true;
      current = current.parentElement;
    }
    return false;
  }

  function headingSignal(node) {
    if (!node || isInsideExtensionHost(node) || isInsideNotionPageLink(node)) return 0;

    const text = node.textContent;
    const ariaLabel = getAttribute(node, "aria-label");
    const title = getAttribute(node, "title");
    const testId = normalizeTitle(getAttribute(node, "data-testid")).toLowerCase();
    let score = 0;

    if (isFavoritesHeadingLabel(text)) score = Math.max(score, 6);
    if (isFavoritesHeadingLabel(ariaLabel)) score = Math.max(score, 6);
    if (isFavoritesHeadingLabel(title)) score = Math.max(score, 5);
    if (/favou?rites?/u.test(testId)) score = Math.max(score, 3);

    const role = normalizeTitle(getAttribute(node, "role")).toLowerCase();
    const tagName = normalizeTitle(node.tagName).toLowerCase();
    if (score > 0 && (role === "heading" || /^h[1-6]$/u.test(tagName))) score += 2;
    if (score > 0 && hasAttribute(node, "aria-expanded")) score += 1;

    return score;
  }

  function candidateSearchRoots(documentLike) {
    const roots = [];
    const add = (node) => {
      if (node && !roots.includes(node)) roots.push(node);
    };

    for (const node of queryAll(
      documentLike,
      "nav, aside, [role=\"navigation\"], [data-testid], [aria-label]",
    )) {
      const testId = normalizeTitle(getAttribute(node, "data-testid")).toLowerCase();
      const ariaLabel = normalizeTitle(getAttribute(node, "aria-label")).toLowerCase();
      const tagName = normalizeTitle(node.tagName).toLowerCase();
      const role = normalizeTitle(getAttribute(node, "role")).toLowerCase();
      if (
        tagName === "nav" ||
        tagName === "aside" ||
        role === "navigation" ||
        testId.includes("sidebar") ||
        ariaLabel.includes("sidebar") ||
        ariaLabel.includes("사이드바")
      ) {
        add(node);
      }
    }

    if (roots.length === 0) {
      return [{ node: documentLike, inSidebar: false }];
    }

    const depth = (node) => {
      let value = 0;
      let current = node;
      while (current?.parentElement) {
        value += 1;
        current = current.parentElement;
      }
      return value;
    };

    // Search the most specific semantic sidebar root first. A heading found there must
    // not later expand its candidate container into the page body.
    return roots
      .sort((left, right) => depth(right) - depth(left))
      .map((node) => ({ node, inSidebar: true }));
  }

  function primaryNavigationFailure(reason, confidence = 0) {
    return Object.freeze({
      scopeSafe: false,
      container: null,
      inboxItem: null,
      inboxWrapper: null,
      sidebarRoot: null,
      selectedNativeTab: null,
      nativeTabpanel: null,
      contentSurface: null,
      confidence: Math.max(0, Math.min(0.49, confidence)),
      reason,
    });
  }

  function nodeTagName(node) {
    return normalizeTitle(node?.tagName).toLowerCase();
  }

  function nodeRole(node) {
    return normalizeTitle(getAttribute(node, "role")).toLowerCase();
  }

  function directElementChildren(node) {
    if (!node?.children) return [];
    try {
      return Array.from(node.children);
    } catch {
      return [];
    }
  }

  function displayMode(node) {
    const inlineDisplay = normalizeTitle(node?.style?.display).toLowerCase();
    if (inlineDisplay) return inlineDisplay;

    const styleText = getAttribute(node, "style");
    if (typeof styleText === "string") {
      const match = styleText.match(/(?:^|;)\s*display\s*:\s*([^;!]+)(?:\s*!important)?/iu);
      if (match) return normalizeTitle(match[1]).toLowerCase();
    }

    const view = node?.ownerDocument?.defaultView;
    if (view && typeof view.getComputedStyle === "function") {
      try {
        return normalizeTitle(view.getComputedStyle(node).display).toLowerCase();
      } catch {
        return "";
      }
    }
    return "";
  }

  function isInboxTab(node) {
    const label = headingLabel(getAttribute(node, "aria-label"));
    return (
      nodeTagName(node) === "div" &&
      nodeRole(node) === "tab" &&
      /^(?:inbox|수신함)$/iu.test(label)
    );
  }

  function isPrimaryTablist(node) {
    const label = headingLabel(getAttribute(node, "aria-label"));
    return (
      nodeTagName(node) === "div" &&
      nodeRole(node) === "tablist" &&
      /^(?:sidebar navigation|사이드바(?: navigation| 탐색| 내비게이션))$/iu.test(label)
    );
  }

  function semanticSidebarNavAncestor(node) {
    let current = node?.parentElement || null;
    for (let depth = 0; current && depth < 12; depth += 1) {
      const label = headingLabel(getAttribute(current, "aria-label"));
      if (
        nodeTagName(current) === "nav" &&
        /^(?:notion sidebar|sidebar|사이드바)$/iu.test(label)
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function tabsWithinDirectWrapper(wrapper) {
    return [wrapper, ...queryAll(wrapper, "[role]")].filter(
      (node) => nodeRole(node) === "tab" && !hasAttribute(node, PRIMARY_NAV_HOST_ATTRIBUTE),
    );
  }

  function layoutMode(node, cssName, propertyName) {
    const inlineValue = normalizeTitle(node?.style?.[propertyName]).toLowerCase();
    if (inlineValue) return inlineValue;

    const styleText = getAttribute(node, "style");
    if (typeof styleText === "string") {
      const escapedName = cssName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const match = styleText.match(
        new RegExp(
          `(?:^|;)\\s*${escapedName}\\s*:\\s*([^;!]+)(?:\\s*!important)?`,
          "iu",
        ),
      );
      if (match) return normalizeTitle(match[1]).toLowerCase();
    }

    const view = node?.ownerDocument?.defaultView;
    if (view && typeof view.getComputedStyle === "function") {
      try {
        const computed = view.getComputedStyle(node);
        return normalizeTitle(
          computed?.[propertyName] || computed?.getPropertyValue?.(cssName),
        ).toLowerCase();
      } catch {
        return "";
      }
    }
    return "";
  }

  function safeAriaId(value) {
    if (typeof value !== "string" || value !== value.trim()) return null;
    return /^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/u.test(value) ? value : null;
  }

  function inspectPrimaryContentSurface(container, sidebarRoot) {
    const nativeTabs = directElementChildren(container)
      .filter((child) => !hasAttribute(child, PRIMARY_NAV_HOST_ATTRIBUTE))
      .flatMap((wrapper) => tabsWithinDirectWrapper(wrapper));
    const selectedTabs = nativeTabs.filter(
      (tab) => normalizeTitle(getAttribute(tab, "aria-selected")).toLowerCase() === "true",
    );
    if (selectedTabs.length !== 1) {
      return { safe: false, reason: "ambiguous-selected-native-tab" };
    }

    const selectedNativeTab = selectedTabs[0];
    const tabId = safeAriaId(getAttribute(selectedNativeTab, "id"));
    const controlledId = safeAriaId(getAttribute(selectedNativeTab, "aria-controls"));
    if (!tabId || !controlledId) {
      return { safe: false, reason: "invalid-native-tab-control" };
    }

    const documentLike = selectedNativeTab.ownerDocument;
    const controlledPanels = queryAll(documentLike, "[id]").filter(
      (node) => getAttribute(node, "id") === controlledId,
    );
    if (controlledPanels.length !== 1) {
      return { safe: false, reason: "native-tabpanel-not-found" };
    }

    const nativeTabpanel = controlledPanels[0];
    if (
      nodeTagName(nativeTabpanel) !== "div" ||
      nodeRole(nativeTabpanel) !== "tabpanel" ||
      getAttribute(nativeTabpanel, "aria-labelledby") !== tabId ||
      !nodeContains(sidebarRoot, nativeTabpanel) ||
      nodeContains(container, nativeTabpanel) ||
      !isRenderedNode(nativeTabpanel, sidebarRoot)
    ) {
      return { safe: false, reason: "invalid-native-tabpanel" };
    }

    const contentSurface = nativeTabpanel.parentElement || null;
    const directNativePanels = directElementChildren(contentSurface).filter(
      (node) =>
        nodeRole(node) === "tabpanel" &&
        !hasAttribute(node, PRIMARY_NAV_VIEW_HOST_ATTRIBUTE),
    );
    if (
      nodeTagName(contentSurface) !== "div" ||
      !nodeContains(sidebarRoot, contentSurface) ||
      directNativePanels.length !== 1 ||
      directNativePanels[0] !== nativeTabpanel ||
      displayMode(contentSurface) !== "flex" ||
      layoutMode(contentSurface, "flex-direction", "flexDirection") !== "column" ||
      layoutMode(contentSurface, "position", "position") !== "relative"
    ) {
      return { safe: false, reason: "invalid-primary-content-surface" };
    }

    return {
      safe: true,
      selectedNativeTab,
      nativeTabpanel,
      contentSurface,
    };
  }

  function inspectInboxTabCandidate(inboxItem) {
    const innerWrapper = inboxItem?.parentElement || null;
    const inboxWrapper = innerWrapper?.parentElement || null;
    const container = inboxWrapper?.parentElement || null;
    if (
      nodeTagName(innerWrapper) !== "div" ||
      nodeTagName(inboxWrapper) !== "div" ||
      displayMode(innerWrapper) !== "contents" ||
      displayMode(inboxWrapper) !== "contents" ||
      !isPrimaryTablist(container) ||
      displayMode(container) !== "flex"
    ) {
      return primaryNavigationFailure("invalid-inbox-containment", 0.35);
    }

    const sidebarRoot = semanticSidebarNavAncestor(container);
    if (!sidebarRoot || !nodeContains(sidebarRoot, inboxItem)) {
      return primaryNavigationFailure("sidebar-navigation-not-found", 0.35);
    }
    if (!isRenderedNode(inboxItem, sidebarRoot)) {
      return primaryNavigationFailure("inbox-tab-not-rendered", 0.3);
    }

    const nativeWrappers = directElementChildren(container).filter(
      (child) => !hasAttribute(child, PRIMARY_NAV_HOST_ATTRIBUTE),
    );
    if (
      nativeWrappers.length < 2 ||
      nativeWrappers.at(-1) !== inboxWrapper ||
      nativeWrappers.some(
        (wrapper) =>
          nodeTagName(wrapper) !== "div" ||
          displayMode(wrapper) !== "contents" ||
          tabsWithinDirectWrapper(wrapper).length !== 1,
      )
    ) {
      return primaryNavigationFailure("ambiguous-primary-navigation-siblings", 0.4);
    }

    const contentInspection = inspectPrimaryContentSurface(container, sidebarRoot);
    if (!contentInspection.safe) {
      return primaryNavigationFailure(contentInspection.reason, 0.45);
    }

    const inspection = Object.freeze({
      scopeSafe: true,
      container,
      inboxItem,
      inboxWrapper,
      sidebarRoot,
      selectedNativeTab: contentInspection.selectedNativeTab,
      nativeTabpanel: contentInspection.nativeTabpanel,
      contentSurface: contentInspection.contentSurface,
      confidence: 0.98,
      reason: "primary-navigation-safe",
    });
    primaryNavigationInspections.set(container, inspection);
    primaryNavigationInspectionObjects.add(inspection);
    return inspection;
  }

  function inspectPrimaryNavigation(documentLike) {
    if (!documentLike || typeof documentLike.querySelectorAll !== "function") {
      return primaryNavigationFailure("unusable-document");
    }

    const candidates = queryAll(documentLike, "[aria-label]").filter(isInboxTab);
    if (candidates.length === 0) {
      return primaryNavigationFailure("inbox-tab-not-found");
    }

    const valid = [];
    let closestFailure = null;
    for (const candidate of candidates) {
      const inspection = inspectInboxTabCandidate(candidate);
      if (inspection.scopeSafe) valid.push(inspection);
      else if (!closestFailure || inspection.confidence > closestFailure.confidence) {
        closestFailure = inspection;
      }
    }
    if (valid.length !== 1) {
      for (const inspection of valid) {
        primaryNavigationInspections.delete(inspection.container);
      }
      return valid.length > 1
        ? primaryNavigationFailure("ambiguous-inbox-tabs", 0.49)
        : closestFailure || primaryNavigationFailure("primary-navigation-not-found");
    }
    return valid[0];
  }

  function currentPrimaryNavigationInspection(inspectionOrContainer) {
    const suppliedAsInspection = inspectionOrContainer?.scopeSafe === true;
    if (
      suppliedAsInspection &&
      !primaryNavigationInspectionObjects.has(inspectionOrContainer)
    ) {
      return null;
    }
    const suppliedInspection = suppliedAsInspection
      ? inspectionOrContainer
      : primaryNavigationInspections.get(inspectionOrContainer);
    if (!suppliedInspection?.scopeSafe) return null;

    const recorded = primaryNavigationInspections.get(suppliedInspection.container);
    if (
      !recorded ||
      recorded.inboxItem !== suppliedInspection.inboxItem ||
      recorded.inboxWrapper !== suppliedInspection.inboxWrapper ||
      recorded.sidebarRoot !== suppliedInspection.sidebarRoot ||
      recorded.inboxItem?.parentElement?.parentElement !== recorded.inboxWrapper ||
      recorded.inboxWrapper?.parentElement !== recorded.container ||
      recorded.nativeTabpanel?.parentElement !== recorded.contentSurface ||
      !nodeContains(recorded.sidebarRoot, recorded.container)
    ) {
      return null;
    }

    // Notion may replace or rearrange React-owned siblings between inspection and
    // mount. Re-run every structural gate immediately before inserting our host.
    const refreshed = inspectInboxTabCandidate(recorded.inboxItem);
    if (
      !refreshed.scopeSafe ||
      refreshed.container !== recorded.container ||
      refreshed.inboxWrapper !== recorded.inboxWrapper ||
      refreshed.sidebarRoot !== recorded.sidebarRoot ||
      refreshed.selectedNativeTab !== recorded.selectedNativeTab ||
      refreshed.nativeTabpanel !== recorded.nativeTabpanel ||
      refreshed.contentSurface !== recorded.contentSurface
    ) {
      return null;
    }
    return refreshed;
  }

  function setPrimaryHostDisplay(host) {
    try {
      if (host.style) {
        host.style.display = "contents";
        return true;
      }
      const currentStyle = getAttribute(host, "style");
      host.setAttribute(
        "style",
        currentStyle
          ? `${currentStyle.replace(/;?\s*$/u, ";")} display: contents;`
          : "display: contents;",
      );
      return true;
    } catch {
      return false;
    }
  }

  function mountPrimaryNavigationHost(inspectionOrContainer, host) {
    const inspection = currentPrimaryNavigationInspection(inspectionOrContainer);
    if (
      !inspection ||
      !host ||
      typeof host.setAttribute !== "function" ||
      typeof inspection.container.insertBefore !== "function"
    ) {
      return null;
    }

    for (const existing of queryAll(
      inspection.container,
      `[${PRIMARY_NAV_HOST_ATTRIBUTE}]`,
    )) {
      if (existing === host) continue;
      primaryNavigationHosts.delete(existing);
      if (typeof existing.removeAttribute === "function") {
        existing.removeAttribute(PRIMARY_NAV_HOST_ATTRIBUTE);
      }
      removeNode(existing);
    }

    host.setAttribute(PRIMARY_NAV_HOST_ATTRIBUTE, "");
    if (!setPrimaryHostDisplay(host)) {
      host.removeAttribute(PRIMARY_NAV_HOST_ATTRIBUTE);
      return null;
    }

    const reference = inspection.inboxWrapper.nextSibling || null;
    if (!(host.parentElement === inspection.container && reference === host)) {
      inspection.container.insertBefore(host, reference);
    }
    primaryNavigationHosts.add(host);
    return host;
  }

  function restorePrimaryNavigation(host) {
    if (host) {
      if (
        !primaryNavigationHosts.has(host) &&
        !hasAttribute(host, PRIMARY_NAV_HOST_ATTRIBUTE)
      ) {
        return false;
      }
      primaryNavigationHosts.delete(host);
      if (typeof host.removeAttribute === "function") {
        host.removeAttribute(PRIMARY_NAV_HOST_ATTRIBUTE);
      }
      removeNode(host);
      return true;
    }

    let changed = false;
    for (const mountedHost of [...primaryNavigationHosts]) {
      changed = restorePrimaryNavigation(mountedHost) || changed;
    }
    return changed;
  }

  function mountPrimaryNavigationViewHost(inspectionOrContainer, host) {
    const inspection = currentPrimaryNavigationInspection(inspectionOrContainer);
    if (
      !inspection ||
      !host ||
      typeof host.setAttribute !== "function" ||
      typeof inspection.contentSurface.appendChild !== "function"
    ) {
      return null;
    }

    for (const existing of queryAll(
      inspection.contentSurface,
      `[${PRIMARY_NAV_VIEW_HOST_ATTRIBUTE}]`,
    )) {
      if (existing === host) continue;
      primaryNavigationViewHosts.delete(existing);
      if (typeof existing.removeAttribute === "function") {
        existing.removeAttribute(PRIMARY_NAV_VIEW_HOST_ATTRIBUTE);
      }
      removeNode(existing);
    }

    host.setAttribute(PRIMARY_NAV_VIEW_HOST_ATTRIBUTE, "");
    if (host.parentElement !== inspection.contentSurface) {
      inspection.contentSurface.appendChild(host);
    }
    primaryNavigationViewHosts.add(host);
    return host;
  }

  function restorePrimaryNavigationView(host) {
    if (host) {
      if (
        !primaryNavigationViewHosts.has(host) &&
        !hasAttribute(host, PRIMARY_NAV_VIEW_HOST_ATTRIBUTE)
      ) {
        return false;
      }
      primaryNavigationViewHosts.delete(host);
      if (typeof host.removeAttribute === "function") {
        host.removeAttribute(PRIMARY_NAV_VIEW_HOST_ATTRIBUTE);
      }
      removeNode(host);
      return true;
    }

    let changed = false;
    for (const mountedHost of [...primaryNavigationViewHosts]) {
      changed = restorePrimaryNavigationView(mountedHost) || changed;
    }
    return changed;
  }

  function findHeadingCandidates(documentLike) {
    const candidates = [];
    const seen = new Set();
    const selectors = [
      "h1, h2, h3, h4, h5, h6, [role=\"heading\"], button, [aria-label], [data-testid]",
      "div, span",
    ];

    for (const rootDescriptor of candidateSearchRoots(documentLike)) {
      const searchRoot = rootDescriptor.node;
      for (const selector of selectors) {
        for (const node of queryAll(searchRoot, selector)) {
          if (seen.has(node)) continue;
          seen.add(node);
          const signal = headingSignal(node);
          if (signal > 0) {
            candidates.push({
              node,
              signal,
              searchRoot,
              inSidebar: rootDescriptor.inSidebar,
            });
          }
        }
      }
    }

    return candidates;
  }

  function parsedNativeAnchors(container) {
    const result = [];
    const base = baseForNode(container);
    for (const anchor of queryAll(container, "a[href]")) {
      if (isInsideExtensionHost(anchor, container)) continue;
      const href = nodeHref(anchor);
      const pageId = extractPageId(href, base);
      if (pageId) result.push({ anchor, href, pageId });
    }
    return result;
  }

  function semanticContainerBonus(node) {
    const role = normalizeTitle(getAttribute(node, "role")).toLowerCase();
    const tagName = normalizeTitle(node?.tagName).toLowerCase();
    if (["group", "list", "region", "tree"].includes(role)) return 1.5;
    if (["aside", "nav", "section"].includes(tagName)) return 1;
    return 0;
  }

  function inspectCandidate(candidate, documentLike) {
    let best = null;
    let ancestor = candidate.node?.parentElement || null;

    for (
      let distance = 1;
      ancestor &&
      distance <= 8 &&
      (ancestor === candidate.searchRoot || nodeContains(candidate.searchRoot, ancestor));
      distance += 1
    ) {
      const parsedLinks = parsedNativeAnchors(ancestor);
      const uniqueIds = new Set(parsedLinks.map((entry) => entry.pageId));
      const allLinkCount = queryAll(ancestor, "a[href]").length;
      const extraLinkCount = Math.max(0, allLinkCount - parsedLinks.length);
      const labelSignal = Math.max(
        isFavoritesHeadingLabel(getAttribute(ancestor, "aria-label")) ? 2 : 0,
        isFavoritesHeadingLabel(getAttribute(ancestor, "title")) ? 1 : 0,
      );

      let score = candidate.signal - distance * 0.6 + labelSignal;
      if (uniqueIds.size > 0) score += 3 + Math.min(4, uniqueIds.size) * 0.75;
      score += semanticContainerBonus(ancestor);
      if (extraLinkCount > uniqueIds.size * 3 + 6) score -= 2.5;
      if (ancestor === documentLike?.body || ancestor === documentLike?.documentElement) score -= 4;

      const inspected = {
        section: ancestor,
        heading: candidate.node,
        headingSignal: candidate.signal,
        inSidebar: candidate.inSidebar,
        score,
        favoriteCount: uniqueIds.size,
        confidence: Math.max(0, Math.min(1, score / 12)),
      };

      if (!best || inspected.score > best.score) best = inspected;

      // The nearest compact ancestor with page links is preferable to a broad app shell.
      if (uniqueIds.size > 0 && extraLinkCount <= uniqueIds.size + 3 && score >= 8) break;
      ancestor = ancestor.parentElement;
    }

    return best;
  }

  function positiveAriaLevel(node, section) {
    let current = node;
    while (current && current !== section) {
      const rawLevel = getAttribute(current, "aria-level");
      if (rawLevel !== null) {
        const level = Number(rawLevel);
        return Number.isInteger(level) && level > 0 ? level : null;
      }
      current = current.parentElement;
    }
    return null;
  }

  function semanticRowForAnchor(anchor, section) {
    let current = anchor;
    while (current && current !== section) {
      const role = normalizeTitle(getAttribute(current, "role")).toLowerCase();
      const tagName = normalizeTitle(current.tagName).toLowerCase();
      if (role === "treeitem" || role === "listitem" || tagName === "li") {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function isRecognizedCollection(node, section) {
    if (!node) return false;
    if (node === section) return true;
    const role = normalizeTitle(getAttribute(node, "role")).toLowerCase();
    const tagName = normalizeTitle(node.tagName).toLowerCase();
    return (
      role === "group" ||
      role === "list" ||
      role === "tree" ||
      tagName === "ol" ||
      tagName === "ul"
    );
  }

  function nearestCollection(row, section) {
    let current = row?.parentElement || null;
    while (current) {
      if (isRecognizedCollection(current, section)) return current;
      if (current === section) break;
      current = current.parentElement;
    }
    return null;
  }

  function groupedNativeLinks(section) {
    const links = parsedNativeAnchors(section);
    const byPageId = new Map();
    for (const link of links) {
      const group = byPageId.get(link.pageId) || [];
      group.push(link);
      byPageId.set(link.pageId, group);
    }
    return { links, byPageId };
  }

  function classificationResult(overrides = {}) {
    return {
      safe: false,
      replaceSafe: false,
      hierarchyDetected: false,
      pageIds: new Set(),
      rawPageIds: new Set(),
      reason: "ambiguous-structure",
      ...overrides,
    };
  }

  function classifyNativeFavorites(section, heading) {
    const { links, byPageId } = groupedNativeLinks(section);
    const rawPageIds = new Set(byPageId.keys());
    if (
      (heading && !isRenderedNode(heading, section)) ||
      links.some(({ anchor }) => !isRenderedNode(anchor, section))
    ) {
      return classificationResult({ rawPageIds, reason: "collapsed-or-hidden" });
    }
    // Notion can leave mounted rows beneath a collapsed disclosure. Their
    // presence must not make a hidden, incomplete source authoritative.
    let disclosure = heading;
    while (disclosure) {
      if (
        getAttribute(disclosure, "aria-expanded") === "false" ||
        getAttribute(disclosure, "aria-hidden") === "true" ||
        getAttribute(disclosure, "hidden") !== null
      ) {
        return classificationResult({ rawPageIds, reason: "collapsed-or-hidden" });
      }
      if (disclosure === section) break;
      disclosure = disclosure.parentElement;
    }
    if (rawPageIds.size === 0) {
      return classificationResult({
        pageIds: new Set(),
        rawPageIds,
        // An empty heading alone cannot distinguish zero Favorites from an
        // unmounted, loading, collapsed, or virtualized Favorites collection.
        reason: "empty-or-unmounted",
      });
    }

    const representativeLinks = [...byPageId.entries()].map(([pageId, entries]) => ({
      pageId,
      anchor: entries[0].anchor,
      entries,
    }));

    const levels = new Map();
    let hasAnyLevel = false;
    let levelIsAmbiguous = false;
    for (const representative of representativeLinks) {
      const values = new Set(
        representative.entries
          .map((entry) => positiveAriaLevel(entry.anchor, section))
          .filter((value) => value !== null),
      );
      const entriesWithoutLevel = representative.entries.some(
        (entry) => positiveAriaLevel(entry.anchor, section) === null,
      );
      if (values.size > 0) hasAnyLevel = true;
      if (values.size > 1 || (values.size > 0 && entriesWithoutLevel)) {
        levelIsAmbiguous = true;
      }
      levels.set(representative.pageId, values.size === 1 ? [...values][0] : null);
    }

    if (hasAnyLevel) {
      if (levelIsAmbiguous || [...levels.values()].some((level) => level === null)) {
        return classificationResult({ rawPageIds, reason: "mixed-aria-levels" });
      }
      const minimumLevel = Math.min(...levels.values());
      const pageIds = new Set(
        [...levels.entries()]
          .filter(([, level]) => level === minimumLevel)
          .map(([pageId]) => pageId),
      );
      const hierarchyDetected = pageIds.size !== rawPageIds.size;
      return classificationResult({
        safe: true,
        // Expanded child rows are classified correctly, but hiding their whole native
        // subtree without moving React nodes is not structurally guaranteed.
        replaceSafe: !hierarchyDetected,
        hierarchyDetected,
        pageIds,
        rawPageIds,
        reason: hierarchyDetected ? "aria-hierarchy" : "flat-aria-level",
      });
    }

    const semanticRows = new Map();
    let hasEverySemanticRow = true;
    for (const representative of representativeLinks) {
      const rows = new Set(
        representative.entries
          .map((entry) => semanticRowForAnchor(entry.anchor, section))
          .filter(Boolean),
      );
      if (rows.size !== 1) {
        hasEverySemanticRow = false;
        break;
      }
      semanticRows.set(representative.pageId, [...rows][0]);
    }

    if (hasEverySemanticRow) {
      const pageIds = new Set();
      let hierarchyDetected = false;
      for (const [pageId, row] of semanticRows) {
        const isNested = [...semanticRows.entries()].some(
          ([otherPageId, otherRow]) =>
            otherPageId !== pageId && nodeContains(otherRow, row),
        );
        if (isNested) hierarchyDetected = true;
        else pageIds.add(pageId);
      }

      if (hierarchyDetected) {
        return classificationResult({
          safe: true,
          replaceSafe: false,
          hierarchyDetected: true,
          pageIds,
          rawPageIds,
          reason: "nested-semantic-rows",
        });
      }

      const collections = new Set(
        [...semanticRows.values()].map((row) => nearestCollection(row, section)),
      );
      if (collections.size === 1 && !collections.has(null)) {
        return classificationResult({
          safe: true,
          replaceSafe: true,
          pageIds: new Set(rawPageIds),
          rawPageIds,
          reason: "flat-semantic-rows",
        });
      }
      return classificationResult({ rawPageIds, reason: "split-semantic-collections" });
    }

    const structuralRows = new Map();
    for (const representative of representativeLinks) {
      const rows = new Set(
        representative.entries
          .map((entry) => sourceRowForAnchor(entry.anchor, representative.pageId, section, heading))
          .filter(Boolean),
      );
      if (rows.size !== 1) {
        return classificationResult({ rawPageIds, reason: "ambiguous-structural-row" });
      }
      structuralRows.set(representative.pageId, [...rows][0]);
    }

    const rows = [...structuralRows.values()];
    if (
      new Set(rows).size !== rows.length ||
      rows.some((row, index) =>
        rows.some(
          (otherRow, otherIndex) =>
            index !== otherIndex &&
            (nodeContains(row, otherRow) || nodeContains(otherRow, row)),
        ),
      )
    ) {
      return classificationResult({ rawPageIds, reason: "overlapping-structural-rows" });
    }

    const parents = new Set(rows.map((row) => row.parentElement));
    const commonParent = parents.size === 1 ? [...parents][0] : null;
    if (commonParent && isRecognizedCollection(commonParent, section)) {
      return classificationResult({
        safe: true,
        replaceSafe: true,
        pageIds: new Set(rawPageIds),
        rawPageIds,
        reason: "flat-structural-rows",
      });
    }

    return classificationResult({ rawPageIds, reason: "unrecognized-row-collection" });
  }

  function inspectFavoritesSection(documentLike) {
    if (!documentLike || typeof documentLike.querySelectorAll !== "function") return null;

    let best = null;
    for (const candidate of findHeadingCandidates(documentLike)) {
      const inspected = inspectCandidate(candidate, documentLike);
      if (!inspected) continue;
      if (!best || inspected.score > best.score) best = inspected;
    }

    // An exact heading with a close parent is enough for an empty Favorites section.
    if (!best || best.score < 5.25) return null;
    const classification = classifyNativeFavorites(best.section, best.heading);
    best.rawFavoriteCount = classification.rawPageIds.size;
    best.favoriteCount = classification.safe ? classification.pageIds.size : 0;
    best.topLevelSafe = classification.safe;
    best.scopeSafe = best.inSidebar;
    best.replaceSafe = classification.replaceSafe && best.scopeSafe;
    best.hierarchyDetected = classification.hierarchyDetected;
    best.classificationReason = classification.reason;
    best.emptySafe = Boolean(
      best.inSidebar &&
      classification.safe &&
      classification.rawPageIds.size === 0 &&
      best.headingSignal >= 6,
    );
    sectionInspections.set(best.section, best);
    return best;
  }

  function locateFavoritesSection(documentLike) {
    return inspectFavoritesSection(documentLike)?.section || null;
  }

  function isPageIconNode(node) {
    return ["img", "svg"].includes(nodeTagName(node)) ||
      nodeRole(node) === "img" ||
      String(getAttribute(node, "data-testid") || "").includes("page-icon");
  }

  function titleTextOutsideIcons(node) {
    if (!node || isPageIconNode(node)) return "";
    if (node.nodeType === 3) return node.textContent || "";
    if (node.childNodes) return Array.from(node.childNodes).map(titleTextOutsideIcons).join("");
    return node.textContent || "";
  }

  function readElementTitle(anchor) {
    const titleNodes = queryAll(
      anchor,
      "[data-testid*=\"page-title\"], [data-content-editable-leaf=\"true\"]",
    );
    for (const node of titleNodes) {
      const title = normalizeTitle(node.textContent);
      if (title) return title;
    }

    const labelledIds = String(getAttribute(anchor, "aria-labelledby") || "").trim().split(/\s+/u).filter(Boolean);
    for (const id of labelledIds) {
      const titleNode = anchor.ownerDocument?.getElementById?.(id);
      // The current Notion sidebar labels each link with a title div inside
      // that link. Do not import labels from unrelated app/page content.
      if (titleNode && titleNode !== anchor && nodeContains(anchor, titleNode)) {
        const title = normalizeTitle(titleTextOutsideIcons(titleNode));
        if (title) return title;
      }
    }

    // Exclude the icon's own DOM text instead of subtracting a matching title
    // prefix. A genuine page title is allowed to start with the same emoji.
    const visibleText = normalizeTitle(titleTextOutsideIcons(anchor));
    if (visibleText) return visibleText;

    for (const value of [getAttribute(anchor, "aria-label"), getAttribute(anchor, "title")]) {
      const title = normalizeTitle(value);
      if (title) return title;
    }

    return "Untitled";
  }

  function readElementIcon(anchor) {
    const image = queryAll(anchor, "img[src]")[0];
    if (image) {
      const source = image.currentSrc || getAttribute(image, "src");
      if (typeof source === "string" && source.trim()) return source.trim();
    }

    const roleImage = queryAll(anchor, "[role=\"img\"]")[0];
    if (roleImage) {
      const value = normalizeEmojiIcon(roleImage.textContent) ||
        normalizeEmojiIcon(getAttribute(roleImage, "aria-label"));
      if (value) return value;
    }

    const pageIcon = queryAll(anchor, "[data-testid*=\"page-icon\"]")[0];
    if (pageIcon) {
      const value = normalizeEmojiIcon(pageIcon.textContent);
      if (value) return value;
    }

    return null;
  }

  function isRenderedNode(node, boundary) {
    let current = node;
    while (current) {
      const ariaHidden = normalizeTitle(getAttribute(current, "aria-hidden")).toLowerCase();
      const style = normalizeTitle(getAttribute(current, "style")).toLowerCase();
      if (
        current.hidden === true ||
        hasAttribute(current, "hidden") ||
        hasAttribute(current, HIDDEN_ROW_ATTRIBUTE) ||
        hasAttribute(current, "inert") ||
        ariaHidden === "true" ||
        displayMode(current) === "none" ||
        /(?:^|;)\s*display\s*:\s*none\s*(?:!important)?\s*(?:;|$)/u.test(style) ||
        /(?:^|;)\s*visibility\s*:\s*hidden\s*(?:!important)?\s*(?:;|$)/u.test(style)
      ) {
        return false;
      }
      if (current === boundary) return true;
      current = current.parentElement;
    }
    return boundary ? false : true;
  }

  function navigationSourceFromLabel(value) {
    const label = headingLabel(value);
    if (PRIVATE_HEADING.test(label)) return { sourceKind: "private", label };
    if (TEAMSPACE_HEADING.test(label)) return { sourceKind: "teamspace", label };
    return null;
  }

  function navigationHeadingInfo(node) {
    if (!node || isInsideExtensionHost(node) || isInsideNotionPageLink(node)) return null;

    const labeledValues = [
      { value: node.textContent, score: 6 },
      { value: getAttribute(node, "aria-label"), score: 6 },
      { value: getAttribute(node, "title"), score: 5 },
    ];
    let best = null;
    for (const entry of labeledValues) {
      const source = navigationSourceFromLabel(entry.value);
      if (source && (!best || entry.score > best.signal)) {
        best = { ...source, signal: entry.score };
      }
    }

    const testId = normalizeTitle(getAttribute(node, "data-testid")).toLowerCase();
    let testIdKind = null;
    if (/(?:^|[-_:])(?:private|personal)(?:[-_:](?:pages?|section|header))?(?:$|[-_:])/u.test(testId)) {
      testIdKind = "private";
    }
    if (/(?:^|[-_:])teamspaces?(?:[-_:](?:pages?|section|header|list))?(?:$|[-_:])/u.test(testId)) {
      if (testIdKind) return null;
      testIdKind = "teamspace";
    }
    if (testIdKind && (!best || best.signal < 4)) {
      best = {
        sourceKind: testIdKind,
        label: testIdKind === "private" ? "Private" : "Teamspaces",
        signal: 4,
      };
    }

    if (!best) return null;
    const role = normalizeTitle(getAttribute(node, "role")).toLowerCase();
    const tagName = normalizeTitle(node.tagName).toLowerCase();
    if (role === "heading" || /^h[1-6]$/u.test(tagName)) best.signal += 2;
    if (hasAttribute(node, "aria-expanded")) best.signal += 0.5;
    return best;
  }

  function navigationHeadingCandidates(documentLike) {
    const candidates = [];
    const seenByRoot = new Map();
    const selector =
      "h1, h2, h3, h4, h5, h6, [role=\"heading\"], button, [aria-label], [title], [data-testid], div, span";

    for (const rootDescriptor of candidateSearchRoots(documentLike).filter(
      (descriptor) => descriptor.inSidebar,
    )) {
      const seen = seenByRoot.get(rootDescriptor.node) || new Set();
      seenByRoot.set(rootDescriptor.node, seen);
      for (const node of [rootDescriptor.node, ...queryAll(rootDescriptor.node, selector)]) {
        if (seen.has(node) || !isRenderedNode(node, rootDescriptor.node)) continue;
        seen.add(node);
        const info = navigationHeadingInfo(node);
        if (!info) continue;
        candidates.push({
          ...info,
          node,
          searchRoot: rootDescriptor.node,
          inSidebar: true,
        });
      }
    }
    return candidates;
  }

  function parsedRenderedAnchors(container) {
    return parsedNativeAnchors(container).filter(({ anchor }) =>
      isRenderedNode(anchor, container),
    );
  }

  function sameHeadingCluster(left, right) {
    return (
      left === right ||
      nodeContains(left, right) ||
      nodeContains(right, left)
    );
  }

  function hasConflictingNavigationHeading(container, candidate) {
    const selector =
      "h1, h2, h3, h4, h5, h6, [role=\"heading\"], button, [aria-label], [title], [data-testid], div, span";
    for (const node of [container, ...queryAll(container, selector)]) {
      if (
        !isRenderedNode(node, container) ||
        sameHeadingCluster(node, candidate.node)
      ) {
        continue;
      }
      const info = navigationHeadingInfo(node);
      if (info) return true;
      if (headingSignal(node) > 0) return true;
    }
    return false;
  }

  function inspectNavigationCandidate(candidate) {
    const ownLinks = parsedRenderedAnchors(candidate.node);
    let container = ownLinks.length > 0
      ? candidate.node
      : candidate.node?.parentElement || null;
    let distance = container === candidate.node ? 0 : 1;
    let best = null;

    while (
      container &&
      distance <= 8 &&
      (container === candidate.searchRoot || nodeContains(candidate.searchRoot, container))
    ) {
      if (!isRenderedNode(container, candidate.searchRoot)) break;
      if (hasConflictingNavigationHeading(container, candidate)) break;

      const links = parsedRenderedAnchors(container);
      const pageIds = new Set(links.map((entry) => entry.pageId));
      const visibleLinkCount = queryAll(container, "a[href]").filter((anchor) =>
        isRenderedNode(anchor, container),
      ).length;
      const extraLinkCount = Math.max(0, visibleLinkCount - links.length);
      let score = candidate.signal - distance * 0.55;
      if (pageIds.size > 0) score += 3 + Math.min(4, pageIds.size) * 0.5;
      score += semanticContainerBonus(container);
      if (container === candidate.searchRoot) score -= 1.5;
      if (extraLinkCount > pageIds.size * 2 + 4) score -= 3;

      const minimumScore = pageIds.size > 0 ? 7 : 5.25;
      if (score >= minimumScore) {
        const inspected = {
          section: container,
          heading: candidate.node,
          label: candidate.label,
          sourceKind: candidate.sourceKind,
          headingSignal: candidate.signal,
          inSidebar: true,
          scopeSafe: true,
          score,
          confidence: Math.max(0, Math.min(1, score / 12)),
          renderedPageCount: pageIds.size,
          expanded:
            getAttribute(candidate.node, "aria-expanded") === null
              ? null
              : getAttribute(candidate.node, "aria-expanded") !== "false",
        };
        if (!best || inspected.score > best.score) best = inspected;
      }

      if (pageIds.size > 0 && extraLinkCount <= pageIds.size + 3 && score >= 9) break;
      if (container === candidate.searchRoot) break;
      container = container.parentElement;
      distance += 1;
    }

    return best;
  }

  function navigationNodeForRepresentative(representative, sourceKind) {
    const { anchor, href, pageId } = representative.entries[0];
    const url = safeAbsoluteNotionUrl(href, baseForNode(anchor));
    return {
      id: pageId,
      pageId,
      title: readElementTitle(anchor),
      href: url,
      url,
      icon: readElementIcon(anchor),
      sourceKind,
      children: [],
    };
  }

  function navigationRepresentatives(section, sourceKind) {
    const byPageId = new Map();
    for (const entry of parsedRenderedAnchors(section)) {
      const existing = byPageId.get(entry.pageId) || [];
      existing.push(entry);
      byPageId.set(entry.pageId, existing);
    }
    return [...byPageId.entries()].map(([pageId, entries]) => ({
      pageId,
      entries,
      anchor: entries[0].anchor,
      node: navigationNodeForRepresentative({ pageId, entries }, sourceKind),
    }));
  }

  function navigationSourceRowForAnchor(anchor, pageId, section, heading) {
    let current = anchor;
    let candidate = anchor;
    while (current && current !== section) {
      if (isInsideExtensionHost(current, section)) return null;
      const ids = new Set(
        parsedRenderedAnchors(current).map((entry) => entry.pageId),
      );
      const ownId = extractPageId(nodeHref(current), baseForNode(current));
      if (ownId) ids.add(ownId);
      if (ids.size > 1 || (ids.size === 1 && !ids.has(pageId))) break;
      if (ids.size === 1 && (!heading || !nodeContains(current, heading))) {
        candidate = current;
      }
      current = current.parentElement;
    }
    return candidate === section ? null : candidate;
  }

  function duplicateNavigationEntriesAgree(representative, section, heading) {
    if (representative.entries.length === 1) return true;
    const semanticRowValues = representative.entries.map((entry) =>
      semanticRowForAnchor(entry.anchor, section),
    );
    if (
      semanticRowValues.every(Boolean) &&
      new Set(semanticRowValues).size === 1
    ) {
      return true;
    }
    const structuralRowValues = representative.entries.map((entry) =>
      navigationSourceRowForAnchor(
        entry.anchor,
        representative.pageId,
        section,
        heading,
      ),
    );
    return (
      structuralRowValues.every(Boolean) &&
      new Set(structuralRowValues).size === 1
    );
  }

  function navigationTreeResult(overrides = {}) {
    return {
      safe: false,
      nodes: [],
      pageIds: new Set(),
      confidence: 0,
      reason: "ambiguous-navigation-structure",
      ...overrides,
    };
  }

  function buildAriaNavigationTree(representatives, section) {
    const levels = new Map();
    let hasAnyLevel = false;
    for (const representative of representatives) {
      const values = new Set(
        representative.entries
          .map((entry) => positiveAriaLevel(entry.anchor, section))
          .filter((value) => value !== null),
      );
      const hasMissingLevel = representative.entries.some(
        (entry) => positiveAriaLevel(entry.anchor, section) === null,
      );
      if (values.size > 0) hasAnyLevel = true;
      if (values.size !== 1 || hasMissingLevel) {
        levels.set(representative.pageId, null);
      } else {
        levels.set(representative.pageId, [...values][0]);
      }
    }
    if (!hasAnyLevel) return null;
    if ([...levels.values()].some((value) => value === null)) {
      return navigationTreeResult({ reason: "mixed-navigation-aria-levels" });
    }

    const baseLevel = Math.min(...levels.values());
    const roots = [];
    const stack = [];
    for (const representative of representatives) {
      const depth = levels.get(representative.pageId) - baseLevel;
      if (depth < 0 || depth > stack.length || (depth > 0 && !stack[depth - 1])) {
        return navigationTreeResult({ reason: "invalid-navigation-aria-order" });
      }
      stack.length = depth;
      if (depth === 0) roots.push(representative.node);
      else stack[depth - 1].children.push(representative.node);
      stack[depth] = representative.node;
    }
    return navigationTreeResult({
      safe: true,
      nodes: roots,
      pageIds: new Set(representatives.map((entry) => entry.pageId)),
      confidence: 0.95,
      reason: "aria-navigation-tree",
    });
  }

  function domDepth(node) {
    let depth = 0;
    let current = node;
    while (current?.parentElement) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function buildSemanticNavigationTree(representatives, section) {
    const rowByPageId = new Map();
    let hasAnySemanticRow = false;
    for (const representative of representatives) {
      const rowValues = representative.entries.map((entry) =>
        semanticRowForAnchor(entry.anchor, section),
      );
      const rows = new Set(rowValues.filter(Boolean));
      if (rows.size > 0) hasAnySemanticRow = true;
      if (rowValues.every(Boolean) && rows.size === 1) {
        rowByPageId.set(representative.pageId, [...rows][0]);
      }
    }
    if (!hasAnySemanticRow) return null;
    if (rowByPageId.size !== representatives.length) {
      return navigationTreeResult({ reason: "mixed-navigation-semantic-rows" });
    }
    if (new Set(rowByPageId.values()).size !== representatives.length) {
      return navigationTreeResult({ reason: "ambiguous-navigation-semantic-rows" });
    }

    const representativeById = new Map(
      representatives.map((entry) => [entry.pageId, entry]),
    );
    const orderById = new Map(
      representatives.map((entry, index) => [entry.pageId, index]),
    );
    const roots = [];
    const rootRows = [];
    for (const representative of representatives) {
      const row = rowByPageId.get(representative.pageId);
      const parents = [...rowByPageId.entries()]
        .filter(
          ([otherPageId, otherRow]) =>
            otherPageId !== representative.pageId && nodeContains(otherRow, row),
        )
        .sort((left, right) => domDepth(right[1]) - domDepth(left[1]));
      const parentEntry = parents[0] || null;
      if (parentEntry) {
        const parentId = parentEntry[0];
        if (orderById.get(parentId) >= orderById.get(representative.pageId)) {
          return navigationTreeResult({ reason: "invalid-navigation-dom-order" });
        }
        representativeById.get(parentId).node.children.push(representative.node);
      } else {
        roots.push(representative.node);
        rootRows.push(row);
      }
    }

    const rootCollections = new Set(
      rootRows.map((row) => nearestCollection(row, section)),
    );
    if (rootCollections.size !== 1 || rootCollections.has(null)) {
      return navigationTreeResult({ reason: "split-navigation-collections" });
    }
    return navigationTreeResult({
      safe: true,
      nodes: roots,
      pageIds: new Set(representatives.map((entry) => entry.pageId)),
      confidence: 0.88,
      reason: "semantic-navigation-tree",
    });
  }

  function buildStructuralNavigationTree(representatives, section, heading) {
    const rows = [];
    for (const representative of representatives) {
      const possibleRows = new Set(
        representative.entries
          .map((entry) =>
            navigationSourceRowForAnchor(
              entry.anchor,
              representative.pageId,
              section,
              heading,
            ),
          )
          .filter(Boolean),
      );
      if (possibleRows.size !== 1) {
        return navigationTreeResult({ reason: "ambiguous-navigation-structural-row" });
      }
      rows.push([...possibleRows][0]);
    }
    if (
      new Set(rows).size !== rows.length ||
      rows.some((row, index) =>
        rows.some(
          (otherRow, otherIndex) =>
            index !== otherIndex &&
            (nodeContains(row, otherRow) || nodeContains(otherRow, row)),
        ),
      )
    ) {
      return navigationTreeResult({ reason: "overlapping-navigation-rows" });
    }

    const parents = new Set(rows.map((row) => row.parentElement));
    const commonParent = parents.size === 1 ? [...parents][0] : null;
    if (!commonParent || !isRecognizedCollection(commonParent, section)) {
      return navigationTreeResult({ reason: "unrecognized-navigation-row-collection" });
    }
    return navigationTreeResult({
      safe: true,
      nodes: representatives.map((entry) => entry.node),
      pageIds: new Set(representatives.map((entry) => entry.pageId)),
      confidence: 0.72,
      reason: "flat-navigation-tree",
    });
  }

  function buildNavigationTree(sectionInspection) {
    const representatives = navigationRepresentatives(
      sectionInspection.section,
      sectionInspection.sourceKind,
    );
    if (representatives.length === 0) {
      return navigationTreeResult({
        safe: true,
        nodes: [],
        pageIds: new Set(),
        confidence: 0.75,
        reason: "empty-rendered-navigation-section",
      });
    }
    if (
      representatives.some(
        (entry) =>
          !duplicateNavigationEntriesAgree(
            entry,
            sectionInspection.section,
            sectionInspection.heading,
          ),
      )
    ) {
      return navigationTreeResult({ reason: "duplicate-navigation-page-rows" });
    }

    return (
      buildAriaNavigationTree(representatives, sectionInspection.section) ||
      buildSemanticNavigationTree(representatives, sectionInspection.section) ||
      buildStructuralNavigationTree(
        representatives,
        sectionInspection.section,
        sectionInspection.heading,
      )
    );
  }

  function emptyNavigationInspection(reason, confidence = 0) {
    return {
      scopeSafe: false,
      inSidebar: false,
      confidence: Math.max(0, Math.min(0.49, confidence)),
      renderedOnly: true,
      personal: [],
      teamspaces: [],
      sourceCount: 0,
      pageCount: 0,
      reason,
    };
  }

  function selectNavigationSection(inspections, sourceKind) {
    const matching = inspections
      .filter((inspection) => inspection.sourceKind === sourceKind)
      .sort((left, right) => right.score - left.score);
    if (matching.length === 0) return { section: null, ambiguous: false };

    const selected = matching[0];
    for (const other of matching.slice(1)) {
      if (
        other.section !== selected.section &&
        !nodeContains(other.section, selected.section) &&
        !nodeContains(selected.section, other.section)
      ) {
        return { section: null, ambiguous: true };
      }
    }
    return { section: selected, ambiguous: false };
  }

  function teamspaceRoot(sectionInspection, children) {
    const normalizedLabel = normalizeTitle(sectionInspection.label) || "Teamspaces";
    return {
      id: "teamspace:teamspaces",
      pageId: null,
      title: normalizedLabel,
      href: null,
      url: null,
      icon: null,
      sourceKind: "teamspace",
      renderedOnly: true,
      expanded: sectionInspection.expanded,
      children,
    };
  }

  function inspectNavigationTrees(documentLike) {
    if (!documentLike || typeof documentLike.querySelectorAll !== "function") {
      return emptyNavigationInspection("unusable-document");
    }
    const sidebarRoots = candidateSearchRoots(documentLike).filter(
      (descriptor) => descriptor.inSidebar,
    );
    if (sidebarRoots.length === 0) {
      return emptyNavigationInspection("sidebar-not-found");
    }

    const inspectedCandidates = navigationHeadingCandidates(documentLike)
      .map((candidate) => inspectNavigationCandidate(candidate))
      .filter(Boolean);
    if (inspectedCandidates.length === 0) {
      return emptyNavigationInspection("navigation-heading-not-found");
    }

    const privateSelection = selectNavigationSection(inspectedCandidates, "private");
    const teamspaceSelection = selectNavigationSection(inspectedCandidates, "teamspace");
    if (privateSelection.ambiguous || teamspaceSelection.ambiguous) {
      return emptyNavigationInspection("ambiguous-navigation-sections", 0.4);
    }
    const selectedSections = [privateSelection.section, teamspaceSelection.section].filter(Boolean);
    if (selectedSections.length === 0) {
      return emptyNavigationInspection("navigation-heading-not-found");
    }

    const builtSections = selectedSections.map((section) => ({
      section,
      tree: buildNavigationTree(section),
    }));
    const unsafeTree = builtSections.find(({ tree }) => !tree.safe);
    if (unsafeTree) {
      return emptyNavigationInspection(
        unsafeTree.tree.reason,
        unsafeTree.section.confidence,
      );
    }

    const seenPageIds = new Set();
    for (const { tree } of builtSections) {
      for (const pageId of tree.pageIds) {
        if (seenPageIds.has(pageId)) {
          return emptyNavigationInspection("duplicate-navigation-source-page", 0.4);
        }
        seenPageIds.add(pageId);
      }
    }

    const privateBuilt = builtSections.find(
      ({ section }) => section.sourceKind === "private",
    );
    const teamspaceBuilt = builtSections.find(
      ({ section }) => section.sourceKind === "teamspace",
    );
    const confidence = Math.min(
      ...builtSections.flatMap(({ section, tree }) => [
        section.confidence,
        tree.confidence,
      ]),
    );
    return {
      scopeSafe: true,
      inSidebar: true,
      confidence: Math.max(0, Math.min(1, confidence)),
      renderedOnly: true,
      personal: privateBuilt?.tree.nodes || [],
      teamspaces: teamspaceBuilt
        ? [teamspaceRoot(teamspaceBuilt.section, teamspaceBuilt.tree.nodes)]
        : [],
      sourceCount: builtSections.length,
      pageCount: seenPageIds.size,
      reason: "rendered-navigation-safe",
    };
  }

  function readNavigationTrees(documentLike) {
    return inspectNavigationTrees(documentLike);
  }

  function readFavoritesNavigation(documentLike) {
    const candidates = findHeadingCandidates(documentLike)
      .filter((candidate) => candidate.inSidebar && isRenderedNode(candidate.node))
      .map((candidate) => inspectCandidate(candidate, documentLike))
      .filter((inspection) => inspection && inspection.score >= 5.25)
      .map((inspection) => ({ ...inspection, sourceKind: "favorites" }));
    const selection = selectNavigationSection(candidates, "favorites");
    if (selection.ambiguous) {
      return navigationTreeResult({ reason: "ambiguous-favorites-navigation" });
    }
    const inspection = selection.section;
    if (!inspection) {
      return navigationTreeResult({ reason: "favorites-navigation-not-found" });
    }
    const classification = classifyNativeFavorites(inspection.section, inspection.heading);
    if (!classification.safe) {
      return navigationTreeResult({ reason: classification.reason });
    }
    // Native Favorites can contain expanded descendants, not just saved roots.
    // Use the same verified hierarchy builders as Private and Teamspaces.
    return buildNavigationTree(inspection);
  }

  function hasClassToken(node, token) {
    return String(getAttribute(node, "class") || "").split(/\s+/u).includes(token);
  }

  function outlinerSourceKind(node) {
    if (nodeTagName(node) !== "div" || nodeRole(node) !== "tree") return null;
    const kinds = [
      ["notion-outliner-private", "private"],
      ["notion-outliner-team", "teamspace"],
      ["notion-outliner-bookmarks", "favorites"],
    ].filter(([className]) => hasClassToken(node, className));
    return kinds.length === 1 ? kinds[0][1] : null;
  }

  function readOutlinerCollection(collection) {
    let remainingNodes = 4096;
    let unsafe = false;
    const pageIds = new Set();
    const visit = (container, depth) => {
      if (depth > 64) {
        unsafe = true;
        return [];
      }
      const nodes = [];
      for (const child of directElementChildren(container)) {
        remainingNodes -= 1;
        if (remainingNodes < 0) {
          unsafe = true;
          break;
        }
        if (!isRenderedNode(child) || isInsideExtensionHost(child)) continue;
        if (nodeTagName(child) === "div" && hasClassToken(child, "notion-page-block")) {
          const direct = directElementChildren(child);
          const anchors = direct.filter((node) => nodeTagName(node) === "a" && nodeRole(node) === "treeitem");
          const groups = direct.filter((node) => nodeRole(node) === "group");
          const anchor = anchors.length === 1 ? anchors[0] : null;
          const pageId = anchor ? extractPageId(nodeHref(anchor), baseForNode(anchor)) : null;
          const blockId = normalizePageId(getAttribute(child, "data-block-id"));
          if (!pageId || blockId !== pageId || anchors.length !== 1 || groups.length > 1) {
            unsafe = true;
            continue;
          }
          if (!isRenderedNode(anchor)) continue;
          if (pageIds.has(pageId)) {
            unsafe = true;
            continue;
          }
          pageIds.add(pageId);
          const node = {
            pageId,
            title: readElementTitle(anchor),
            href: safeAbsoluteNotionUrl(nodeHref(anchor), baseForNode(anchor)),
            icon: readElementIcon(anchor),
            children: [],
          };
          const group = groups[0];
          const expanded = getAttribute(anchor, "aria-expanded");
          if (group && expanded === "true" && isRenderedNode(group)) {
            // The child collection belongs to this exact page block. An
            // adjacent anchor or visual indentation never establishes parentage.
            node.children = visit(group, depth + 1);
          } else if (group && expanded !== "false" && isRenderedNode(group)) {
            unsafe = true;
          }
          nodes.push(node);
        } else if (
          nodeTagName(child) === "div" &&
          !["group", "tree", "treeitem"].includes(nodeRole(child))
        ) {
          nodes.push(...visit(child, depth + 1));
        }
        // Unknown/unowned groups and nested trees are not promoted to page
        // descendants, even when they happen to contain valid-looking links.
      }
      return nodes;
    };
    const nodes = visit(collection, 0);
    return { safe: !unsafe, nodes: unsafe ? [] : nodes };
  }

  function readRenderedOutliners(documentLike) {
    const collections = [];
    const kinds = new Set();
    const sidebars = new Set();
    for (const node of queryAll(documentLike, "[role]")) {
      const kind = outlinerSourceKind(node);
      if (!kind || !isRenderedNode(node) || isInsideExtensionHost(node)) continue;
      // Modern outliner roots can sit below many React/layout wrappers. Keep
      // this bounded lookup local rather than widening primary-nav mounting.
      let sidebar = null;
      let candidate = node.parentElement;
      for (let depth = 0; candidate && depth < 64; depth += 1) {
        if (
          nodeTagName(candidate) === "nav" &&
          /^(?:notion sidebar|sidebar|사이드바)$/iu.test(headingLabel(getAttribute(candidate, "aria-label")))
        ) {
          sidebar = candidate;
          break;
        }
        candidate = candidate.parentElement;
      }
      if (!sidebar) continue;
      let ancestor = node.parentElement;
      let nested = false;
      while (ancestor && ancestor !== sidebar) {
        if (nodeRole(ancestor) === "tree" || hasClassToken(ancestor, "notion-page-block")) nested = true;
        ancestor = ancestor.parentElement;
      }
      if (nested) continue;
      kinds.add(kind);
      sidebars.add(sidebar);
      collections.push(node);
    }
    if (sidebars.size > 1) return { kinds, sources: [], partial: true };
    const trees = collections.map(readOutlinerCollection);
    return {
      kinds,
      sources: trees.filter((tree) => tree.safe).map((tree) => tree.nodes),
      partial: trees.some((tree) => !tree.safe),
    };
  }

  function pageNavigationNode(candidate) {
    const pageId = normalizePageId(candidate?.pageId);
    const href = safeAbsoluteNotionUrl(candidate?.href || candidate?.url);
    if (!pageId || !href || extractPageId(href) !== pageId) return null;
    return {
      pageId,
      title: normalizeTitle(candidate.title) || "제목 없음",
      href,
      icon: typeof candidate.icon === "string" ? candidate.icon : null,
      children: [],
    };
  }

  function mergePageNavigationSources(sources) {
    const nodes = new Map();
    const parentById = new Map();
    const childrenById = new Map();
    let ambiguous = false;

    const visit = (candidate, parentId, path) => {
      const node = pageNavigationNode(candidate);
      if (!node || path.has(node.pageId)) {
        ambiguous = true;
        return;
      }
      if (!nodes.has(node.pageId)) nodes.set(node.pageId, node);
      if (!childrenById.has(node.pageId)) childrenById.set(node.pageId, new Set());
      if (parentId) {
        const previousParent = parentById.get(node.pageId);
        if (previousParent && previousParent !== parentId) ambiguous = true;
        parentById.set(node.pageId, parentId);
        childrenById.get(parentId).add(node.pageId);
      }
      const nextPath = new Set(path).add(node.pageId);
      for (const child of candidate.children || []) visit(child, node.pageId, nextPath);
    };
    for (const source of sources) {
      for (const candidate of source) visit(candidate, null, new Set());
    }

    // A Favorite may also occur underneath a Private/Teamspace parent. Being
    // a saved root does not contradict that parent, but two different parents
    // or a cycle across otherwise valid source trees do.
    for (const pageId of nodes.keys()) {
      const seen = new Set();
      let ancestor = pageId;
      while (ancestor) {
        if (seen.has(ancestor)) {
          ambiguous = true;
          break;
        }
        seen.add(ancestor);
        ancestor = parentById.get(ancestor);
      }
    }
    if (ambiguous) return { roots: [], ambiguous: true };
    for (const [pageId, childIds] of childrenById) {
      nodes.get(pageId).children = [...childIds].map((childId) => nodes.get(childId));
    }
    return {
      roots: [...nodes.values()].filter((node) => !parentById.has(node.pageId)),
      ambiguous: false,
    };
  }

  function currentDocumentPageTitle(documentLike, currentId) {
    if (
      activePageId(documentLike) !== currentId ||
      typeof documentLike?.title !== "string"
    ) return "";
    const title = normalizeTitle(documentLike.title)
      .replace(/^\(\d+\+?\)\s*/u, "")
      .replace(/\s+[|–—-]\s+Notion$/iu, "")
      .trim();
    return !title || /^(?:Notion|노션)$/iu.test(title) ? "" : title;
  }

  function readPageNavigation(documentLike, options = {}) {
    const currentId = options.activePageId === undefined
      ? activePageId(documentLike)
      : normalizePageId(options.activePageId);
    const sources = [];
    const outliners = readRenderedOutliners(documentLike);
    const navigation = readNavigationTrees(documentLike);
    const favoritesNavigation = documentLike?.querySelectorAll
      ? readFavoritesNavigation(documentLike)
      : navigationTreeResult({ reason: "unusable-document" });
    if (navigation.scopeSafe) {
      const legacyNodes = [
        ...(outliners.kinds.has("private") ? [] : navigation.personal),
        ...(outliners.kinds.has("teamspace") ? [] : navigation.teamspaces.flatMap((teamspace) => teamspace.children || [])),
      ];
      if (legacyNodes.length || outliners.kinds.size === 0) sources.push(legacyNodes);
    }
    if (favoritesNavigation.safe && !outliners.kinds.has("favorites")) sources.push(favoritesNavigation.nodes);
    sources.push(...outliners.sources);
    const merged = mergePageNavigationSources(sources);
    const scopeSafe = sources.length > 0 && !merged.ambiguous;
    let currentPage = null;
    const findCurrent = (nodes) => {
      for (const node of nodes) {
        if (node.pageId === currentId) return node;
        const found = findCurrent(node.children);
        if (found) return found;
      }
      return null;
    };
    if (currentId) {
      currentPage = findCurrent(merged.roots);
      if (!currentPage) {
        // Saved favorites provide labels only, never parent/child relationships.
        const saved = Array.isArray(options.favorites)
          ? options.favorites.find((favorite) => {
            if (normalizePageId(favorite?.pageId) !== currentId) return false;
            const href = favorite.href || favorite.url;
            return !href || extractPageId(href) === currentId;
          })
          : null;
        currentPage = {
          pageId: currentId,
          title: currentDocumentPageTitle(documentLike, currentId) || normalizeTitle(saved?.title) || "현재 열린 페이지",
          href: `${NOTION_ORIGIN}/${currentId}`,
          icon: typeof saved?.icon === "string" ? saved.icon : null,
          children: [],
        };
      }
    }
    return {
      currentPage,
      roots: merged.roots,
      renderedOnly: true,
      scopeSafe,
      reason: merged.ambiguous
        ? "ambiguous-page-navigation-relationships"
        : !scopeSafe
          ? "page-navigation-unavailable"
          : merged.roots.length === 0
            ? "empty-rendered-page-navigation"
            : outliners.partial || sources.length < 2
              ? "partial-rendered-page-navigation"
              : "rendered-page-navigation-safe",
    };
  }

  function readFavorites(section) {
    if (!section || typeof section.querySelectorAll !== "function") return [];

    const base = baseForNode(section);
    const inspection = sectionInspections.get(section);
    const classification = classifyNativeFavorites(section, inspection?.heading || null);
    if (!classification.safe) return [];
    const favorites = parsedNativeAnchors(section)
      .filter(({ pageId }) => classification.pageIds.has(pageId))
      .map(({ anchor, href, pageId }) => {
        const url = safeAbsoluteNotionUrl(href, base);
        return {
          pageId,
          title: readElementTitle(anchor),
          url,
          href: url,
          icon: readElementIcon(anchor),
        };
      });

    return dedupeFavorites(favorites);
  }

  function normalizeWorkspaceToken(value) {
    const normalizedPageId = normalizePageId(value);
    if (normalizedPageId) return normalizedPageId;
    if (typeof value !== "string") return null;

    const token = normalizeTitle(value).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{2,127}$/u.test(token)) return null;
    return token;
  }

  function workspaceIdFromDocument(documentLike) {
    if (!documentLike) return null;

    const directNodes = [documentLike.documentElement, documentLike.body].filter(Boolean);
    const attributeNames = ["data-workspace-id", "data-space-id"];
    for (const node of directNodes) {
      for (const attributeName of attributeNames) {
        const value = normalizeWorkspaceToken(getAttribute(node, attributeName));
        if (value) return value;
      }
    }

    for (const meta of queryAll(
      documentLike,
      'meta[name="notion-workspace-id"], meta[property="notion:workspace_id"]',
    )) {
      const value = normalizeWorkspaceToken(getAttribute(meta, "content"));
      if (value) return value;
    }

    const attributedNodes = queryAll(
      documentLike,
      "[data-workspace-id], [data-space-id]",
    );
    const activeValues = new Set();
    const allValues = new Set();
    for (const node of attributedNodes) {
      const value = normalizeWorkspaceToken(
        getAttribute(node, "data-workspace-id") || getAttribute(node, "data-space-id"),
      );
      if (!value) continue;
      allValues.add(value);
      if (
        getAttribute(node, "aria-current") === "true" ||
        getAttribute(node, "data-active") === "true"
      ) {
        activeValues.add(value);
      }
    }

    if (activeValues.size === 1) return [...activeValues][0];
    if (allValues.size === 1) return [...allValues][0];
    return null;
  }

  function locationFromInputs(documentOrLocation, explicitLocation) {
    if (explicitLocation) return explicitLocation;
    if (documentOrLocation?.location) return documentOrLocation.location;
    if (
      documentOrLocation?.href ||
      documentOrLocation?.origin ||
      documentOrLocation?.pathname
    ) {
      return documentOrLocation;
    }
    return root.location || null;
  }

  function activePageId(documentOrLocation, explicitLocation) {
    const locationLike = locationFromInputs(documentOrLocation, explicitLocation);
    const href =
      locationLike?.href ||
      (locationLike?.origin && locationLike?.pathname
        ? `${locationLike.origin}${locationLike.pathname}${locationLike.search || ""}${locationLike.hash || ""}`
        : null);
    return href ? extractPageId(href) : null;
  }

  function normalizeWorkspaceSlug(value) {
    if (typeof value !== "string" || value !== value.trim()) return null;

    const normalized = value.normalize("NFKC");
    if (
      /[\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff/\\]/u.test(normalized)
    ) {
      return null;
    }

    const slug = normalizeTitle(normalized)
      .toLowerCase()
      .replace(/[\s\u00a0]+/gu, "-");
    if (
      !slug ||
      slug.length > 160 ||
      RESERVED_PATH_SEGMENTS.has(slug) ||
      PAGE_ID_SUFFIX.test(slug) ||
      !/^[\p{L}\p{N}](?:[\p{L}\p{N}_-]{0,158}[\p{L}\p{N}])?$/u.test(slug)
    ) {
      return null;
    }
    return encodeURIComponent(slug);
  }

  function workspaceSlugFromLocation(locationLike) {
    const locationUrl = toUrl(
      locationLike?.href ||
        (locationLike?.origin && locationLike?.pathname
          ? `${locationLike.origin}${locationLike.pathname}`
          : null),
    );
    if (!locationUrl || locationUrl.origin !== NOTION_ORIGIN) return null;
    if (!pageIdFromUrl(locationUrl)) return null;

    let rawSegments;
    let segments;
    try {
      rawSegments = locationUrl.pathname.slice(1).split("/");
      if (
        !locationUrl.pathname.startsWith("/") ||
        rawSegments.length === 0 ||
        rawSegments.some((segment) => !segment)
      ) {
        return null;
      }
      segments = rawSegments.map((segment) => decodeURIComponent(segment));
    } catch {
      return null;
    }

    let workspaceSegment;
    if (rawSegments[0] === "p") {
      // Modern Notion route: /p/<workspace-slug>/<page-with-id>.
      if (segments.length !== 3) return null;
      workspaceSegment = segments[1];
    } else {
      // Legacy supported route: /<workspace-slug>/<page-with-id>.
      if (segments.length !== 2) return null;
      workspaceSegment = segments[0];
    }
    return normalizeWorkspaceSlug(workspaceSegment);
  }

  function deriveWorkspaceKey(documentOrLocation, explicitLocation) {
    const documentLike = documentOrLocation?.querySelectorAll
      ? documentOrLocation
      : null;
    const stableId = workspaceIdFromDocument(documentLike);
    if (stableId) return `workspace:id:${stableId}`;

    const slug = workspaceSlugFromLocation(
      locationFromInputs(documentOrLocation, explicitLocation),
    );
    return slug ? `workspace:slug:${slug}` : null;
  }

  function deriveWorkspaceIdentity(documentOrLocation, explicitLocation) {
    const documentLike = documentOrLocation?.querySelectorAll
      ? documentOrLocation
      : null;
    const stableId = workspaceIdFromDocument(documentLike);
    const slug = workspaceSlugFromLocation(
      locationFromInputs(documentOrLocation, explicitLocation),
    );
    return {
      key: stableId ? `workspace:id:${stableId}` : slug ? `workspace:slug:${slug}` : null,
      slugKey: slug ? `workspace:slug:${slug}` : null,
    };
  }

  function getOrCreateRecord(section) {
    let record = sectionRecords.get(section);
    if (!record) {
      record = {
        section,
        heading: sectionInspections.get(section)?.heading || null,
        host: null,
        hiddenRows: new Set(),
      };
      sectionRecords.set(section, record);
      liveRecords.add(record);
    }
    return record;
  }

  function findHeadingWithin(section) {
    let best = null;
    const candidates = [section, ...queryAll(section, "h1, h2, h3, h4, h5, h6, [role=\"heading\"], button, [aria-label], [data-testid], div, span")];
    for (const node of candidates) {
      const signal = headingSignal(node);
      if (signal > (best?.signal || 0)) best = { node, signal };
    }
    return best?.node || null;
  }

  function topLevelChild(section, descendant) {
    if (!section || !descendant || descendant === section) return null;
    let current = descendant;
    while (current?.parentElement && current.parentElement !== section) {
      current = current.parentElement;
    }
    return current?.parentElement === section ? current : null;
  }

  function removeNode(node) {
    if (!node) return;
    if (typeof node.remove === "function") {
      node.remove();
      return;
    }
    if (node.parentNode && typeof node.parentNode.removeChild === "function") {
      node.parentNode.removeChild(node);
    }
  }

  function mountHost(section, host) {
    if (
      !section ||
      !host ||
      typeof section.appendChild !== "function" ||
      typeof host.setAttribute !== "function"
    ) {
      return null;
    }

    const record = getOrCreateRecord(section);
    for (const existing of queryAll(section, `[${HOST_ATTRIBUTE}]`)) {
      if (existing !== host) removeNode(existing);
    }

    host.setAttribute(HOST_ATTRIBUTE, "");
    record.host = host;
    record.heading =
      sectionInspections.get(section)?.heading ||
      findHeadingWithin(section) ||
      null;

    const headerChild = topLevelChild(section, record.heading);
    if (headerChild && typeof section.insertBefore === "function") {
      section.insertBefore(host, headerChild.nextSibling || null);
    } else {
      section.appendChild(host);
    }

    return host;
  }

  function uniquePageIdsWithin(node) {
    const ids = new Set(parsedNativeAnchors(node).map((entry) => entry.pageId));
    const ownHref = nodeHref(node);
    if (ownHref && !isInsideExtensionHost(node)) {
      const ownPageId = extractPageId(ownHref, baseForNode(node));
      if (ownPageId) ids.add(ownPageId);
    }
    return ids;
  }

  function sourceRowForAnchor(anchor, pageId, section, heading) {
    let current = anchor;
    let candidate = anchor;

    while (current && current !== section) {
      if (isInsideExtensionHost(current, section)) return null;
      const ids = uniquePageIdsWithin(current);
      if (ids.size > 1 || (ids.size === 1 && !ids.has(pageId))) break;
      if (ids.size === 1 && (!heading || !nodeContains(current, heading))) candidate = current;
      current = current.parentElement;
    }

    return candidate === section ? null : candidate;
  }

  function analyzeNativeRows(section, heading) {
    const classification = classifyNativeFavorites(section, heading);
    if (!classification.safe || !classification.replaceSafe) {
      return { safe: false, favorites: readFavorites(section), rows: [] };
    }
    const links = parsedNativeAnchors(section).filter(({ pageId }) =>
      classification.pageIds.has(pageId),
    );
    const favorites = readFavorites(section);
    const rowByPageId = new Map();

    for (const { anchor, pageId } of links) {
      const row = sourceRowForAnchor(anchor, pageId, section, heading);
      if (!row) return { safe: false, favorites, rows: [] };

      const existing = rowByPageId.get(pageId);
      if (existing && existing !== row) return { safe: false, favorites, rows: [] };
      rowByPageId.set(pageId, row);
    }

    if (rowByPageId.size !== favorites.length) {
      return { safe: false, favorites, rows: [] };
    }

    const entries = [...rowByPageId.entries()];
    const rows = entries.map(([, row]) => row);
    if (new Set(rows).size !== rows.length) {
      return { safe: false, favorites, rows: [] };
    }

    for (let index = 0; index < entries.length; index += 1) {
      const [pageId, row] = entries[index];
      const ids = uniquePageIdsWithin(row);
      if (ids.size !== 1 || !ids.has(pageId)) {
        return { safe: false, favorites, rows: [] };
      }

      for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
        const otherRow = entries[otherIndex][1];
        if (nodeContains(row, otherRow) || nodeContains(otherRow, row)) {
          return { safe: false, favorites, rows: [] };
        }
      }
    }

    return { safe: true, favorites, rows };
  }

  function pageIdsFromHost(host) {
    const ids = new Set();
    const base = baseForNode(host);
    const roots = host.shadowRoot ? [host, host.shadowRoot] : [host];
    for (const queryRoot of roots) {
      for (const anchor of queryAll(queryRoot, "a[href]")) {
        const pageId = extractPageId(nodeHref(anchor), base);
        if (pageId) ids.add(pageId);
      }
      for (const node of queryAll(queryRoot, "[data-page-id]")) {
        const pageId = normalizePageId(getAttribute(node, "data-page-id"));
        if (pageId) ids.add(pageId);
      }
    }
    return ids;
  }

  function sameIdSet(favorites, ids) {
    if (favorites.length !== ids.size) return false;
    return favorites.every((favorite) => ids.has(favorite.pageId));
  }

  function restoreRows(record) {
    let changed = false;
    const markedRows = new Set([
      ...record.hiddenRows,
      ...queryAll(record.section, `[${HIDDEN_ROW_ATTRIBUTE}]`),
    ]);
    for (const row of markedRows) {
      if (typeof row?.removeAttribute === "function") {
        row.removeAttribute(HIDDEN_ROW_ATTRIBUTE);
      }
      changed = true;
    }
    record.hiddenRows.clear();
    return changed;
  }

  function hideRows(record, rows) {
    for (const row of rows) {
      if (
        typeof row?.setAttribute !== "function" ||
        typeof row?.removeAttribute !== "function"
      ) {
        return false;
      }
    }

    for (const row of rows) {
      record.hiddenRows.add(row);
      row.setAttribute(HIDDEN_ROW_ATTRIBUTE, "");
    }
    return true;
  }

  function setNativeRowsVisible(section, visible) {
    if (!section) return false;
    const record = getOrCreateRecord(section);

    if (visible) {
      restoreRows(record);
      return true;
    }

    // Re-read from a visible source each time so a Notion SPA re-render cannot leave stale rows hidden.
    restoreRows(record);
    const inspection = sectionInspections.get(section);
    if (!inspection?.scopeSafe || !inspection.replaceSafe) return false;
    record.heading =
      sectionInspections.get(section)?.heading ||
      findHeadingWithin(section) ||
      null;
    const analysis = analyzeNativeRows(section, record.heading);
    const host =
      (record.host && nodeContains(section, record.host) ? record.host : null) ||
      queryAll(section, `[${HOST_ATTRIBUTE}]`)[0] ||
      null;

    if (
      !analysis.safe ||
      !host ||
      !sameIdSet(analysis.favorites, pageIdsFromHost(host))
    ) {
      restoreRows(record);
      return false;
    }

    if (!hideRows(record, analysis.rows)) {
      restoreRows(record);
      return false;
    }
    return true;
  }

  function restoreOne(section) {
    const record = sectionRecords.get(section);
    let changed = false;

    if (record) {
      changed = restoreRows(record) || changed;
      if (record.host) {
        removeNode(record.host);
        record.host = null;
        changed = true;
      }
      liveRecords.delete(record);
      sectionRecords.delete(section);
    }

    for (const row of queryAll(section, `[${HIDDEN_ROW_ATTRIBUTE}]`)) {
      if (typeof row.removeAttribute === "function") {
        row.removeAttribute(HIDDEN_ROW_ATTRIBUTE);
        changed = true;
      }
    }
    for (const host of queryAll(section, `[${HOST_ATTRIBUTE}]`)) {
      removeNode(host);
      changed = true;
    }
    return changed;
  }

  function restore(section) {
    if (section) return restoreOne(section);

    let changed = false;
    for (const record of [...liveRecords]) {
      changed = restoreOne(record.section) || changed;
    }
    return changed;
  }

  const namespace = root.NotionFavoriteSections || {};
  namespace.adapter = Object.freeze({
    HIDDEN_ROW_ATTRIBUTE,
    HOST_ATTRIBUTE,
    NOTION_ORIGIN,
    PRIMARY_NAV_HOST_ATTRIBUTE,
    PRIMARY_NAV_VIEW_HOST_ATTRIBUTE,
    activePageId,
    dedupeFavorites,
    deriveWorkspaceKey,
    deriveWorkspaceIdentity,
    extractPageId,
    inspectFavoritesSection,
    inspectNavigationTrees,
    inspectPrimaryNavigation,
    isAllowedNotionUrl,
    locateFavoritesSection,
    mountHost,
    mountPrimaryNavigationHost,
    mountPrimaryNavigationViewHost,
    normalizePageId,
    normalizeEmojiIcon,
    normalizeTitle,
    readFavorites,
    readNavigationTrees,
    readPageNavigation,
    restore,
    restorePrimaryNavigation,
    restorePrimaryNavigationView,
    setNativeRowsVisible,
  });
  root.NotionFavoriteSections = namespace;
})(globalThis);
