(function initializeNotionTreeContent(globalScope) {
  "use strict";

  const namespace = globalScope.NotionFavoriteSections || {};
  if (namespace.content?.started) return;

  const model = namespace.model;
  const adapter = namespace.adapter;
  const viewModule = namespace.view;
  const panelModule = namespace.panel;
  const profileModel = namespace.profileCatalog;
  const documentRef = globalScope.document;

  if (!model || !adapter || !viewModule || !panelModule || !profileModel || !documentRef) {
    console.warn("Moa could not initialize its modules.");
    return;
  }

  const MESSAGE_TYPES = Object.freeze({
    GET: "NFS_STORAGE_GET",
    SET: "NFS_STORAGE_SET",
    PROFILE_GET: "NFS_PROFILE_CATALOG_GET"
  });
  const MINIMUM_CONFIDENCE = 0.65;
  const REFRESH_DELAY_MS = 180;
  const emptyPageNavigation = () => ({
    currentPage: null, roots: [], renderedOnly: true, scopeSafe: false,
    reason: "page-navigation-unavailable"
  });

  const state = {
    started: true,
    destroyed: false,
    primaryInspection: null,
    sidebarRoot: null,
    menuHost: null,
    viewHost: null,
    panelShell: null,
    treeView: null,
    favoritesInspection: null,
    favoritesSection: null,
    favorites: [],
    favoriteMetadata: new Map(),
    metadataSavedSignature: "",
    metadataSaveFailed: false,
    sourceSignature: "",
    workspace: null,
    baseWorkspaceKey: null,
    workspaceKey: null,
    storageRevision: 0,
    storageReady: false,
    undo: null,
    activePageId: null,
    pageNavigation: emptyPageNavigation(),
    routeTimer: null,
    observedHref: globalScope.location?.href || "",
    busy: false,
    observer: null,
    refreshTimer: null,
    reconnectTimer: null,
    syncPort: null,
    operationChain: Promise.resolve()
  };

  function extensionRuntime() {
    const runtime = globalScope.chrome?.runtime;
    if (!runtime || typeof runtime.sendMessage !== "function") {
      throw new Error("확장 저장소에 연결할 수 없습니다. 확장을 다시 로드해 주세요.");
    }
    return runtime;
  }

  async function sendStorageMessage(type, payload) {
    let response;
    try {
      response = await extensionRuntime().sendMessage({ type, payload });
    } catch (error) {
      throw new Error(
        error?.message
          ? `확장 저장소 오류: ${error.message}`
          : "확장 저장소에 연결하지 못했습니다."
      );
    }
    if (!response || response.ok !== true) {
      const error = new Error(response?.error || "확장 저장소 요청이 실패했습니다.");
      error.response = response || null;
      throw error;
    }
    return response;
  }

  function enqueue(operation) {
    const task = state.operationChain.then(() => {
      if (state.destroyed) return undefined;
      return operation();
    });
    state.operationChain = task.catch(() => undefined);
    return task;
  }

  function stableSourceSignature(favorites) {
    return (favorites || [])
      .map((favorite) => String(favorite?.pageId || ""))
      .filter(Boolean)
      .sort()
      .join("|");
  }

  function workspaceFavoriteMap(workspace = state.workspace) {
    const map = new Map();
    for (const group of workspace?.groups || []) {
      for (const section of group.sections || []) {
        for (const favorite of section.favorites || []) {
          if (favorite?.pageId) map.set(String(favorite.pageId), favorite);
        }
      }
    }
    return map;
  }

  function metadataEntry(value) {
    const pageId = adapter.normalizePageId(value?.pageId);
    if (!pageId || typeof value?.title !== "string") return null;
    const title = value.title.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim().slice(0, 300);
    if (!title || title === "현재 열린 페이지" || title === "제목 없음") return null;
    const rawIcon = value.iconText || value.icon || "";
    const icon = typeof adapter.normalizeEmojiIcon === "function"
      ? adapter.normalizeEmojiIcon(rawIcon) || ""
      : typeof rawIcon === "string" && !/[\u0000-\u001f\u007f-\u009f]/u.test(rawIcon) ? rawIcon.slice(0, 64) : "";
    return { pageId, title, icon };
  }

  function displayFavoriteMetadata() {
    return [...workspaceFavoriteMap().keys()]
      .map(pageId => state.favoriteMetadata.get(pageId)).filter(Boolean);
  }

  function rememberFavoriteMetadata() {
    const managed = workspaceFavoriteMap();
    const remember = value => {
      const entry = metadataEntry(value);
      if (!entry || !managed.has(entry.pageId)) return;
      const previous = state.favoriteMetadata.get(entry.pageId);
      if (!entry.icon && previous?.icon) entry.icon = previous.icon;
      state.favoriteMetadata.set(entry.pageId, entry);
    };
    // Titles are independent of source eligibility. Cached entries never become
    // picker candidates or prove a native Favorite or parent/child relationship.
    let budget = 10000;
    const visit = (nodes, depth = 0) => {
      if (depth > 64) return;
      for (const node of nodes || []) {
        if (--budget < 0) return;
        remember(node);
        visit(node.children, depth + 1);
      }
    };
    if (state.pageNavigation.scopeSafe) visit(state.pageNavigation.roots);
    if (state.pageNavigation.currentPage) remember(state.pageNavigation.currentPage);
    state.favorites.forEach(remember);
    // Retain recent in-memory labels for Undo, but never retain another
    // workspace's labels or persist entries not currently managed.
    while (state.favoriteMetadata.size > 10000) {
      state.favoriteMetadata.delete(state.favoriteMetadata.keys().next().value);
    }
  }

  async function loadFavoriteMetadata(workspaceKey) {
    if (!workspaceKey || !state.storageReady) return;
    try {
      const response = await sendStorageMessage("NFS_METADATA_GET", { workspaceKey });
      if (workspaceKey !== state.workspaceKey || workspaceIdentity().key !== state.baseWorkspaceKey) return;
      const managed = workspaceFavoriteMap();
      const stored = new Map();
      for (const value of Array.isArray(response.metadata) ? response.metadata.slice(0, 10000) : []) {
        const entry = metadataEntry(value);
        if (entry && managed.has(entry.pageId)) {
          stored.set(entry.pageId, entry);
          if (!state.favoriteMetadata.has(entry.pageId)) state.favoriteMetadata.set(entry.pageId, entry);
        }
      }
      state.metadataSavedSignature = JSON.stringify([...managed.keys()].map(id => stored.get(id)).filter(Boolean));
    } catch (_error) {
      // A best-effort display cache must never invalidate the saved tree.
      state.metadataSavedSignature = "";
    }
  }

  async function saveFavoriteMetadata() {
    const workspaceKey = state.workspaceKey;
    if (!workspaceKey || !state.storageReady || workspaceIdentity().key !== state.baseWorkspaceKey) return;
    const entries = displayFavoriteMetadata();
    const signature = JSON.stringify(entries);
    if (signature === state.metadataSavedSignature) return;
    if (!entries.length) {
      state.metadataSavedSignature = signature;
      return;
    }
    try {
      await sendStorageMessage("NFS_METADATA_MERGE", { workspaceKey, entries });
      if (workspaceKey === state.workspaceKey) {
        state.metadataSavedSignature = signature;
        state.metadataSaveFailed = false;
      }
    } catch (_error) {
      if (workspaceKey === state.workspaceKey) state.metadataSaveFailed = true;
    }
  }

  function favoritesSourceIsSafe() {
    const inspection = state.favoritesInspection;
    return Boolean(
      state.favoritesSection &&
        inspection?.inSidebar === true &&
        inspection?.scopeSafe === true &&
        inspection?.topLevelSafe === true &&
        (inspection.confidence >= MINIMUM_CONFIDENCE || inspection.emptySafe === true) &&
        inspection.favoriteCount === state.favorites.length
    );
  }

  function computeManagementPreview() {
    const sourceIds = new Set(
      state.favorites.map((favorite) => String(favorite?.pageId || "")).filter(Boolean)
    );
    const managed = workspaceFavoriteMap();
    let availableCount = 0;
    let missingCount = 0;
    for (const pageId of sourceIds) {
      if (!managed.has(pageId)) availableCount += 1;
    }
    for (const [pageId, favorite] of managed) {
      if (!favorite.dormant && !sourceIds.has(pageId)) missingCount += 1;
    }

    return {
      sourceCount: sourceIds.size,
      managedCount: managed.size,
      availableCount,
      missingCount,
      busy: state.busy,
      canManage: Boolean(
        state.baseWorkspaceKey &&
          state.workspaceKey &&
          state.storageReady &&
          favoritesSourceIsSafe() &&
          !state.busy
      ),
      canReset: Boolean(
        state.baseWorkspaceKey && state.workspaceKey && state.storageReady && !state.busy
      )
    };
  }

  function workspaceStatus() {
    if (!state.baseWorkspaceKey) {
      return {
        message: "현재 Notion 워크스페이스를 확인하지 못해 저장을 중지했습니다.",
        tone: "warning"
      };
    }
    if (!state.storageReady) {
      return {
        message: "로컬 저장소에 연결하지 못했습니다. 확장을 다시 로드해 주세요.",
        tone: "error"
      };
    }
    if (state.metadataSaveFailed) return {
      message: "즐겨찾기 배치는 저장됐지만 제목을 보관하지 못했습니다. 확장을 새로고침한 뒤 다시 확인해 주세요.",
      tone: "warning"
    };
    if (!favoritesSourceIsSafe()) {
      return {
        message: "Notion 즐겨찾기 목록을 펼치면 항목을 골라 추가할 수 있습니다.",
        tone: "warning"
      };
    }
    return null;
  }

  function undoState() {
    return {
      canUndo: Boolean(
        state.undo &&
          state.undo.workspaceKey === state.workspaceKey &&
          state.undo.revision === state.storageRevision &&
          state.storageReady &&
          !state.busy
      ),
      label: state.undo?.label || "마지막 변경 되돌리기"
    };
  }

  function renderCurrent() {
    if (!state.treeView || !state.workspace) return;
    state.treeView.update({
      workspace: state.workspace,
      workspaceKey: state.workspaceKey,
      workspaceRevision: state.storageRevision,
      undoState: undoState(),
      favorites: state.favorites,
      favoriteMetadata: displayFavoriteMetadata(),
      status: workspaceStatus(),
      importPreview: computeManagementPreview(),
      activePageId: state.activePageId,
      pageNavigation: state.pageNavigation
    });
  }

  function activePageIdFromContext() {
    const detected =
      typeof adapter.activePageId === "function"
        ? adapter.activePageId(documentRef)
        : adapter.extractPageId(globalScope.location?.href, globalScope.location?.href);
    if (detected) return detected;
    return adapter.normalizePageId(
      documentRef.documentElement?.getAttribute("data-nfs-demo-active-page-id")
    );
  }

  function restoreLegacyFavoritesInjection() {
    const hiddenAttribute = adapter.HIDDEN_ROW_ATTRIBUTE;
    const hostAttribute = adapter.HOST_ATTRIBUTE;
    if (hiddenAttribute) {
      for (const row of documentRef.querySelectorAll?.(`[${hiddenAttribute}]`) || []) {
        row.removeAttribute(hiddenAttribute);
      }
    }
    if (hostAttribute) {
      for (const host of documentRef.querySelectorAll?.(`[${hostAttribute}]`) || []) {
        host.remove();
      }
    }
  }

  function detachSurface() {
    try {
      state.treeView?.destroy();
    } catch (_error) {
      // The Notion SPA may already have removed the containing sidebar.
    }
    try {
      state.panelShell?.destroy();
    } catch (_error) {
      // The host may already be disconnected.
    }
    try {
      if (state.viewHost) adapter.restorePrimaryNavigationView(state.viewHost);
    } catch (_error) {
      state.viewHost?.remove?.();
    }
    try {
      if (state.menuHost) adapter.restorePrimaryNavigation(state.menuHost);
    } catch (_error) {
      state.menuHost?.remove?.();
    }
    state.menuHost = null;
    state.viewHost = null;
    state.panelShell = null;
    state.treeView = null;
    state.primaryInspection = null;
  }

  function createSurface(inspection) {
    const host = documentRef.createElement("div");
    host.className = "notion-tree-primary-navigation-root";
    host.setAttribute("aria-label", "Moa 메뉴");
    const mounted = adapter.mountPrimaryNavigationHost(inspection, host);
    if (!mounted) return false;

    const viewHost = documentRef.createElement("div");
    viewHost.className = "notion-tree-primary-navigation-view";
    viewHost.setAttribute("aria-label", "Moa 화면");
    const mountedView = adapter.mountPrimaryNavigationViewHost(inspection, viewHost);
    if (!mountedView) {
      adapter.restorePrimaryNavigation(mounted);
      return false;
    }

    try {
      const panelShell = panelModule.createPanelShell({
        host: mounted,
        viewHost: mountedView,
        nativeTab: inspection.selectedNativeTab,
        onOpenChange(open) {
          if (open) {
            scheduleRefresh();
            const workspaceKey = state.workspaceKey;
            if (workspaceKey) {
              enqueue(() => reloadStoredWorkspace(workspaceKey)).catch((error) => {
                console.warn("Moa could not refresh its stored workspace.", error);
              });
            }
          }
        }
      });
      const treeView = viewModule.createFavoriteTreeView({
        host: panelShell.contentHost,
        workspace: state.workspace || model.createWorkspace(),
        workspaceKey: state.workspaceKey,
        workspaceRevision: state.storageRevision,
        undoState: undoState(),
        favorites: state.favorites,
        favoriteMetadata: displayFavoriteMetadata(),
        callbacks: callbacks(),
        status: workspaceStatus(),
        importPreview: computeManagementPreview(),
        activePageId: state.activePageId,
        pageNavigation: state.pageNavigation
      });
      state.menuHost = mounted;
      state.viewHost = mountedView;
      state.panelShell = panelShell;
      state.treeView = treeView;
      state.primaryInspection = inspection;
      return true;
    } catch (error) {
      adapter.restorePrimaryNavigationView(mountedView);
      adapter.restorePrimaryNavigation(mounted);
      console.warn("Moa could not create its Moa panel.", error);
      return false;
    }
  }

  function ensureSurface() {
    let inspection = null;
    try {
      inspection = adapter.inspectPrimaryNavigation(documentRef);
    } catch (_error) {
      inspection = null;
    }
    if (!inspection?.scopeSafe) {
      detachSurface();
      state.sidebarRoot = null;
      return false;
    }

    state.sidebarRoot = inspection.sidebarRoot || state.sidebarRoot;
    const mounted = Boolean(
      state.menuHost?.isConnected &&
        state.menuHost.parentElement === inspection.container &&
        state.menuHost.previousElementSibling === inspection.inboxWrapper &&
        state.viewHost?.isConnected &&
        state.viewHost.parentElement === inspection.contentSurface &&
        state.panelShell &&
        state.panelShell.overlayHost === state.viewHost &&
        state.treeView &&
        state.primaryInspection?.inboxItem === inspection.inboxItem &&
        state.primaryInspection?.inboxWrapper === inspection.inboxWrapper &&
        state.primaryInspection?.selectedNativeTab === inspection.selectedNativeTab &&
        state.primaryInspection?.nativeTabpanel === inspection.nativeTabpanel &&
        state.primaryInspection?.contentSurface === inspection.contentSurface
    );
    if (!mounted) {
      detachSurface();
      return createSurface(inspection);
    }
    state.primaryInspection = inspection;
    renderCurrent();
    return true;
  }

  function revisionFromResponse(response) {
    if (!Number.isSafeInteger(response?.revision) || response.revision < 0) {
      throw new Error("확장 저장소 revision 응답이 올바르지 않습니다.");
    }
    return response.revision;
  }

  async function readWorkspaceRecord(workspaceKey) {
    const response = await sendStorageMessage(MESSAGE_TYPES.GET, { workspaceKey });
    return {
      revision: revisionFromResponse(response),
      workspace: response.workspace ? model.normalizeWorkspace(response.workspace) : null
    };
  }

  function legacyProfileCatalogFromResponse(response) {
    if (!Number.isSafeInteger(response?.revision) || response.revision < 0) {
      throw new Error("이전 프로필 저장소 revision 응답이 올바르지 않습니다.");
    }
    const catalog = response.catalog || profileModel.createProfileCatalog();
    profileModel.validateProfileCatalog(catalog);
    return catalog;
  }

  async function readSelectedLegacyWorkspace(baseWorkspaceKey) {
    try {
      const catalogResponse = await sendStorageMessage(MESSAGE_TYPES.PROFILE_GET, {});
      const catalog = legacyProfileCatalogFromResponse(catalogResponse);
      const selected = profileModel.selectedProfileForWorkspace(catalog, baseWorkspaceKey);
      if (!selected) return null;
      const legacyKey = profileModel.canonicalTreeKey(selected.id, baseWorkspaceKey);
      const legacy = await readWorkspaceRecord(legacyKey);
      return legacy.workspace ? { workspaceKey: legacyKey, ...legacy } : null;
    } catch (error) {
      console.warn("Moa could not inspect its previous profile data.", error);
      return null;
    }
  }

  function workspaceIdentity() {
    if (typeof adapter.deriveWorkspaceIdentity === "function") {
      return adapter.deriveWorkspaceIdentity(documentRef);
    }
    return { key: adapter.deriveWorkspaceKey(documentRef) || null, slugKey: null };
  }

  async function resolveWorkspaceContext(baseWorkspaceKey, slugKey) {
    if (!baseWorkspaceKey) {
      return {
        workspaceKey: null,
        workspace: model.createWorkspace(),
        revision: 0,
        storageReady: false
      };
    }
    const direct = await readWorkspaceRecord(baseWorkspaceKey);
    const legacy = await readSelectedLegacyWorkspace(baseWorkspaceKey);
    if (legacy) {
      return {
        workspaceKey: legacy.workspaceKey,
        workspace: legacy.workspace,
        revision: legacy.revision,
        storageReady: true
      };
    }
    // Prefer an already saved canonical tree. If the same current route now
    // exposes an ID, keep using its existing slug tree instead of silently
    // starting empty. No records are merged, copied, deleted, or overwritten.
    if (!direct.workspace && slugKey && slugKey !== baseWorkspaceKey) {
      const previous = await readWorkspaceRecord(slugKey);
      const previousLegacy = await readSelectedLegacyWorkspace(slugKey);
      const compatible = previousLegacy || (previous.workspace
        ? { workspaceKey: slugKey, ...previous }
        : null);
      if (compatible) {
        return { ...compatible, storageReady: true };
      }
    }
    return {
      workspaceKey: baseWorkspaceKey,
      workspace: direct.workspace || model.createWorkspace(),
      revision: direct.revision,
      storageReady: true
    };
  }

  async function ensureWorkspaceContext(baseWorkspaceKey, slugKey) {
    if (
      state.workspace &&
      state.baseWorkspaceKey === baseWorkspaceKey &&
      (state.storageReady || !baseWorkspaceKey)
    ) {
      return;
    }

    state.baseWorkspaceKey = baseWorkspaceKey;
    state.workspaceKey = baseWorkspaceKey;
    state.workspace = model.createWorkspace();
    state.storageRevision = 0;
    state.storageReady = false;
    state.undo = null;
    // Page titles and relationships are live, workspace-scoped view metadata.
    // Never carry the previous workspace's metadata into a new loading state.
    state.pageNavigation = emptyPageNavigation();
    state.favoriteMetadata = new Map();
    state.metadataSavedSignature = "";
    state.metadataSaveFailed = false;
    state.favorites = [];
    state.favoritesInspection = null;
    state.favoritesSection = null;
    state.sourceSignature = "";
    renderCurrent();
    try {
      const resolved = await resolveWorkspaceContext(baseWorkspaceKey, slugKey);
      if (state.baseWorkspaceKey !== baseWorkspaceKey) return;
      state.workspaceKey = resolved.workspaceKey;
      state.workspace = resolved.workspace;
      state.storageRevision = resolved.revision;
      state.storageReady = resolved.storageReady;
      await loadFavoriteMetadata(state.workspaceKey);
    } catch (error) {
      if (state.baseWorkspaceKey !== baseWorkspaceKey) return;
      state.workspaceKey = null;
      state.workspace = model.createWorkspace();
      state.storageRevision = 0;
      state.storageReady = false;
      console.warn("Moa could not load its workspace.", error);
    }
  }

  function scanFavoriteSource() {
    let inspection = null;
    try {
      inspection = adapter.inspectFavoritesSection(documentRef);
    } catch (_error) {
      inspection = null;
    }
    const usable = Boolean(
      inspection?.inSidebar === true &&
        inspection?.scopeSafe === true &&
        inspection?.topLevelSafe === true &&
        (inspection.confidence >= MINIMUM_CONFIDENCE || inspection.emptySafe === true)
    );
    let favorites = [];
    if (usable) {
      try {
        favorites = adapter.readFavorites(inspection.section);
      } catch (_error) {
        favorites = [];
      }
    }
    state.favoritesInspection = inspection;
    state.favoritesSection = usable ? inspection.section : null;
    state.favorites =
      usable && inspection.favoriteCount === favorites.length ? favorites : [];
    state.sourceSignature = stableSourceSignature(state.favorites);
    restoreLegacyFavoritesInjection();
  }

  function scanPageNavigation() {
    state.pageNavigation = emptyPageNavigation();
    if (!state.baseWorkspaceKey || typeof adapter.readPageNavigation !== "function") return;
    try {
      const navigation = adapter.readPageNavigation(documentRef, {
        activePageId: state.activePageId,
        favorites: [...state.favorites, ...displayFavoriteMetadata()]
      });
      if (navigation && Array.isArray(navigation.roots)) state.pageNavigation = navigation;
    } catch (_error) {
      // Partial/unavailable Notion DOM must not leave stale links on screen.
    }
  }

  async function refreshFromNotion() {
    state.activePageId = activePageIdFromContext();
    const identity = workspaceIdentity();
    await ensureWorkspaceContext(identity.key, identity.slugKey);
    if (workspaceIdentity().key !== identity.key) {
      state.pageNavigation = emptyPageNavigation();
      scheduleRefresh();
      return;
    }
    state.activePageId = activePageIdFromContext();
    scanFavoriteSource();
    scanPageNavigation();
    rememberFavoriteMetadata();
    if ([...workspaceFavoriteMap().keys()].some(pageId => !state.favoriteMetadata.has(pageId))) {
      // A different tab may commit the tree before its display cache arrives.
      await loadFavoriteMetadata(state.workspaceKey);
    }
    ensureSurface();
    renderCurrent();
    const hadMetadataFailure = state.metadataSaveFailed;
    await saveFavoriteMetadata();
    if (hadMetadataFailure !== state.metadataSaveFailed) renderCurrent();
  }

  function workspaceFromConflict(error, workspaceKey) {
    const response = error?.response;
    if (
      !response?.conflict ||
      !Number.isSafeInteger(response.revision) ||
      workspaceKey !== state.workspaceKey
    ) {
      return null;
    }
    state.storageRevision = response.revision;
    state.storageReady = true;
    return response.workspace
      ? model.normalizeWorkspace(response.workspace)
      : model.createWorkspace();
  }

  async function latestWorkspaceForMutation(workspaceKey) {
    const response = await sendStorageMessage(MESSAGE_TYPES.GET, { workspaceKey });
    return {
      revision: revisionFromResponse(response),
      workspace: response.workspace
        ? model.normalizeWorkspace(response.workspace)
        : model.createWorkspace()
    };
  }

  async function persistWorkspace(workspaceKey, workspace, expectedRevision) {
    const response = await sendStorageMessage(MESSAGE_TYPES.SET, {
      workspaceKey,
      workspace,
      expectedRevision
    });
    return {
      revision: revisionFromResponse(response),
      workspace: response.workspace || workspace
    };
  }

  async function reloadStoredWorkspace(workspaceKey) {
    if (!workspaceKey) return;
    const stored = await readWorkspaceRecord(workspaceKey);
    if (workspaceKey !== state.workspaceKey) return;
    state.workspace = stored.workspace || model.createWorkspace();
    state.storageRevision = stored.revision;
    if (state.undo?.revision !== stored.revision) state.undo = null;
    state.storageReady = true;
    await loadFavoriteMetadata(workspaceKey);
    rememberFavoriteMetadata();
    renderCurrent();
  }

  function assertLiveWorkspace(workspaceKey, sourceSignature) {
    if (workspaceKey !== state.workspaceKey) {
      throw new Error("워크스페이스가 변경되었습니다. 다시 시도해 주세요.");
    }
    const liveBaseKey = workspaceIdentity().key;
    if (liveBaseKey !== state.baseWorkspaceKey) {
      throw new Error("Notion 워크스페이스가 변경되었습니다. 다시 시도해 주세요.");
    }
    if (sourceSignature !== undefined) {
      // Re-read the DOM at the mutation boundary. An observer callback may
      // still be queued while the asynchronous storage GET was pending.
      scanFavoriteSource();
      if (!favoritesSourceIsSafe() || sourceSignature !== state.sourceSignature) {
        renderCurrent();
        throw new Error("Notion 즐겨찾기 목록이 변경되었습니다. 다시 시도해 주세요.");
      }
    }
  }

  async function mutateWorkspaceNow(operation, options = {}) {
    const workspaceKey = Object.prototype.hasOwnProperty.call(
      options,
      "workspaceKey"
    )
      ? options.workspaceKey
      : state.workspaceKey;
    if (!workspaceKey || !state.workspace) {
      throw new Error("Favorite 트리가 아직 준비되지 않았습니다.");
    }
    assertLiveWorkspace(workspaceKey, options.sourceSignature);
    let latest;
    try {
      latest = await latestWorkspaceForMutation(workspaceKey);
    } catch (error) {
      if (workspaceKey === state.workspaceKey) state.storageReady = false;
      renderCurrent();
      throw error;
    }

    assertLiveWorkspace(workspaceKey, options.sourceSignature);
    if (
      options.expectedRevision !== undefined &&
      latest.revision !== options.expectedRevision
    ) {
      state.workspace = latest.workspace;
      state.storageRevision = latest.revision;
      state.storageReady = true;
      state.undo = null;
      renderCurrent();
      throw new Error("확인하는 동안 다른 Notion 탭에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 시도해 주세요.");
    }
    const next = operation(latest.workspace);
    model.assertValidWorkspace(next);
    const previousUndo = state.undo;
    let continuedUndo = null;
    if (
      options.preserveUndo && previousUndo &&
      previousUndo.workspaceKey === workspaceKey &&
      previousUndo.revision === latest.revision
    ) {
      const snapshot = model.normalizeWorkspace(previousUndo.workspace);
      if (options.preserveUndo === "fold") {
        // Preserve the user's current disclosure choices without copying any
        // added/deleted structure into the snapshot of their meaningful edit.
        const nextGroups = new Map(next.groups.map((group) => [group.id, group]));
        const nextSections = new Map(next.groups.flatMap((group) => group.sections.map((section) => [section.id, section])));
        for (const group of snapshot.groups) {
          if (nextGroups.has(group.id)) group.collapsed = nextGroups.get(group.id).collapsed;
          for (const section of group.sections) {
            if (nextSections.has(section.id)) section.collapsed = nextSections.get(section.id).collapsed;
          }
        }
        continuedUndo = { ...previousUndo, workspace: snapshot };
      } else if (options.preserveUndo === "refresh") {
        continuedUndo = { ...previousUndo, workspace: operation(snapshot) };
      }
    }
    if (JSON.stringify(next) === JSON.stringify(latest.workspace)) {
      state.workspace = latest.workspace;
      state.storageRevision = latest.revision;
      if (state.undo?.revision !== latest.revision) state.undo = null;
      renderCurrent();
      return state.workspace;
    }

    try {
      const saved = await persistWorkspace(workspaceKey, next, latest.revision);
      // A source change after a completed write cannot undo that commit.
      // Check only identity here, so a successful add is not reported failed.
      assertLiveWorkspace(workspaceKey);
      state.workspace = model.normalizeWorkspace(saved.workspace);
      state.storageRevision = saved.revision;
      state.storageReady = true;
      state.undo = options.undoLabel ? {
        workspaceKey,
        revision: saved.revision,
        workspace: latest.workspace,
        label: options.undoLabel
      } : continuedUndo ? { ...continuedUndo, revision: saved.revision } : null;
      rememberFavoriteMetadata();
      renderCurrent();
      await saveFavoriteMetadata();
      return state.workspace;
    } catch (error) {
      const conflicted = workspaceFromConflict(error, workspaceKey);
      if (workspaceKey === state.workspaceKey) {
        state.workspace = conflicted || latest.workspace;
        state.undo = null;
        if (!conflicted) state.storageReady = false;
      }
      if (conflicted) {
        error.message =
          "다른 Notion 탭에서 먼저 변경되었습니다. 최신 상태를 반영했으니 다시 시도해 주세요.";
      }
      renderCurrent();
      throw error;
    }
  }

  function mutateWorkspace(operation, options) {
    return enqueue(() => mutateWorkspaceNow(operation, options));
  }

  async function runBusy(operation) {
    if (state.busy) throw new Error("진행 중인 작업이 끝난 뒤 다시 시도해 주세요.");
    state.busy = true;
    renderCurrent();
    try {
      return await operation();
    } finally {
      state.busy = false;
      renderCurrent();
    }
  }

  function addFavorite(pageId) {
    scanFavoriteSource();
    renderCurrent();
    const workspaceKey = state.workspaceKey;
    const sourceSignature = state.sourceSignature;
    const normalizedPageId = adapter.normalizePageId(pageId);
    if (
      !normalizedPageId ||
      !favoritesSourceIsSafe() ||
      !state.favorites.some((favorite) => favorite.pageId === normalizedPageId)
    ) {
      throw new Error("현재 Notion 즐겨찾기에서 이 페이지를 확인할 수 없습니다.");
    }
    return runBusy(async () => {
      const result = await mutateWorkspace(
        (workspace) => model.addFavorite(workspace, normalizedPageId),
        { workspaceKey, sourceSignature, undoLabel: "즐겨찾기 추가 되돌리기" }
      );
      state.treeView?.announce("Favorite를 Moa에 추가했습니다.");
      return result;
    });
  }

  function addFavorites(pageIds, sectionId) {
    scanFavoriteSource();
    renderCurrent();
    const workspaceKey = state.workspaceKey;
    const sourceSignature = state.sourceSignature;
    const normalizedPageIds = Array.isArray(pageIds)
      ? [
          ...new Set(
            pageIds
              .map((pageId) => adapter.normalizePageId(pageId))
              .filter(Boolean)
          )
        ]
      : [];
    const sourceIds = new Set(
      state.favorites.map((favorite) => String(favorite.pageId))
    );
    if (
      normalizedPageIds.length === 0 ||
      typeof sectionId !== "string" ||
      !sectionId.trim() ||
      !favoritesSourceIsSafe() ||
      normalizedPageIds.some((pageId) => !sourceIds.has(pageId))
    ) {
      throw new Error(
        "선택한 페이지와 목적지를 현재 Notion 즐겨찾기에서 확인할 수 없습니다."
      );
    }
    return runBusy(async () => {
      let addedCount = 0;
      const result = await mutateWorkspace(
        (workspace) => {
          const existing = workspaceFavoriteMap(workspace);
          const newPageIds = normalizedPageIds.filter((pageId) => !existing.has(pageId));
          addedCount = newPageIds.length;
          // A concurrent tab may already have placed an item elsewhere. Keep
          // its destination and report it as skipped, not added to this section.
          return newPageIds.length ? model.addFavorites(workspace, newPageIds, {
            sectionId: sectionId.trim()
          }) : workspace;
        },
        { workspaceKey, sourceSignature, undoLabel: "즐겨찾기 추가 되돌리기" }
      );
      return { workspace: result, addedCount, skippedCount: normalizedPageIds.length - addedCount };
    });
  }

  function observedMutationOptions(options = {}) {
    return {
      workspaceKey: options.workspaceKey === undefined ? state.workspaceKey : options.workspaceKey,
      expectedRevision: options.expectedRevision === undefined
        ? state.storageRevision
        : options.expectedRevision
    };
  }

  function removeFavorite(pageId, options) {
    const observed = observedMutationOptions(options);
    return runBusy(async () => {
      const result = await mutateWorkspace(
        (workspace) => model.removeFavorite(workspace, pageId),
        { ...observed, undoLabel: "즐겨찾기 제거 되돌리기" }
      );
      state.treeView?.announce("Favorite를 Moa에서 제거했습니다.");
      return result;
    });
  }

  function refreshManagedFavorites() {
    if (!state.workspaceKey) {
      throw new Error("현재 Notion 워크스페이스를 확인한 뒤 다시 시도해 주세요.");
    }
    return runBusy(() =>
      enqueue(async () => {
        const requestedWorkspaceKey = state.workspaceKey;
        await refreshFromNotion();
        if (
          requestedWorkspaceKey !== state.workspaceKey ||
          !state.storageReady ||
          !favoritesSourceIsSafe()
        ) {
          throw new Error("Notion 즐겨찾기를 안전하게 확인하지 못해 새로고침을 중지했습니다.");
        }
        const sourceSignature = state.sourceSignature;
        const sourceIds = new Set(state.favorites.map((favorite) => favorite.pageId));
        const result = await mutateWorkspaceNow(
          (workspace) => {
            // DOM visibility is not proof of removal. Notion can virtualize or
            // limit this list, so only positively observed records are updated.
            const next = model.normalizeWorkspace(workspace);
            const now = new Date().toISOString();
            for (const favorite of workspaceFavoriteMap(next).values()) {
              if (sourceIds.has(favorite.pageId)) {
                favorite.dormant = false;
                favorite.updatedAt = now;
              }
            }
            return next;
          },
          { workspaceKey: requestedWorkspaceKey, sourceSignature, preserveUndo: "refresh" }
        );
        return result;
      })
    );
  }

  function resetTree(options) {
    const observed = observedMutationOptions(options);
    return runBusy(async () => {
      const result = await mutateWorkspace(() => model.createWorkspace(), {
        ...observed,
        undoLabel: "트리 초기화 되돌리기"
      });
      state.treeView?.announce("Moa를 초기화했습니다.");
      return result;
    });
  }

  function mutateDisplayedWorkspace(operation, undoLabel, options) {
    const workspaceKey = state.workspaceKey;
    return mutateWorkspace(operation, {
      workspaceKey,
      ...(options || {}),
      undoLabel
    });
  }

  function undoLastMutation() {
    const snapshot = state.undo;
    if (!snapshot || !undoState().canUndo) {
      throw new Error("되돌릴 변경이 없거나 다른 탭에서 트리가 변경되었습니다.");
    }
    return runBusy(() => mutateWorkspace(() => model.normalizeWorkspace(snapshot.workspace), {
      workspaceKey: snapshot.workspaceKey,
      expectedRevision: snapshot.revision
    }));
  }

  function callbacks() {
    return {
      onAddFavorite: addFavorite,
      onAddFavorites: addFavorites,
      onRemoveFavorite: removeFavorite,
      onRefreshManagedFavorites: refreshManagedFavorites,
      onResetTree: resetTree,
      onUndo: undoLastMutation,
      onCreateGroup(name) {
        return mutateDisplayedWorkspace((workspace) => model.createGroup(workspace, { name }), "그룹 만들기 되돌리기");
      },
      onRenameGroup(groupId, name) {
        return mutateDisplayedWorkspace((workspace) => model.renameGroup(workspace, groupId, name), "그룹 이름 변경 되돌리기");
      },
      onToggleGroup(groupId) {
        return mutateDisplayedWorkspace((workspace) => model.toggleGroup(workspace, groupId), undefined, { preserveUndo: "fold" });
      },
      onDeleteGroup(groupId, options) {
        return mutateDisplayedWorkspace((workspace) => model.deleteGroup(workspace, groupId), "그룹 삭제 되돌리기", observedMutationOptions(options));
      },
      onMoveGroup(groupId, position) {
        return mutateDisplayedWorkspace((workspace) => model.moveGroup(workspace, groupId, position), "그룹 이동 되돌리기");
      },
      onCreateSection(groupId, name) {
        return mutateDisplayedWorkspace((workspace) =>
          model.createSection(workspace, groupId, { name }), "섹션 만들기 되돌리기"
        );
      },
      onRenameSection(sectionId, name) {
        return mutateDisplayedWorkspace((workspace) =>
          model.renameSection(workspace, sectionId, name), "섹션 이름 변경 되돌리기"
        );
      },
      onToggleSection(sectionId) {
        return mutateDisplayedWorkspace((workspace) => model.toggleSection(workspace, sectionId), undefined, { preserveUndo: "fold" });
      },
      onDeleteSection(sectionId, options) {
        return mutateDisplayedWorkspace((workspace) => model.deleteSection(workspace, sectionId), "섹션 삭제 되돌리기", observedMutationOptions(options));
      },
      onMoveSection(sectionId, targetGroupId, position) {
        return mutateDisplayedWorkspace((workspace) =>
          model.moveSection(workspace, sectionId, targetGroupId, position), "섹션 이동 되돌리기"
        );
      },
      onMoveFavorite(pageId, targetSectionId, position) {
        return mutateDisplayedWorkspace((workspace) =>
          model.moveFavorite(workspace, pageId, targetSectionId, position), "즐겨찾기 이동 되돌리기"
        );
      },
      onMoveFavoriteToGroup(pageId, targetGroupId) {
        return mutateDisplayedWorkspace((workspace) =>
          model.moveFavorite(workspace, pageId, model.getSystemSectionId(targetGroupId)), "즐겨찾기 이동 되돌리기"
        );
      }
    };
  }

  function scheduleRefresh() {
    if (state.destroyed) return;
    if (state.refreshTimer !== null) globalScope.clearTimeout(state.refreshTimer);
    state.refreshTimer = globalScope.setTimeout(() => {
      state.refreshTimer = null;
      enqueue(refreshFromNotion).catch((error) => {
        console.warn("Moa could not refresh its Notion context.", error);
        renderCurrent();
      });
    }, REFRESH_DELAY_MS);
  }

  function nodeContains(container, node) {
    return Boolean(
      container && node && typeof container.contains === "function" && container.contains(node)
    );
  }

  function mutationTouchesSidebar(mutation) {
    if (
      nodeContains(state.menuHost, mutation.target) ||
      nodeContains(state.viewHost, mutation.target)
    ) {
      return false;
    }
    // A non-favorite page can change its title without touching the sidebar.
    const title = documentRef.querySelector?.("title");
    if (title && nodeContains(title, mutation.target)) return true;
    const sidebarRoot = state.sidebarRoot;
    // The shell may exist before Notion assigns role/label/style attributes.
    // Recover after those attribute-only changes even with no mounted sidebar.
    if (!sidebarRoot) return mutation.type === "childList" || mutation.type === "attributes";
    const target = mutation.target;
    if (nodeContains(sidebarRoot, target) || nodeContains(target, sidebarRoot)) return true;
    if (mutation.type !== "childList") return false;
    return [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some(
      (node) =>
        node === sidebarRoot ||
        nodeContains(node, sidebarRoot) ||
        nodeContains(sidebarRoot, node)
    );
  }

  function startObserver() {
    if (typeof globalScope.MutationObserver !== "function") return;
    const root = documentRef.documentElement || documentRef.body;
    if (!root) return;
    state.observer = new globalScope.MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesSidebar)) scheduleRefresh();
    });
    state.observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "href",
        "aria-label",
        "aria-current",
        "aria-selected",
        "aria-expanded",
        "aria-hidden",
        "aria-controls",
        "aria-labelledby",
        "data-active",
        "data-workspace-id",
        "data-space-id",
        "data-nfs-demo-active-page-id",
        "hidden",
        "style",
        "class",
        "id",
        "role"
      ]
    });
  }

  function connectWorkspaceSync() {
    if (state.destroyed || state.syncPort) return;
    const runtime = globalScope.chrome?.runtime;
    if (!runtime || typeof runtime.connect !== "function") return;
    try {
      const port = runtime.connect({ name: "NFS_WORKSPACE_SYNC" });
      state.syncPort = port;
      port.onMessage.addListener((message) => {
        if (
          message?.type !== "NFS_STORAGE_CHANGED" ||
          message.payload?.workspaceKey !== state.workspaceKey ||
          !Number.isSafeInteger(message.payload.revision) ||
          (!message.payload.reset && !message.payload.workspace)
        ) {
          return;
        }
        const workspaceKey = message.payload.workspaceKey;
        enqueue(async () => {
          if (workspaceKey !== state.workspaceKey) return;
          if (!message.payload.reset && message.payload.revision <= state.storageRevision) return;
          state.workspace = message.payload.reset
            ? model.createWorkspace()
            : model.normalizeWorkspace(message.payload.workspace);
          state.storageRevision = message.payload.revision;
          if (state.undo?.revision !== state.storageRevision) state.undo = null;
          state.storageReady = true;
          await loadFavoriteMetadata(workspaceKey);
          rememberFavoriteMetadata();
          renderCurrent();
        }).catch((error) => {
          console.warn("Moa rejected a sync update.", error);
        });
      });
      port.onDisconnect.addListener(() => {
        if (state.syncPort === port) state.syncPort = null;
        if (!state.destroyed && state.reconnectTimer === null) {
          state.reconnectTimer = globalScope.setTimeout(() => {
            state.reconnectTimer = null;
            connectWorkspaceSync();
          }, 1_000);
        }
      });
      const workspaceKey = state.workspaceKey;
      if (workspaceKey) {
        enqueue(() => reloadStoredWorkspace(workspaceKey)).catch((error) => {
          console.warn("Moa could not resync after reconnecting.", error);
        });
      }
    } catch (_error) {
      state.syncPort = null;
    }
  }

  function onVisibilityChange() {
    if (documentRef.visibilityState === "visible") scheduleRefresh();
  }

  function startRouteWatch() {
    if (typeof globalScope.setInterval !== "function") return;
    // pushState/replaceState do not emit popstate in an SPA. Watch only the URL,
    // without patching Notion's history methods or reading page bodies.
    state.routeTimer = globalScope.setInterval(() => {
      if (state.destroyed || documentRef.visibilityState === "hidden") return;
      const href = globalScope.location?.href || "";
      if (href === state.observedHref) return;
      state.observedHref = href;
      scheduleRefresh();
    }, 1000);
  }

  function onPageHide(event) {
    if (!event.persisted) cleanup();
  }

  function cleanup() {
    if (state.destroyed) return;
    state.destroyed = true;
    if (state.refreshTimer !== null) globalScope.clearTimeout(state.refreshTimer);
    if (state.reconnectTimer !== null) globalScope.clearTimeout(state.reconnectTimer);
    if (state.routeTimer !== null) globalScope.clearInterval?.(state.routeTimer);
    state.refreshTimer = null;
    state.reconnectTimer = null;
    state.routeTimer = null;
    state.observer?.disconnect();
    try {
      state.syncPort?.disconnect();
    } catch (_error) {
      // The extension context may already be invalidated.
    }
    state.syncPort = null;
    detachSurface();
    restoreLegacyFavoritesInjection();
    adapter.restorePrimaryNavigationView();
    adapter.restorePrimaryNavigation();
    state.sidebarRoot = null;
    globalScope.removeEventListener("popstate", scheduleRefresh);
    globalScope.removeEventListener("hashchange", scheduleRefresh);
    globalScope.removeEventListener("pageshow", scheduleRefresh);
    globalScope.removeEventListener("pagehide", onPageHide);
    documentRef.removeEventListener("visibilitychange", onVisibilityChange);
  }

  namespace.content = Object.freeze({
    started: true,
    refresh: () => enqueue(refreshFromNotion),
    cleanup
  });
  globalScope.NotionFavoriteSections = namespace;

  restoreLegacyFavoritesInjection();
  startObserver();
  startRouteWatch();
  connectWorkspaceSync();
  globalScope.addEventListener("popstate", scheduleRefresh);
  globalScope.addEventListener("hashchange", scheduleRefresh);
  globalScope.addEventListener("pageshow", scheduleRefresh);
  globalScope.addEventListener("pagehide", onPageHide);
  documentRef.addEventListener("visibilitychange", onVisibilityChange);
  scheduleRefresh();
})(globalThis);
