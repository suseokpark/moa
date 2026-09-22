import assert from "node:assert/strict";
import test from "node:test";

await import("../src/notion-sidebar-adapter.js");

const adapter = globalThis.NotionFavoriteSections?.adapter;
const COMPACT_ID = "0123456789abcdef0123456789abcdef";
const UUID_ID = "01234567-89AB-CDEF-0123-456789ABCDEF";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
const CHILD_ID = "11111111111111111111111111111111";
const HIDDEN_ID = "22222222222222222222222222222222";
let primaryFixtureSequence = 0;

test("content-script IIFE exposes the adapter without module imports", () => {
  assert.ok(adapter);
  for (const method of [
    "extractPageId",
    "activePageId",
    "normalizePageId",
    "isAllowedNotionUrl",
    "locateFavoritesSection",
    "readFavorites",
    "inspectNavigationTrees",
    "readNavigationTrees",
    "readPageNavigation",
    "deriveWorkspaceKey",
    "inspectPrimaryNavigation",
    "mountHost",
    "mountPrimaryNavigationHost",
    "mountPrimaryNavigationViewHost",
    "setNativeRowsVisible",
    "restore",
    "restorePrimaryNavigation",
    "restorePrimaryNavigationView",
  ]) {
    assert.equal(typeof adapter[method], "function", method);
  }
  assert.equal(
    adapter.HIDDEN_ROW_ATTRIBUTE,
    "data-notion-favorite-sections-native-hidden",
  );
  assert.equal(
    adapter.PRIMARY_NAV_HOST_ATTRIBUTE,
    "data-notion-tree-primary-navigation-host",
  );
  assert.equal(
    adapter.PRIMARY_NAV_VIEW_HOST_ATTRIBUTE,
    "data-notion-tree-primary-navigation-view-host",
  );
  assert.equal(Object.isFrozen(adapter), true);
});

test("normalizePageId canonicalizes compact and UUID-shaped Notion IDs", () => {
  assert.equal(adapter.normalizePageId(COMPACT_ID.toUpperCase()), COMPACT_ID);
  assert.equal(adapter.normalizePageId(`  ${UUID_ID}  `), COMPACT_ID);
});

test("normalizePageId rejects partial, decorated, and non-string values", () => {
  assert.equal(adapter.normalizePageId(COMPACT_ID.slice(1)), null);
  assert.equal(adapter.normalizePageId(`page-${COMPACT_ID}`), null);
  assert.equal(adapter.normalizePageId(`{${UUID_ID}}`), null);
  assert.equal(adapter.normalizePageId(123), null);
  assert.equal(adapter.normalizePageId(null), null);
});

test("extractPageId parses canonical, slugged, UUID, query, and hash URLs", () => {
  const cases = [
    [`https://app.notion.com/${COMPACT_ID}`, COMPACT_ID],
    [`https://app.notion.com/acme/Planning-${COMPACT_ID}?pvs=4`, COMPACT_ID],
    [`https://app.notion.com/acme/Planning_${UUID_ID}#notes`, COMPACT_ID],
    [`https://app.notion.com/acme/${UUID_ID.toLowerCase()}`, COMPACT_ID],
  ];

  for (const [href, expected] of cases) {
    assert.equal(adapter.extractPageId(href), expected, href);
  }
});

test("extractPageId resolves relative links only against an app.notion.com base", () => {
  assert.equal(
    adapter.extractPageId(`Planning-${COMPACT_ID}`, "https://app.notion.com/acme/"),
    COMPACT_ID,
  );
  assert.equal(
    adapter.extractPageId(`Planning-${COMPACT_ID}`, "https://example.com/acme/"),
    null,
  );
});

test("URL checks reject other origins, unsafe protocols, credentials, ports, and query-only IDs", () => {
  const rejected = [
    `https://www.notion.so/Planning-${COMPACT_ID}`,
    `https://notion.site/Planning-${COMPACT_ID}`,
    `http://app.notion.com/Planning-${COMPACT_ID}`,
    `https://user@app.notion.com/Planning-${COMPACT_ID}`,
    `https://app.notion.com:444/Planning-${COMPACT_ID}`,
    `javascript:https://app.notion.com/Planning-${COMPACT_ID}`,
    `https://app.notion.com/search?id=${COMPACT_ID}`,
    `https://app.notion.com/${COMPACT_ID}/settings`,
    `https://app.notion.com/Page${COMPACT_ID}`,
    `https://app.notion.com/`,
  ];

  for (const href of rejected) {
    assert.equal(adapter.extractPageId(href), null, href);
    assert.equal(adapter.isAllowedNotionUrl(href), false, href);
  }
});

test("encoded path separators cannot smuggle a page ID into the last segment", () => {
  const href = `https://app.notion.com/acme%2FPlanning-${COMPACT_ID}`;
  assert.equal(adapter.extractPageId(href), null);
});

test("isAllowedNotionUrl requires both the exact origin and a path page ID", () => {
  assert.equal(
    adapter.isAllowedNotionUrl(`https://app.notion.com/acme/Page-${COMPACT_ID}`),
    true,
  );
  assert.equal(adapter.isAllowedNotionUrl("https://app.notion.com/login"), false);
});

test("activePageId parses the current app.notion.com document or location", () => {
  assert.equal(
    adapter.activePageId({
      location: {
        href: `https://app.notion.com/acme/Roadmap-${UUID_ID}?pvs=4#today`,
      },
    }),
    COMPACT_ID,
  );
  assert.equal(
    adapter.activePageId({
      origin: "https://app.notion.com",
      pathname: `/acme/Decisions-${OTHER_ID}`,
      search: "?pvs=4",
    }),
    OTHER_ID,
  );
  assert.equal(
    adapter.activePageId(
      { href: `https://app.notion.com/acme/Page-${COMPACT_ID}` },
      { href: `https://app.notion.com/acme/Page-${OTHER_ID}` },
    ),
    OTHER_ID,
  );
});

test("activePageId fails closed outside a current Notion page route", () => {
  for (const locationLike of [
    { href: `https://example.com/Page-${COMPACT_ID}` },
    { href: "https://app.notion.com/login" },
    { href: `https://app.notion.com/search?q=${COMPACT_ID}` },
    null,
  ]) {
    assert.equal(adapter.activePageId(locationLike), null);
  }
});

test("normalizeTitle removes invisible characters and collapses whitespace", () => {
  assert.equal(
    adapter.normalizeTitle("  Project\u200B\n\t Alpha\u00a0 "),
    "Project Alpha",
  );
  assert.equal(adapter.normalizeTitle(null), "");
  assert.equal(adapter.normalizeTitle(" 👩🏽‍💻 개발 "), "👩🏽‍💻 개발");
});

test("dedupeFavorites keeps first order and merges missing safe metadata", () => {
  const result = adapter.dedupeFavorites([
    {
      pageId: COMPACT_ID,
      title: "",
      url: `https://app.notion.com/Page-${COMPACT_ID}`,
    },
    {
      pageId: UUID_ID,
      title: "Roadmap",
      icon: "🗺️",
    },
    {
      href: `https://app.notion.com/Other-${OTHER_ID}`,
      title: "Other",
    },
  ]);

  assert.deepEqual(
    result.map((favorite) => favorite.pageId),
    [COMPACT_ID, OTHER_ID],
  );
  assert.equal(result[0].title, "Roadmap");
  assert.equal(result[0].icon, "🗺️");
  assert.equal(result[1].title, "Other");
});

test("dedupeFavorites never carries an external href into render metadata", () => {
  const [favorite] = adapter.dedupeFavorites([
    {
      pageId: COMPACT_ID,
      title: "Safe title",
      href: `https://evil.example/${COMPACT_ID}`,
    },
  ]);

  assert.equal(favorite.pageId, COMPACT_ID);
  assert.equal(favorite.href, null);
  assert.equal(favorite.url, null);
});

test("deriveWorkspaceKey uses a stable DOM workspace ID before the URL slug", () => {
  const documentLike = fakeDocument({
    rootAttributes: { "data-workspace-id": UUID_ID },
    href: `https://app.notion.com/acme/Page-${OTHER_ID}`,
  });

  assert.equal(
    adapter.deriveWorkspaceKey(documentLike),
    `workspace:id:${COMPACT_ID}`,
  );
});

test("deriveWorkspaceKey accepts a single unambiguous exposed workspace token", () => {
  const documentLike = fakeDocument({
    attributedNodes: [fakeNode({ "data-space-id": "team_alpha" })],
    href: `https://app.notion.com/acme/Page-${COMPACT_ID}`,
  });

  assert.equal(
    adapter.deriveWorkspaceKey(documentLike),
    "workspace:id:team_alpha",
  );
});

test("deriveWorkspaceKey selects one explicitly active workspace among several", () => {
  const documentLike = fakeDocument({
    attributedNodes: [
      fakeNode({ "data-space-id": "team_alpha" }),
      fakeNode({ "data-space-id": "team_beta", "aria-current": "true" }),
    ],
    href: `https://app.notion.com/acme/Page-${COMPACT_ID}`,
  });

  assert.equal(
    adapter.deriveWorkspaceKey(documentLike),
    "workspace:id:team_beta",
  );
});

test("deriveWorkspaceKey falls back to a two-segment Notion workspace slug", () => {
  assert.equal(
    adapter.deriveWorkspaceKey({
      href: `https://app.notion.com/Acme%20Team/Roadmap-${COMPACT_ID}`,
    }),
    "workspace:slug:acme-team",
  );
});

test("deriveWorkspaceKey recognizes the exact /p/workspace/page Notion route", () => {
  const documentLike = fakeDocument({
    href: `https://app.notion.com/p/acme/Planning-${COMPACT_ID}?pvs=4#current`,
  });

  assert.equal(
    adapter.deriveWorkspaceKey(documentLike),
    "workspace:slug:acme",
  );
  assert.equal(
    adapter.deriveWorkspaceKey({
      href: `https://app.notion.com/p/Acme%20Team/Roadmap-${OTHER_ID}`,
    }),
    "workspace:slug:acme-team",
  );
});

test("/p workspace fallback requires the exact HTTPS app.notion.com origin", () => {
  const rejected = [
    `http://app.notion.com/p/acme/Planning-${COMPACT_ID}`,
    `https://example.com/p/acme/Planning-${COMPACT_ID}`,
    `https://user@app.notion.com/p/acme/Planning-${COMPACT_ID}`,
    `https://app.notion.com:444/p/acme/Planning-${COMPACT_ID}`,
  ];

  for (const href of rejected) {
    assert.equal(adapter.deriveWorkspaceKey({ href }), null, href);
  }
});

test("/p workspace fallback rejects incomplete and ambiguous route shapes", () => {
  const rejected = [
    `https://app.notion.com/p/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p//Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/acme/extra/Planning-${COMPACT_ID}`,
    `https://app.notion.com/P/acme/Planning-${COMPACT_ID}`,
    `https://app.notion.com/%70/acme/Planning-${COMPACT_ID}`,
    `https://app.notion.com/x/acme/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/acme/not-a-page`,
    `https://app.notion.com/p/acme/Planning-${COMPACT_ID}/`,
  ];

  for (const href of rejected) {
    assert.equal(adapter.deriveWorkspaceKey({ href }), null, href);
  }
});

test("workspace route slugs reject reserved, page-like, and traversal values", () => {
  const rejected = [
    `https://app.notion.com/p/settings/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/p/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/${OTHER_ID}/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/-acme/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/acme_/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/ac@me/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/acme%2Fother/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/acme%5Cother/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/acme%2F..%2Fother/Planning-${COMPACT_ID}`,
    `https://app.notion.com/p/acme/%2e%2e/Planning-${COMPACT_ID}`,
  ];

  for (const href of rejected) {
    assert.equal(adapter.deriveWorkspaceKey({ href }), null, href);
  }
});

test("deriveWorkspaceKey fails closed for page-only, reserved, and external locations", () => {
  const locations = [
    { href: `https://app.notion.com/${COMPACT_ID}` },
    { href: `https://app.notion.com/settings/Page-${COMPACT_ID}` },
    { href: `https://example.com/acme/Page-${COMPACT_ID}` },
    { href: "https://app.notion.com/login" },
  ];

  for (const locationLike of locations) {
    assert.equal(adapter.deriveWorkspaceKey(locationLike), null, locationLike.href);
  }
});

test("readNavigationTrees reads rendered Private and Teamspaces hierarchy", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );

  const privateSection = navigationSection("Private", documentLike);
  const privateList = new FakeElement("ul", { role: "tree" }, "", documentLike);
  privateList.append(
    favoriteRow(COMPACT_ID, "Roadmap", documentLike, {
      tagName: "li",
      attributes: { role: "treeitem", "aria-level": "1" },
    }),
    favoriteRow(OTHER_ID, "Decisions", documentLike, {
      tagName: "li",
      attributes: { role: "treeitem", "aria-level": "1" },
    }),
  );
  privateSection.append(privateList);

  const teamspaceSection = navigationSection("Teamspaces", documentLike);
  const teamspaceList = new FakeElement("ul", { role: "tree" }, "", documentLike);
  const teamspacePage = favoriteRow(OTHER_ID.toUpperCase(), "Platform", documentLike, {
    tagName: "li",
    attributes: { role: "treeitem", "aria-level": "1" },
  });
  const childPage = favoriteRow(CHILD_ID, "Launch", documentLike, {
    tagName: "li",
    attributes: { role: "treeitem", "aria-level": "2" },
  });
  teamspacePage.append(childPage);
  teamspaceList.append(teamspacePage);
  teamspaceSection.append(teamspaceList);

  // Use a distinct Teamspace page ID so source ownership is unambiguous.
  teamspacePage.querySelectorAll("a[href]")[0].setAttribute(
    "href",
    `https://app.notion.com/Platform-${HIDDEN_ID}`,
  );
  sidebar.append(privateSection, teamspaceSection);
  documentLike.body.append(sidebar);

  const result = adapter.readNavigationTrees(documentLike);
  assert.equal(result.scopeSafe, true);
  assert.equal(result.inSidebar, true);
  assert.equal(result.renderedOnly, true);
  assert.ok(result.confidence >= 0.7);
  assert.equal(result.pageCount, 4);
  assert.deepEqual(
    result.personal.map((node) => [node.id, node.title, node.sourceKind]),
    [
      [COMPACT_ID, "Roadmap", "private"],
      [OTHER_ID, "Decisions", "private"],
    ],
  );
  assert.equal(result.teamspaces.length, 1);
  assert.equal(result.teamspaces[0].id, "teamspace:teamspaces");
  assert.equal(result.teamspaces[0].sourceKind, "teamspace");
  assert.deepEqual(
    result.teamspaces[0].children.map((node) => node.id),
    [HIDDEN_ID],
  );
  assert.deepEqual(
    result.teamspaces[0].children[0].children.map((node) => node.id),
    [CHILD_ID],
  );
  assert.equal(
    result.teamspaces[0].children[0].children[0].sourceKind,
    "teamspace",
  );
});

test("navigation title excludes a separately rendered role image icon", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );
  const privateSection = navigationSection("Private", documentLike);
  const row = new FakeElement(
    "li",
    { role: "treeitem", "aria-level": "1" },
    "",
    documentLike,
  );
  const anchor = new FakeElement(
    "a",
    { href: `https://app.notion.com/Roadmap-${COMPACT_ID}` },
    "",
    documentLike,
  );
  anchor.append(
    new FakeElement(
      "span",
      { role: "img", "aria-label": "🗺️" },
      "🗺️",
      documentLike,
    ),
    new FakeElement("span", {}, "Roadmap", documentLike),
  );
  row.append(anchor);
  privateSection.append(row);
  sidebar.append(privateSection);
  documentLike.body.append(sidebar);

  const result = adapter.readNavigationTrees(documentLike);
  assert.equal(result.scopeSafe, true);
  assert.equal(result.personal[0].icon, "🗺️");
  assert.equal(result.personal[0].title, "Roadmap");
});

test("page navigation joins Favorite roots with safely rendered descendants", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const favorites = navigationSection("Favorites", documentLike);
  favorites.append(favoriteRow(COMPACT_ID, "Roadmap", documentLike));
  const personal = navigationSection("Private", documentLike);
  const parent = favoriteRow(COMPACT_ID, "Roadmap", documentLike);
  const child = favoriteRow(CHILD_ID, "Release notes", documentLike);
  child.append(favoriteRow(OTHER_ID, "Release checklist", documentLike));
  parent.append(child);
  personal.append(parent);
  sidebar.append(favorites, personal);

  const result = adapter.readPageNavigation(documentLike, { activePageId: OTHER_ID });
  assert.equal(result.scopeSafe, true);
  assert.equal(result.renderedOnly, true);
  assert.equal(result.reason, "rendered-page-navigation-safe");
  assert.equal(result.roots.length, 1);
  assert.equal(result.roots[0].pageId, COMPACT_ID);
  assert.equal(result.roots[0].children[0].pageId, CHILD_ID);
  assert.equal(result.roots[0].children[0].children[0].pageId, OTHER_ID);
  assert.equal(result.currentPage.title, "Release checklist");
  assert.equal(result.currentPage.href, `https://app.notion.com/Page-${OTHER_ID}`);
  assert.deepEqual(Object.keys(result.currentPage).sort(), [
    "children", "href", "icon", "pageId", "title",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("page navigation reads native Favorite ARIA hierarchy without importing children as Favorites", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const favorites = navigationSection("Favorites", documentLike);
  for (const [pageId, title, level] of [
    [COMPACT_ID, "Roadmap", 1],
    [CHILD_ID, "Product notes", 2],
    [OTHER_ID, "Nested notes", 3],
  ]) {
    favorites.append(favoriteRow(pageId, title, documentLike, {
      attributes: { role: "treeitem", "aria-level": String(level) },
    }));
  }
  sidebar.append(favorites);

  const result = adapter.readPageNavigation(documentLike);
  assert.equal(result.scopeSafe, true);
  assert.equal(result.reason, "partial-rendered-page-navigation");
  assert.equal(result.currentPage.pageId, COMPACT_ID);
  assert.equal(result.currentPage.children[0].pageId, CHILD_ID);
  assert.equal(result.currentPage.children[0].children[0].pageId, OTHER_ID);
  assert.deepEqual(adapter.readFavorites(favorites).map((favorite) => favorite.pageId), [COMPACT_ID]);
});

test("current non-Favorite page uses a rendered title and otherwise a canonical fallback", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const personal = navigationSection("Private", documentLike);
  personal.append(favoriteRow(CHILD_ID, "Not saved in Moa", documentLike));
  sidebar.append(personal);

  const live = adapter.readPageNavigation(documentLike, { activePageId: CHILD_ID });
  assert.equal(live.currentPage.title, "Not saved in Moa");
  assert.deepEqual(live.currentPage.children, []);
  const fallback = adapter.readPageNavigation(documentLike, { activePageId: OTHER_ID });
  assert.deepEqual(fallback.currentPage, {
    pageId: OTHER_ID,
    title: "현재 열린 페이지",
    href: `https://app.notion.com/${OTHER_ID}`,
    icon: null,
    children: [],
  });
  const saved = adapter.readPageNavigation(documentLike, {
    activePageId: OTHER_ID,
    favorites: [{ pageId: OTHER_ID, title: "Saved label", children: [{ pageId: CHILD_ID }] }],
  });
  assert.equal(saved.currentPage.title, "Saved label");
  assert.deepEqual(saved.currentPage.children, []);
});

test("page navigation excludes hidden rows, invalid links, extension hosts and page-body decoys", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const personal = navigationSection("Private", documentLike);
  personal.append(favoriteRow(COMPACT_ID, "Real page", documentLike));
  const hidden = favoriteRow(HIDDEN_ID, "Hidden child", documentLike);
  hidden.setAttribute("hidden", "");
  const invalid = favoriteRow(CHILD_ID, "External child", documentLike);
  invalid.children[0].setAttribute("href", `https://evil.example/${CHILD_ID}`);
  const extension = new FakeElement("div", { [adapter.PRIMARY_NAV_VIEW_HOST_ATTRIBUTE]: "" }, "", documentLike);
  extension.append(favoriteRow(OTHER_ID, "Extension copy", documentLike));
  personal.append(hidden, invalid, extension);
  sidebar.append(personal);
  const bodyDecoy = navigationSection("Favorites", documentLike);
  bodyDecoy.append(favoriteRow(CHILD_ID, "Inline link or backlink", documentLike));
  documentLike.body.append(bodyDecoy);

  const result = adapter.readPageNavigation(documentLike, { activePageId: CHILD_ID });
  assert.deepEqual(result.roots.map((node) => node.pageId), [COMPACT_ID]);
  assert.deepEqual(result.roots[0].children, []);
  assert.equal(result.currentPage.title, "현재 열린 페이지");
  assert.equal(result.currentPage.href, `https://app.notion.com/${CHILD_ID}`);
});

test("unlisted current page reads only its document title and strips Notion tab decoration", () => {
  const { documentLike } = pageNavigationFixture();
  for (const title of ["(12) Project notes | Notion", "Project notes — Notion", "Project notes - Notion"]) {
    documentLike.title = title;
    const result = adapter.readPageNavigation(documentLike);
    assert.equal(result.currentPage.title, "Project notes");
    assert.equal(result.currentPage.href, `https://app.notion.com/${COMPACT_ID}`);
    assert.deepEqual(result.currentPage.children, []);
  }
  for (const title of ["Notion", "(9+) Notion", "노션", " "]) {
    documentLike.title = title;
    assert.equal(adapter.readPageNavigation(documentLike).currentPage.title, "현재 열린 페이지");
  }
  documentLike.title = "A different page | Notion";
  assert.equal(adapter.readPageNavigation(documentLike, { activePageId: OTHER_ID }).currentPage.title, "현재 열린 페이지");
});

test("extension-hidden native source rows are not treated as rendered page navigation", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const personal = navigationSection("Private", documentLike);
  const hidden = favoriteRow(HIDDEN_ID, "Hidden source", documentLike);
  hidden.setAttribute(adapter.HIDDEN_ROW_ATTRIBUTE, "");
  personal.append(favoriteRow(COMPACT_ID, "Visible source", documentLike), hidden);
  sidebar.append(personal);
  assert.deepEqual(adapter.readPageNavigation(documentLike).roots.map((node) => node.pageId), [COMPACT_ID]);
  assert.equal(hidden.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), true);
});

test("partial page navigation never expands collapsed native Favorites", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const favorites = navigationSection("Favorites", documentLike);
  favorites.children[0].setAttribute("aria-expanded", "false");
  favorites.append(favoriteRow(COMPACT_ID, "Retained collapsed page", documentLike));
  const personal = navigationSection("Private", documentLike);
  personal.append(favoriteRow(CHILD_ID, "Visible private page", documentLike));
  sidebar.append(favorites, personal);

  const result = adapter.readPageNavigation(documentLike);
  assert.equal(result.scopeSafe, true);
  assert.equal(result.reason, "partial-rendered-page-navigation");
  assert.deepEqual(result.roots.map((node) => node.pageId), [CHILD_ID]);
  assert.equal(favorites.children[0].getAttribute("aria-expanded"), "false");
});

test("conflicting parents and cycles across rendered sources are not merged", () => {
  for (const cycle of [false, true]) {
    const { documentLike, sidebar } = pageNavigationFixture();
    const favorites = navigationSection("Favorites", documentLike);
    const favoriteParent = favoriteRow(COMPACT_ID, "Favorite parent", documentLike);
    favoriteParent.append(favoriteRow(CHILD_ID, "Child", documentLike));
    favorites.append(favoriteParent);
    const personal = navigationSection("Private", documentLike);
    const privateParent = favoriteRow(cycle ? CHILD_ID : OTHER_ID, "Different parent", documentLike);
    privateParent.append(favoriteRow(cycle ? COMPACT_ID : CHILD_ID, "Conflicting child", documentLike));
    personal.append(privateParent);
    sidebar.append(favorites, personal);

    const result = adapter.readPageNavigation(documentLike);
    assert.equal(result.scopeSafe, false);
    assert.equal(result.reason, "ambiguous-page-navigation-relationships");
    assert.deepEqual(result.roots, []);
    assert.deepEqual(result.currentPage.children, []);
  }
});

test("duplicate source rows and separate Favorite collections are rejected", () => {
  for (const separateCollections of [false, true]) {
    const { documentLike, sidebar } = pageNavigationFixture();
    const favorites = navigationSection("Favorites", documentLike);
    favorites.append(favoriteRow(COMPACT_ID, "First copy", documentLike));
    const otherSection = separateCollections ? navigationSection("Favorites", documentLike) : favorites;
    otherSection.append(favoriteRow(COMPACT_ID, "Second copy", documentLike));
    sidebar.append(favorites);
    if (separateCollections) sidebar.append(otherSection);

    const result = adapter.readPageNavigation(documentLike);
    assert.equal(result.scopeSafe, false);
    assert.deepEqual(result.roots, []);
  }
});

test("unavailable page navigation and invalid current IDs fail closed", () => {
  assert.deepEqual(adapter.readPageNavigation(null), {
    currentPage: null,
    roots: [],
    renderedOnly: true,
    scopeSafe: false,
    reason: "page-navigation-unavailable",
  });
  const { documentLike } = pageNavigationFixture();
  for (const activePageId of ["not-a-page", `https://app.notion.com/${COMPACT_ID}`, null]) {
    const result = adapter.readPageNavigation(documentLike, { activePageId });
    assert.equal(result.currentPage, null);
    assert.equal(result.scopeSafe, false);
  }
  const result = adapter.readPageNavigation(documentLike, {
    activePageId: OTHER_ID,
    favorites: [{ pageId: OTHER_ID, title: "Wrong URL", href: `https://evil.example/${OTHER_ID}` }],
  });
  assert.equal(result.currentPage.title, "현재 열린 페이지");
});

test("observed Notion outliners support direct page anchors, owned child groups and multiple team roots", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const privateSection = navigationSection("Private", documentLike);
  privateSection.append(outlinerTree("private", documentLike,
    outlinerPage(COMPACT_ID, "Roadmap", documentLike, [
      outlinerPage(CHILD_ID, "Release", documentLike, [
        outlinerPage(OTHER_ID, "Checklist", documentLike),
      ]),
    ]),
  ));
  const teamspaceSection = navigationSection("Teamspaces", documentLike);
  teamspaceSection.append(
    outlinerTree("team", documentLike, outlinerPage(HIDDEN_ID, "Team one", documentLike)),
    outlinerTree("team", documentLike, outlinerPage("33333333333333333333333333333333", "Team two", documentLike)),
  );
  const favoriteSection = navigationSection("Favorites", documentLike);
  favoriteSection.append(outlinerTree("bookmarks", documentLike,
    outlinerPage(COMPACT_ID, "Roadmap", documentLike),
  ));
  sidebar.append(privateSection, teamspaceSection, favoriteSection);

  assert.equal(adapter.readNavigationTrees(documentLike).reason, "split-navigation-collections");
  const result = adapter.readPageNavigation(documentLike, { activePageId: OTHER_ID });
  assert.equal(result.scopeSafe, true);
  assert.deepEqual(result.roots.map((node) => node.pageId), [COMPACT_ID, HIDDEN_ID, "33333333333333333333333333333333"]);
  assert.equal(result.roots[0].children[0].pageId, CHILD_ID);
  assert.equal(result.roots[0].children[0].children[0].pageId, OTHER_ID);
  assert.equal(result.currentPage.title, "Checklist");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("observed outliners ignore collapsed retained children and hidden rows without changing the native DOM", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const collapsed = outlinerPage(COMPACT_ID, "Collapsed page", documentLike, [
    outlinerPage(CHILD_ID, "Retained child", documentLike),
  ]);
  collapsed.children[0].setAttribute("aria-expanded", "false");
  const hidden = outlinerPage(HIDDEN_ID, "Hidden page", documentLike);
  hidden.setAttribute("aria-hidden", "true");
  sidebar.append(outlinerTree("private", documentLike, collapsed, hidden));
  const result = adapter.readPageNavigation(documentLike);
  assert.deepEqual(result.roots.map((node) => node.pageId), [COMPACT_ID]);
  assert.deepEqual(result.roots[0].children, []);
  assert.equal(collapsed.children[0].getAttribute("aria-expanded"), "false");
  assert.equal(collapsed.children[1].children.length, 1);
  assert.equal(hidden.getAttribute("aria-hidden"), "true");
});

test("observed outliners locate an exact labeled sidebar beyond twelve layout wrappers", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  let wrapper = sidebar;
  for (let index = 0; index < 24; index += 1) {
    const child = new FakeElement("div", index === 10 ? { role: "tabpanel" } : {}, "", documentLike);
    wrapper.append(child);
    wrapper = child;
  }
  wrapper.append(outlinerTree("private", documentLike,
    outlinerPage(COMPACT_ID, "Deeply wrapped parent", documentLike, [
      outlinerPage(CHILD_ID, "Owned child", documentLike),
    ]),
  ));
  const result = adapter.readPageNavigation(documentLike);
  assert.equal(result.scopeSafe, true);
  assert.equal(result.roots[0].pageId, COMPACT_ID);
  assert.equal(result.roots[0].children[0].pageId, CHILD_ID);

  sidebar.setAttribute("aria-label", "Unrelated navigation");
  assert.deepEqual(adapter.readPageNavigation(documentLike).roots, []);
});

test("observed outliners require the parent anchor and descendant group to share one page block", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const valid = outlinerPage(COMPACT_ID, "Owned parent", documentLike, [
    outlinerPage(CHILD_ID, "Owned child", documentLike),
  ]);
  const unowned = outlinerPage(OTHER_ID, "Unowned parent", documentLike, [
    outlinerPage(HIDDEN_ID, "Unowned child", documentLike),
  ]);
  const unownedWrapper = new FakeElement("div", {}, "", documentLike);
  unownedWrapper.append(...[...unowned.children]);
  sidebar.append(outlinerTree("private", documentLike, valid, unownedWrapper));
  const result = adapter.readPageNavigation(documentLike);
  assert.deepEqual(result.roots.map((node) => node.pageId), [COMPACT_ID]);
  assert.equal(result.roots[0].children[0].pageId, CHILD_ID);
  assert.deepEqual(result.roots[0].children[0].children, []);
});

test("observed outliners reject mismatched block IDs without falling back to a less strict legacy parser", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const section = navigationSection("Private", documentLike);
  const mismatched = outlinerPage(COMPACT_ID, "Mismatched page", documentLike);
  mismatched.setAttribute("data-block-id", OTHER_ID);
  section.append(outlinerTree("private", documentLike, mismatched));
  sidebar.append(section);
  assert.equal(adapter.readNavigationTrees(documentLike).scopeSafe, true);
  const result = adapter.readPageNavigation(documentLike);
  assert.equal(result.scopeSafe, false);
  assert.deepEqual(result.roots, []);
});

test("one malformed observed team root does not authorize reading it through a valid neighboring root", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const invalid = outlinerPage(CHILD_ID, "Wrong URL", documentLike);
  invalid.children[0].setAttribute("href", `https://evil.example/${CHILD_ID}`);
  sidebar.append(
    outlinerTree("team", documentLike, outlinerPage(COMPACT_ID, "Valid team page", documentLike)),
    outlinerTree("team", documentLike, invalid),
  );
  const result = adapter.readPageNavigation(documentLike);
  assert.equal(result.scopeSafe, true);
  assert.equal(result.reason, "partial-rendered-page-navigation");
  assert.deepEqual(result.roots.map((node) => node.pageId), [COMPACT_ID]);
});

test("observed outliners exclude body decoys, extension copies and nested tree collections", () => {
  const { documentLike, sidebar } = pageNavigationFixture();
  const root = outlinerTree("private", documentLike, outlinerPage(COMPACT_ID, "Valid source", documentLike));
  root.children[0].append(outlinerTree("team", documentLike, outlinerPage(CHILD_ID, "Nested decoy", documentLike)));
  const extension = new FakeElement("div", { [adapter.HOST_ATTRIBUTE]: "" }, "", documentLike);
  extension.append(outlinerTree("bookmarks", documentLike, outlinerPage(HIDDEN_ID, "Extension copy", documentLike)));
  sidebar.append(root, extension);
  documentLike.body.append(outlinerTree("team", documentLike, outlinerPage(OTHER_ID, "Body decoy", documentLike)));
  const result = adapter.readPageNavigation(documentLike);
  assert.deepEqual(result.roots.map((node) => node.pageId), [COMPACT_ID]);
});

test("observed outliner duplicate page rows, different parents and cycles fail closed", () => {
  for (const scenario of ["duplicate", "different-parent", "cycle"]) {
    const { documentLike, sidebar } = pageNavigationFixture();
    const first = outlinerPage(COMPACT_ID, "First parent", documentLike, [
      outlinerPage(CHILD_ID, "First child", documentLike),
    ]);
    const second = scenario === "duplicate"
      ? outlinerPage(COMPACT_ID, "Duplicate row", documentLike)
      : outlinerPage(scenario === "cycle" ? CHILD_ID : OTHER_ID, "Other parent", documentLike, [
        outlinerPage(scenario === "cycle" ? COMPACT_ID : CHILD_ID, "Other child", documentLike),
      ]);
    if (scenario === "duplicate") sidebar.append(outlinerTree("private", documentLike, first, second));
    else sidebar.append(outlinerTree("private", documentLike, first), outlinerTree("team", documentLike, second));
    const result = adapter.readPageNavigation(documentLike);
    assert.equal(result.scopeSafe, false, scenario);
    assert.deepEqual(result.roots, [], scenario);
  }
});

test("live Notion descriptive icon labels preserve emoji and scoped title text", () => {
  const { documentLike, anchor } = iconTitleFixture({
    iconText: "🚀", iconLabel: "페이지 아이콘 변경", title: "[TF] Sample Project",
    labelledTitle: true,
  });
  const result = adapter.readNavigationTrees(documentLike).personal[0];
  assert.equal(result.icon, "🚀");
  assert.equal(result.title, "[TF] Sample Project");
  assert.equal(anchor.children[0].textContent, "🚀", "source DOM stays intact");
});

test("fallback title excludes a rendered icon once and preserves authored title emoji", () => {
  const { documentLike } = iconTitleFixture({
    iconText: "🚀", iconLabel: "페이지 아이콘 변경", title: "🚀 프로젝트",
  });
  const result = adapter.readNavigationTrees(documentLike).personal[0];
  assert.equal(result.icon, "🚀");
  assert.equal(result.title, "🚀 프로젝트");
});

test("aria-only emoji icon does not strip the authored leading emoji from a title", () => {
  const { documentLike } = iconTitleFixture({ iconText: "", iconLabel: "📌", title: "📌 계획" });
  const result = adapter.readNavigationTrees(documentLike).personal[0];
  assert.equal(result.icon, "📌");
  assert.equal(result.title, "📌 계획");
});

test("descriptive role images are not icon text and ZWJ emoji remain intact", () => {
  const fallback = iconTitleFixture({ iconText: "", iconLabel: "페이지 아이콘 변경", title: "📌 계획" });
  const fallbackResult = adapter.readNavigationTrees(fallback.documentLike).personal[0];
  assert.equal(fallbackResult.icon, null);
  assert.equal(fallbackResult.title, "📌 계획");
  const joined = iconTitleFixture({ iconText: "👩🏽‍💻", iconLabel: "페이지 아이콘 변경", title: "👩🏽‍💻 개발" });
  const joinedResult = adapter.readNavigationTrees(joined.documentLike).personal[0];
  assert.equal(joinedResult.icon, "👩🏽‍💻");
  assert.equal(joinedResult.title, "👩🏽‍💻 개발");
});

test("emoji icon contract accepts one emoji sequence and rejects labels, paths, and multiple icons", () => {
  for (const value of ["🚀", "👩🏽‍💻", "🇰🇷", "1️⃣", "#️⃣", "❤️‍🔥", "🗺️"]) {
    assert.equal(adapter.normalizeEmojiIcon(value), value);
  }
  for (const value of ["페이지 아이콘 변경", "/icons/page.svg", "https://example.com/icon.png", "🚀📄", "A", "", null]) {
    assert.equal(adapter.normalizeEmojiIcon(value), null);
  }
});

function iconTitleFixture({ iconText, iconLabel, title, labelledTitle = false }) {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement("nav", { "aria-label": "Notion sidebar" }, "", documentLike);
  const privateSection = navigationSection("Private", documentLike);
  const row = new FakeElement("li", { role: "treeitem", "aria-level": "1" }, "", documentLike);
  const anchor = new FakeElement("a", {
    href: `https://app.notion.com/Roadmap-${COMPACT_ID}`,
    ...(labelledTitle ? { "aria-labelledby": "native-page-title" } : {}),
  }, "", documentLike);
  anchor.append(
    new FakeElement("span", { role: "img", "aria-label": iconLabel }, iconText, documentLike),
    new FakeElement("div", labelledTitle ? { id: "native-page-title" } : {}, title, documentLike),
  );
  row.append(anchor); privateSection.append(row); sidebar.append(privateSection); documentLike.body.append(sidebar);
  return { documentLike, anchor };
}

test("Korean Personal and Teamspaces headings are recognized semantically", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "aside",
    { "aria-label": "사이드바" },
    "",
    documentLike,
  );
  const privateSection = navigationSection("개인 페이지", documentLike);
  privateSection.append(
    favoriteRow(COMPACT_ID, "개인 문서", documentLike, {
      tagName: "li",
      attributes: { role: "treeitem", "aria-level": "1" },
    }),
  );
  const teamspaceSection = navigationSection("팀스페이스", documentLike);
  teamspaceSection.append(
    favoriteRow(OTHER_ID, "팀 문서", documentLike, {
      tagName: "li",
      attributes: { role: "treeitem", "aria-level": "1" },
    }),
  );
  sidebar.append(privateSection, teamspaceSection);
  documentLike.body.append(sidebar);

  const result = adapter.inspectNavigationTrees(documentLike);
  assert.equal(result.scopeSafe, true);
  assert.equal(result.personal[0].title, "개인 문서");
  assert.equal(result.teamspaces[0].title, "팀스페이스");
  assert.equal(result.teamspaces[0].children[0].title, "팀 문서");
});

test("navigation scan only returns currently rendered page rows", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );
  const privateSection = navigationSection("Private", documentLike);
  const visibleRow = favoriteRow(COMPACT_ID, "Visible", documentLike, {
    tagName: "li",
    attributes: { role: "treeitem", "aria-level": "1" },
  });
  const hiddenRow = favoriteRow(HIDDEN_ID, "Hidden", documentLike, {
    tagName: "li",
    attributes: { role: "treeitem", "aria-level": "1", hidden: "" },
  });
  privateSection.append(visibleRow, hiddenRow);
  sidebar.append(privateSection);
  documentLike.body.append(sidebar);

  const result = adapter.readNavigationTrees(documentLike);
  assert.equal(result.scopeSafe, true);
  assert.equal(result.renderedOnly, true);
  assert.equal(result.pageCount, 1);
  assert.deepEqual(result.personal.map((node) => node.id), [COMPACT_ID]);
});

test("navigation scan rejects body decoys when no semantic sidebar exists", () => {
  const documentLike = new FakeDomDocument();
  const main = new FakeElement("main", {}, "", documentLike);
  const decoy = navigationSection("Private", documentLike);
  decoy.append(favoriteRow(COMPACT_ID, "Article link", documentLike));
  main.append(decoy);
  documentLike.body.append(main);

  const result = adapter.readNavigationTrees(documentLike);
  assert.equal(result.scopeSafe, false);
  assert.equal(result.renderedOnly, true);
  assert.equal(result.reason, "sidebar-not-found");
  assert.deepEqual(result.personal, []);
  assert.deepEqual(result.teamspaces, []);
});

test("mixed navigation hierarchy signals fail open without partial trees", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );
  const privateSection = navigationSection("Private", documentLike);
  privateSection.append(
    favoriteRow(COMPACT_ID, "Leveled", documentLike, {
      tagName: "li",
      attributes: { role: "treeitem", "aria-level": "1" },
    }),
    favoriteRow(OTHER_ID, "Unknown level", documentLike, {
      tagName: "li",
      attributes: { role: "treeitem" },
    }),
  );
  sidebar.append(privateSection);
  documentLike.body.append(sidebar);

  const result = adapter.readNavigationTrees(documentLike);
  assert.equal(result.scopeSafe, false);
  assert.equal(result.reason, "mixed-navigation-aria-levels");
  assert.ok(result.confidence < 0.5);
  assert.deepEqual(result.personal, []);
  assert.deepEqual(result.teamspaces, []);
});

test("ambiguous unlabelled nested navigation rows fail open", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );
  const privateSection = navigationSection("Private", documentLike);
  const outerRow = new FakeElement("div", {}, "", documentLike);
  outerRow.append(
    new FakeElement(
      "a",
      { href: `https://app.notion.com/Parent-${COMPACT_ID}` },
      "Parent",
      documentLike,
    ),
  );
  const childRow = new FakeElement("div", {}, "", documentLike);
  childRow.append(
    new FakeElement(
      "a",
      { href: `https://app.notion.com/Child-${OTHER_ID}` },
      "Child",
      documentLike,
    ),
  );
  outerRow.append(childRow);
  privateSection.append(outerRow);
  sidebar.append(privateSection);
  documentLike.body.append(sidebar);

  const result = adapter.readNavigationTrees(documentLike);
  assert.equal(result.scopeSafe, false);
  assert.equal(result.reason, "unrecognized-navigation-row-collection");
  assert.deepEqual(result.personal, []);
});

test("a page exposed under both Private and Teamspaces makes source scope unsafe", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );
  const privateSection = navigationSection("Private", documentLike);
  privateSection.append(
    favoriteRow(COMPACT_ID, "Private copy", documentLike, {
      tagName: "li",
      attributes: { role: "treeitem", "aria-level": "1" },
    }),
  );
  const teamspaceSection = navigationSection("Teamspaces", documentLike);
  teamspaceSection.append(
    favoriteRow(COMPACT_ID, "Team copy", documentLike, {
      tagName: "li",
      attributes: { role: "treeitem", "aria-level": "1" },
    }),
  );
  sidebar.append(privateSection, teamspaceSection);
  documentLike.body.append(sidebar);

  const result = adapter.readNavigationTrees(documentLike);
  assert.equal(result.scopeSafe, false);
  assert.equal(result.reason, "duplicate-navigation-source-page");
  assert.deepEqual(result.personal, []);
  assert.deepEqual(result.teamspaces, []);
});

test("primary navigation inspection recognizes the rendered Notion tablist chain", () => {
  const documentLike = new FakeDomDocument();
  const fixture = primaryNavigationFixture(documentLike);

  const inspection = adapter.inspectPrimaryNavigation(documentLike);

  assert.equal(inspection.scopeSafe, true);
  assert.equal(inspection.container, fixture.container);
  assert.equal(inspection.inboxItem, fixture.inbox.tab);
  assert.equal(inspection.inboxWrapper, fixture.inbox.outer);
  assert.equal(inspection.sidebarRoot, fixture.nav);
  assert.equal(inspection.selectedNativeTab, fixture.selectedNativeTab);
  assert.equal(inspection.nativeTabpanel, fixture.nativeTabpanel);
  assert.equal(inspection.contentSurface, fixture.contentSurface);
  assert.equal(inspection.reason, "primary-navigation-safe");
  assert.ok(inspection.confidence >= 0.9);
  assert.equal(Object.isFrozen(inspection), true);
});

test("primary navigation host mounts after Inbox without moving Notion-owned nodes", () => {
  const documentLike = new FakeDomDocument();
  const fixture = primaryNavigationFixture(documentLike);
  const inspection = adapter.inspectPrimaryNavigation(documentLike);
  const nativeWrappers = [...fixture.container.children];
  const nativeParents = nativeWrappers.map((wrapper) => wrapper.parentElement);
  const host = new FakeElement("div", {}, "", documentLike);

  assert.equal(adapter.mountPrimaryNavigationHost(inspection, host), host);
  assert.equal(host.hasAttribute(adapter.PRIMARY_NAV_HOST_ATTRIBUTE), true);
  assert.match(host.getAttribute("style"), /display:\s*contents/u);
  assert.deepEqual(fixture.container.children, [...nativeWrappers, host]);
  assert.deepEqual(
    nativeWrappers.map((wrapper) => wrapper.parentElement),
    nativeParents,
  );

  // A previously returned inspection remains safe to reuse after our own host is mounted.
  assert.equal(adapter.mountPrimaryNavigationHost(inspection, host), host);
  assert.deepEqual(fixture.container.children, [...nativeWrappers, host]);

  const replacement = new FakeElement("div", {}, "", documentLike);
  assert.equal(
    adapter.mountPrimaryNavigationHost(fixture.container, replacement),
    replacement,
  );
  assert.equal(host.parentElement, null);
  assert.equal(host.hasAttribute(adapter.PRIMARY_NAV_HOST_ATTRIBUTE), false);
  assert.deepEqual(fixture.container.children, [...nativeWrappers, replacement]);
  assert.deepEqual(
    nativeWrappers.map((wrapper) => wrapper.parentElement),
    nativeParents,
  );

  assert.equal(adapter.restorePrimaryNavigation(replacement), true);
  assert.equal(replacement.parentElement, null);
  assert.equal(
    replacement.hasAttribute(adapter.PRIMARY_NAV_HOST_ATTRIBUTE),
    false,
  );
  assert.deepEqual(fixture.container.children, nativeWrappers);
});

test("primary navigation view host mounts over the native content surface without moving it", () => {
  const documentLike = new FakeDomDocument();
  const fixture = primaryNavigationFixture(documentLike);
  const inspection = adapter.inspectPrimaryNavigation(documentLike);
  const nativePanelParent = fixture.nativeTabpanel.parentElement;
  const host = new FakeElement("div", {}, "", documentLike);

  assert.equal(adapter.mountPrimaryNavigationViewHost(inspection, host), host);
  assert.equal(
    host.hasAttribute(adapter.PRIMARY_NAV_VIEW_HOST_ATTRIBUTE),
    true,
  );
  assert.deepEqual(fixture.contentSurface.children, [fixture.nativeTabpanel, host]);
  assert.equal(fixture.nativeTabpanel.parentElement, nativePanelParent);

  assert.equal(adapter.mountPrimaryNavigationViewHost(inspection, host), host);
  assert.deepEqual(fixture.contentSurface.children, [fixture.nativeTabpanel, host]);

  const reactSentinel = new FakeElement("div", {}, "", documentLike);
  fixture.contentSurface.appendChild(reactSentinel);
  assert.equal(adapter.mountPrimaryNavigationViewHost(inspection, host), host);
  assert.deepEqual(fixture.contentSurface.children, [
    fixture.nativeTabpanel,
    host,
    reactSentinel,
  ]);

  const replacement = new FakeElement("div", {}, "", documentLike);
  assert.equal(
    adapter.mountPrimaryNavigationViewHost(inspection, replacement),
    replacement,
  );
  assert.equal(host.parentElement, null);
  assert.equal(host.hasAttribute(adapter.PRIMARY_NAV_VIEW_HOST_ATTRIBUTE), false);
  assert.deepEqual(fixture.contentSurface.children, [
    fixture.nativeTabpanel,
    reactSentinel,
    replacement,
  ]);
  assert.equal(fixture.nativeTabpanel.parentElement, nativePanelParent);

  assert.equal(adapter.restorePrimaryNavigationView(replacement), true);
  assert.equal(replacement.parentElement, null);
  assert.equal(
    replacement.hasAttribute(adapter.PRIMARY_NAV_VIEW_HOST_ATTRIBUTE),
    false,
  );
  assert.deepEqual(fixture.contentSurface.children, [
    fixture.nativeTabpanel,
    reactSentinel,
  ]);
});

test("primary navigation view fails open while the controlled native tabpanel is absent", () => {
  const documentLike = new FakeDomDocument();
  const fixture = primaryNavigationFixture(documentLike);
  const staleInspection = adapter.inspectPrimaryNavigation(documentLike);
  fixture.nativeTabpanel.remove();
  const host = new FakeElement("div", {}, "", documentLike);

  const inspection = adapter.inspectPrimaryNavigation(documentLike);
  assert.equal(inspection.scopeSafe, false);
  assert.equal(inspection.reason, "native-tabpanel-not-found");
  assert.equal(inspection.contentSurface, null);
  assert.equal(inspection.nativeTabpanel, null);
  assert.equal(adapter.mountPrimaryNavigationViewHost(staleInspection, host), null);
  assert.equal(host.parentElement, null);
  assert.equal(host.hasAttribute(adapter.PRIMARY_NAV_VIEW_HOST_ATTRIBUTE), false);
});

test("a stale primary navigation inspection cannot mount after Notion swaps tabpanels", () => {
  const documentLike = new FakeDomDocument();
  const fixture = primaryNavigationFixture(documentLike);
  const staleInspection = adapter.inspectPrimaryNavigation(documentLike);
  const nextTab = fixture.entries[1].tab;
  fixture.selectedNativeTab.setAttribute("aria-selected", "false");
  nextTab.setAttribute("aria-selected", "true");
  fixture.nativeTabpanel.remove();
  const nextPanel = new FakeElement(
    "div",
    {
      id: nextTab.getAttribute("aria-controls"),
      role: "tabpanel",
      "aria-labelledby": nextTab.getAttribute("id"),
    },
    "",
    documentLike,
  );
  fixture.contentSurface.append(nextPanel);
  const host = new FakeElement("div", {}, "", documentLike);

  assert.equal(adapter.mountPrimaryNavigationViewHost(staleInspection, host), null);
  assert.equal(host.parentElement, null);

  const refreshed = adapter.inspectPrimaryNavigation(documentLike);
  assert.equal(refreshed.scopeSafe, true);
  assert.equal(refreshed.selectedNativeTab, nextTab);
  assert.equal(refreshed.nativeTabpanel, nextPanel);
  assert.equal(refreshed.contentSurface, fixture.contentSurface);
  assert.equal(adapter.mountPrimaryNavigationViewHost(refreshed, host), host);
  assert.equal(host.parentElement, fixture.contentSurface);
  adapter.restorePrimaryNavigationView(host);
});

test("primary navigation mount revalidates the React-owned sibling structure", () => {
  const documentLike = new FakeDomDocument();
  const fixture = primaryNavigationFixture(documentLike);
  const inspection = adapter.inspectPrimaryNavigation(documentLike);
  const lateNativeTab = primaryTabWrapper("업데이트", documentLike);
  fixture.container.append(lateNativeTab.outer);
  const host = new FakeElement("div", {}, "", documentLike);

  assert.equal(adapter.mountPrimaryNavigationHost(inspection, host), null);
  assert.equal(host.parentElement, null);
  assert.equal(host.hasAttribute(adapter.PRIMARY_NAV_HOST_ATTRIBUTE), false);
  assert.equal(fixture.inbox.outer.parentElement, fixture.container);
  assert.equal(lateNativeTab.outer.parentElement, fixture.container);
});

test("primary navigation inspection fails open for decoys and incomplete structure", () => {
  const scenarios = [
    {
      name: "outside semantic sidebar nav",
      alter(fixture, documentLike) {
        documentLike.body.append(fixture.container);
      },
    },
    {
      name: "missing display contents wrapper",
      alter(fixture) {
        fixture.inbox.inner.setAttribute("style", "display: block;");
      },
    },
    {
      name: "Inbox is not the last native tab",
      options: { labels: ["홈", "수신함", "업데이트"] },
    },
    {
      name: "Inbox has no sibling tab",
      options: { labels: ["수신함"] },
    },
    {
      name: "tablist has an unexpected semantic label",
      options: { tablistLabel: "Page tabs" },
    },
    {
      name: "tablist is not flex",
      options: { containerDisplay: "grid" },
    },
    {
      name: "Inbox is not rendered",
      alter(fixture) {
        fixture.inbox.tab.setAttribute("aria-hidden", "true");
      },
    },
    {
      name: "selected tab id is not an exact safe ARIA token",
      alter(fixture) {
        fixture.selectedNativeTab.setAttribute(
          "id",
          ` ${fixture.selectedNativeTab.getAttribute("id")}`,
        );
      },
    },
  ];

  for (const scenario of scenarios) {
    const documentLike = new FakeDomDocument();
    const fixture = primaryNavigationFixture(documentLike, scenario.options);
    scenario.alter?.(fixture, documentLike);
    const inspection = adapter.inspectPrimaryNavigation(documentLike);
    const host = new FakeElement("div", {}, "", documentLike);

    assert.equal(inspection.scopeSafe, false, scenario.name);
    assert.equal(
      adapter.mountPrimaryNavigationHost(inspection, host),
      null,
      scenario.name,
    );
    assert.equal(host.parentElement, null, scenario.name);
  }
});

test("two valid Inbox tablists are ambiguous and cannot be mounted by container", () => {
  const documentLike = new FakeDomDocument();
  const first = primaryNavigationFixture(documentLike);
  primaryNavigationFixture(documentLike, { navLabel: "Notion sidebar" });

  const inspection = adapter.inspectPrimaryNavigation(documentLike);
  const host = new FakeElement("div", {}, "", documentLike);

  assert.equal(inspection.scopeSafe, false);
  assert.equal(inspection.reason, "ambiguous-inbox-tabs");
  assert.equal(adapter.mountPrimaryNavigationHost(first.container, host), null);
  assert.equal(host.parentElement, null);
});

test("restorePrimaryNavigation without an argument removes every tracked host", () => {
  const firstDocument = new FakeDomDocument();
  const secondDocument = new FakeDomDocument();
  const first = primaryNavigationFixture(firstDocument);
  const second = primaryNavigationFixture(secondDocument, {
    navLabel: "Notion sidebar",
  });
  const firstHost = new FakeElement("div", {}, "", firstDocument);
  const secondHost = new FakeElement("div", {}, "", secondDocument);

  adapter.mountPrimaryNavigationHost(
    adapter.inspectPrimaryNavigation(firstDocument),
    firstHost,
  );
  adapter.mountPrimaryNavigationHost(
    adapter.inspectPrimaryNavigation(secondDocument),
    secondHost,
  );
  assert.equal(firstHost.parentElement, first.container);
  assert.equal(secondHost.parentElement, second.container);

  assert.equal(adapter.restorePrimaryNavigation(), true);
  assert.equal(firstHost.parentElement, null);
  assert.equal(secondHost.parentElement, null);
  assert.equal(adapter.restorePrimaryNavigation(), false);
});

test("restorePrimaryNavigationView without an argument removes every tracked view host", () => {
  const firstDocument = new FakeDomDocument();
  const secondDocument = new FakeDomDocument();
  const first = primaryNavigationFixture(firstDocument);
  const second = primaryNavigationFixture(secondDocument, {
    navLabel: "Notion sidebar",
  });
  const firstHost = new FakeElement("div", {}, "", firstDocument);
  const secondHost = new FakeElement("div", {}, "", secondDocument);

  adapter.mountPrimaryNavigationViewHost(
    adapter.inspectPrimaryNavigation(firstDocument),
    firstHost,
  );
  adapter.mountPrimaryNavigationViewHost(
    adapter.inspectPrimaryNavigation(secondDocument),
    secondHost,
  );
  assert.equal(firstHost.parentElement, first.contentSurface);
  assert.equal(secondHost.parentElement, second.contentSurface);

  assert.equal(adapter.restorePrimaryNavigationView(), true);
  assert.equal(firstHost.parentElement, null);
  assert.equal(secondHost.parentElement, null);
  assert.equal(adapter.restorePrimaryNavigationView(), false);
});

test("semantic sidebar roots exclude a higher-scoring Favorites heading in page content", () => {
  const documentLike = new FakeDomDocument();
  const main = new FakeElement("main", {}, "", documentLike);
  const decoy = new FakeElement("section", {}, "", documentLike);
  decoy.append(
    new FakeElement("h1", {}, "Favorites", documentLike),
    favoriteRow(OTHER_ID, "Linked page in content", documentLike),
  );
  main.append(decoy);

  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );
  const favoritesSection = new FakeElement(
    "section",
    { role: "group", "aria-label": "Favorites" },
    "",
    documentLike,
  );
  favoritesSection.append(
    new FakeElement("button", { "aria-label": "Favorites" }, "Favorites", documentLike),
    favoriteRow(COMPACT_ID, "Actual Favorite", documentLike),
  );
  sidebar.append(favoritesSection);
  documentLike.body.append(main, sidebar);

  const inspection = adapter.inspectFavoritesSection(documentLike);
  assert.equal(inspection.section, favoritesSection);
  assert.equal(inspection.inSidebar, true);
  assert.equal(inspection.favoriteCount, 1);
  assert.deepEqual(
    adapter.readFavorites(inspection.section).map((favorite) => favorite.pageId),
    [COMPACT_ID],
  );
});

test("document fallback can be inspected but can never hide native-looking page content", () => {
  const documentLike = new FakeDomDocument();
  const section = new FakeElement("section", {}, "", documentLike);
  section.append(
    new FakeElement("h1", {}, "Favorites", documentLike),
    favoriteRow(COMPACT_ID, "Content link", documentLike),
  );
  documentLike.body.append(section);

  const inspection = adapter.inspectFavoritesSection(documentLike);
  assert.equal(inspection.inSidebar, false);
  assert.equal(inspection.scopeSafe, false);
  assert.equal(inspection.replaceSafe, false);

  const host = virtualHost([COMPACT_ID], documentLike);
  adapter.mountHost(inspection.section, host);
  assert.equal(adapter.setNativeRowsVisible(inspection.section, false), false);
  assert.equal(
    section.querySelectorAll("a[href]")[0].hasAttribute(
      adapter.HIDDEN_ROW_ATTRIBUTE,
    ),
    false,
  );
  adapter.restore(inspection.section);
});

test("aria-level hierarchy returns only top-level Favorites and disables native replacement", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );
  const section = new FakeElement(
    "section",
    { role: "group", "aria-label": "Favorites" },
    "",
    documentLike,
  );
  section.append(
    new FakeElement("button", { "aria-label": "Favorites" }, "Favorites", documentLike),
  );
  const parentRow = favoriteRow(COMPACT_ID, "Favorited parent", documentLike, {
    tagName: "li",
    attributes: { role: "treeitem", "aria-level": "1" },
  });
  const childRow = favoriteRow(OTHER_ID, "Expanded child", documentLike, {
    tagName: "li",
    attributes: { role: "treeitem", "aria-level": "2" },
  });
  parentRow.append(childRow);
  section.append(parentRow);
  sidebar.append(section);
  documentLike.body.append(sidebar);

  const inspection = adapter.inspectFavoritesSection(documentLike);
  assert.equal(inspection.topLevelSafe, true);
  assert.equal(inspection.hierarchyDetected, true);
  assert.equal(inspection.replaceSafe, false);
  assert.equal(inspection.rawFavoriteCount, 2);
  assert.equal(inspection.favoriteCount, 1);
  assert.deepEqual(
    adapter.readFavorites(section).map((favorite) => favorite.pageId),
    [COMPACT_ID],
  );

  const host = virtualHost([COMPACT_ID], documentLike);
  adapter.mountHost(section, host);
  assert.equal(adapter.setNativeRowsVisible(section, false), false);
  assert.equal(parentRow.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), false);
  assert.equal(childRow.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), false);
  adapter.restore(section);
});

test("mixed hierarchy signals fail open instead of guessing Favorite ownership", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );
  const section = new FakeElement(
    "section",
    { role: "group", "aria-label": "Favorites" },
    "",
    documentLike,
  );
  section.append(
    new FakeElement("button", { "aria-label": "Favorites" }, "Favorites", documentLike),
    favoriteRow(COMPACT_ID, "Leveled", documentLike, {
      tagName: "li",
      attributes: { role: "treeitem", "aria-level": "1" },
    }),
    favoriteRow(OTHER_ID, "Unknown level", documentLike, {
      tagName: "li",
      attributes: { role: "treeitem" },
    }),
  );
  sidebar.append(section);
  documentLike.body.append(sidebar);

  const inspection = adapter.inspectFavoritesSection(documentLike);
  assert.equal(inspection.topLevelSafe, false);
  assert.equal(inspection.replaceSafe, false);
  assert.equal(inspection.classificationReason, "mixed-aria-levels");
  assert.deepEqual(adapter.readFavorites(section), []);
});

test("an empty Favorites heading cannot distinguish an empty list from unmounted rows", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );
  const section = new FakeElement("div", {}, "", documentLike);
  section.append(new FakeElement("div", {}, "즐겨찾기", documentLike));
  sidebar.append(section);
  documentLike.body.append(sidebar);

  const inspection = adapter.inspectFavoritesSection(documentLike);
  assert.ok(inspection);
  assert.equal(inspection.inSidebar, true);
  assert.equal(inspection.emptySafe, false);
  assert.equal(inspection.topLevelSafe, false);
  assert.equal(inspection.replaceSafe, false);
  assert.equal(inspection.classificationReason, "empty-or-unmounted");
  assert.equal(inspection.favoriteCount, 0);
});

test("collapsed Favorites with retained DOM links is not an authoritative source", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement("nav", { "aria-label": "Notion sidebar" }, "", documentLike);
  const section = navigationSection("Favorites", documentLike);
  section.children[0].setAttribute("aria-expanded", "false");
  section.append(favoriteRow(COMPACT_ID, "Planning", documentLike));
  sidebar.append(section);
  documentLike.body.append(sidebar);

  const inspection = adapter.inspectFavoritesSection(documentLike);
  assert.equal(inspection.topLevelSafe, false);
  assert.equal(inspection.classificationReason, "collapsed-or-hidden");
  assert.deepEqual(adapter.readFavorites(section), []);
});

test("workspace identity exposes current slug alongside stable ID for conservative continuity", () => {
  const documentLike = fakeDocument({
    rootAttributes: { "data-workspace-id": COMPACT_ID },
    href: `https://app.notion.com/p/acme/Planning-${OTHER_ID}`,
  });
  assert.deepEqual(adapter.deriveWorkspaceIdentity(documentLike), {
    key: `workspace:id:${COMPACT_ID}`,
    slugKey: "workspace:slug:acme",
  });
});

test("CSS-hidden retained Favorite rows cannot be imported from a collapsed collection", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement("nav", { "aria-label": "Notion sidebar" }, "", documentLike);
  const section = navigationSection("Favorites", documentLike);
  const row = favoriteRow(COMPACT_ID, "Planning", documentLike);
  row.setAttribute("style", "display: none;");
  section.append(row);
  sidebar.append(section);
  documentLike.body.append(sidebar);
  const inspection = adapter.inspectFavoritesSection(documentLike);
  assert.equal(inspection.topLevelSafe, false);
  assert.equal(inspection.classificationReason, "collapsed-or-hidden");
});

test("native replacement uses a removable marker and fails open on Shadow DOM mismatch", () => {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement(
    "nav",
    { "aria-label": "Notion sidebar" },
    "",
    documentLike,
  );
  const section = new FakeElement(
    "section",
    { role: "group", "aria-label": "Favorites" },
    "",
    documentLike,
  );
  const heading = new FakeElement("div", {}, "Favorites", documentLike);
  const firstRow = favoriteRow(COMPACT_ID, "Roadmap", documentLike);
  const secondRow = favoriteRow(OTHER_ID, "Decisions", documentLike);
  section.append(heading, firstRow, secondRow);
  sidebar.append(section);
  documentLike.body.append(sidebar);
  assert.equal(adapter.inspectFavoritesSection(documentLike).replaceSafe, true);

  const host = new FakeElement("div", {}, "", documentLike);
  const shadowRoot = new FakeElement("shadow-root", {}, "", documentLike);
  const virtualFirst = new FakeElement(
    "li",
    { "data-page-id": COMPACT_ID },
    "",
    documentLike,
  );
  const virtualSecond = new FakeElement(
    "li",
    { "data-page-id": OTHER_ID },
    "",
    documentLike,
  );
  shadowRoot.append(virtualFirst, virtualSecond);
  host.shadowRoot = shadowRoot;

  assert.equal(adapter.mountHost(section, host), host);
  assert.equal(adapter.setNativeRowsVisible(section, false), true);
  assert.equal(firstRow.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), true);
  assert.equal(secondRow.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), true);
  assert.equal(firstRow.hasAttribute("style"), false);
  assert.equal(firstRow.hasAttribute("aria-hidden"), false);

  assert.equal(adapter.setNativeRowsVisible(section, true), true);
  assert.equal(firstRow.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), false);
  assert.equal(secondRow.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), false);

  shadowRoot.removeChild(virtualSecond);
  assert.equal(adapter.setNativeRowsVisible(section, false), false);
  assert.equal(firstRow.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), false);
  assert.equal(secondRow.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), false);

  shadowRoot.append(virtualSecond);
  assert.equal(adapter.setNativeRowsVisible(section, false), true);
  assert.equal(adapter.restore(section), true);
  assert.equal(firstRow.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), false);
  assert.equal(secondRow.hasAttribute(adapter.HIDDEN_ROW_ATTRIBUTE), false);
  assert.equal(host.parentElement, null);
});

test("DOM entrypoints fail open when called without a usable DOM", () => {
  assert.equal(adapter.locateFavoritesSection(null), null);
  assert.deepEqual(adapter.readFavorites(null), []);
  assert.deepEqual(adapter.readNavigationTrees(null), {
    scopeSafe: false,
    inSidebar: false,
    confidence: 0,
    renderedOnly: true,
    personal: [],
    teamspaces: [],
    sourceCount: 0,
    pageCount: 0,
    reason: "unusable-document",
  });
  assert.equal(adapter.inspectPrimaryNavigation(null).scopeSafe, false);
  assert.equal(adapter.mountPrimaryNavigationHost(null, null), null);
  assert.equal(adapter.mountPrimaryNavigationViewHost(null, null), null);
  assert.equal(adapter.restorePrimaryNavigation(new FakeElement("div")), false);
  assert.equal(adapter.restorePrimaryNavigationView(new FakeElement("div")), false);
  assert.equal(adapter.mountHost(null, null), null);
  assert.equal(adapter.setNativeRowsVisible(null, false), false);
  assert.equal(adapter.restore(null), false);
});

function primaryTabWrapper(
  label,
  ownerDocument,
  { outerDisplay = "contents", innerDisplay = "contents" } = {},
) {
  const outer = new FakeElement(
    "div",
    { style: `display: ${outerDisplay};` },
    "",
    ownerDocument,
  );
  const inner = new FakeElement(
    "div",
    { style: `display: ${innerDisplay};` },
    "",
    ownerDocument,
  );
  const tab = new FakeElement(
    "div",
    { role: "tab", "aria-label": label },
    label,
    ownerDocument,
  );
  inner.append(tab);
  outer.append(inner);
  return { outer, inner, tab };
}

function primaryNavigationFixture(
  documentLike,
  {
    labels = ["홈", "채팅", "회의", "수신함"],
    navLabel = "사이드바",
    tablistLabel = "Sidebar navigation",
    containerDisplay = "flex",
  } = {},
) {
  const fixtureId = ++primaryFixtureSequence;
  const nav = new FakeElement(
    "nav",
    { "aria-label": navLabel },
    "",
    documentLike,
  );
  const container = new FakeElement(
    "div",
    {
      role: "tablist",
      "aria-label": tablistLabel,
      style: `display: ${containerDisplay}; gap: 2px; height: 32px;`,
    },
    "",
    documentLike,
  );
  const entries = labels.map((label) =>
    primaryTabWrapper(label, documentLike),
  );
  entries.forEach((entry, index) => {
    const tabId = `sidebar-tab-${fixtureId}-${index}`;
    entry.tab.setAttribute("id", tabId);
    entry.tab.setAttribute("aria-selected", index === 0 ? "true" : "false");
    entry.tab.setAttribute("aria-controls", `sidebar-tabpanel-${fixtureId}-${index}`);
  });
  container.append(...entries.map((entry) => entry.outer));
  const selectedNativeTab = entries[0].tab;
  const nativeTabpanel = new FakeElement(
    "div",
    {
      id: selectedNativeTab.getAttribute("aria-controls"),
      role: "tabpanel",
      "aria-labelledby": selectedNativeTab.getAttribute("id"),
    },
    "",
    documentLike,
  );
  const contentSurface = new FakeElement(
    "div",
    { style: "display: flex; flex-direction: column; position: relative;" },
    "",
    documentLike,
  );
  contentSurface.append(nativeTabpanel);
  const header = new FakeElement("div", {}, "", documentLike);
  header.append(container);
  const footer = new FakeElement("div", {}, "", documentLike);
  const shell = new FakeElement("div", {}, "", documentLike);
  shell.append(header, contentSurface, footer);
  nav.append(shell);
  documentLike.body.append(nav);

  return {
    nav,
    container,
    entries,
    inbox: entries.find((entry) => /^(?:Inbox|수신함)$/u.test(entry.tab.getAttribute("aria-label"))),
    selectedNativeTab,
    nativeTabpanel,
    contentSurface,
    header,
    footer,
    shell,
  };
}

function fakeNode(attributes = {}) {
  return {
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name)
        ? attributes[name]
        : null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name);
    },
  };
}

function fakeDocument({
  rootAttributes = {},
  bodyAttributes = {},
  attributedNodes = [],
  metaNodes = [],
  href,
}) {
  return {
    documentElement: fakeNode(rootAttributes),
    body: fakeNode(bodyAttributes),
    location: { href },
    querySelectorAll(selector) {
      if (selector.startsWith("meta[")) return metaNodes;
      if (selector.includes("[data-workspace-id]")) return attributedNodes;
      return [];
    },
  };
}

function navigationSection(label, ownerDocument) {
  const section = new FakeElement(
    "section",
    { role: "group", "aria-label": label },
    "",
    ownerDocument,
  );
  section.append(
    new FakeElement(
      "button",
      { "aria-label": label, "aria-expanded": "true" },
      label,
      ownerDocument,
    ),
  );
  return section;
}

function pageNavigationFixture() {
  const documentLike = new FakeDomDocument();
  const sidebar = new FakeElement("nav", { "aria-label": "Notion sidebar" }, "", documentLike);
  documentLike.body.append(sidebar);
  return { documentLike, sidebar };
}

function outlinerTree(kind, ownerDocument, ...rows) {
  const tree = new FakeElement("div", { role: "tree", class: `notion-outliner-${kind}` }, "", ownerDocument);
  const wrapper = new FakeElement("div", {}, "", ownerDocument);
  wrapper.append(...rows);
  tree.append(wrapper);
  return tree;
}

function outlinerPage(pageId, title, ownerDocument, children = []) {
  const row = new FakeElement("div", {
    class: "notion-selectable notion-page-block",
    "data-block-id": pageId,
  }, "", ownerDocument);
  row.append(new FakeElement("a", {
    role: "treeitem",
    href: `https://app.notion.com/Page-${pageId}`,
    "aria-expanded": children.length ? "true" : "false",
  }, title, ownerDocument));
  if (children.length) {
    const group = new FakeElement("div", { role: "group", class: "notion-outliner-team" }, "", ownerDocument);
    const wrapper = new FakeElement("div", {}, "", ownerDocument);
    wrapper.append(...children);
    group.append(wrapper);
    row.append(group);
  }
  return row;
}

function favoriteRow(pageId, title, ownerDocument, options = {}) {
  const row = new FakeElement(
    options.tagName || "div",
    options.attributes || { role: "treeitem" },
    "",
    ownerDocument,
  );
  const anchor = new FakeElement(
    "a",
    { href: `https://app.notion.com/Page-${pageId}` },
    title,
    ownerDocument,
  );
  row.append(anchor);
  return row;
}

function virtualHost(pageIds, ownerDocument) {
  const host = new FakeElement("div", {}, "", ownerDocument);
  const shadowRoot = new FakeElement("shadow-root", {}, "", ownerDocument);
  shadowRoot.append(
    ...pageIds.map(
      (pageId) =>
        new FakeElement("li", { "data-page-id": pageId }, "", ownerDocument),
    ),
  );
  host.shadowRoot = shadowRoot;
  return host;
}

class FakeDomDocument {
  constructor() {
    this.location = { href: "https://app.notion.com/acme/Page-0123456789abcdef0123456789abcdef" };
    this.documentElement = new FakeElement("html", {}, "", this);
    this.body = new FakeElement("body", {}, "", this);
    this.documentElement.append(this.body);
  }

  contains(node) {
    return this.documentElement.contains(node);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  getElementById(id) {
    return this.querySelectorAll("[id]").find(
      (node) => node.getAttribute("id") === id,
    ) || null;
  }
}

class FakeElement {
  constructor(tagName, attributes = {}, ownText = "", ownerDocument = null) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.ownText = ownText;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.shadowRoot = null;
  }

  get textContent() {
    return `${this.ownText}${this.children.map((child) => child.textContent).join("")}`;
  }

  get childNodes() {
    return [
      ...(this.ownText ? [{ nodeType: 3, textContent: this.ownText }] : []),
      ...this.children,
    ];
  }

  get href() {
    return this.getAttribute("href");
  }

  get nextSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node) {
    if (node.parentElement) node.parentElement.removeChild(node);
    node.parentElement = this;
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  insertBefore(node, referenceNode) {
    if (!referenceNode) return this.appendChild(node);
    if (node.parentElement) node.parentElement.removeChild(node);
    const index = this.children.indexOf(referenceNode);
    if (index < 0) throw new Error("Reference node is not a child");
    node.parentElement = this;
    node.parentNode = this;
    this.children.splice(index, 0, node);
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentElement = null;
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((child) => child.contains(node));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  querySelectorAll(selector) {
    const descendants = [];
    const visit = (node) => {
      for (const child of node.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);

    if (selector === "a[href]") {
      return descendants.filter(
        (node) => node.tagName === "A" && node.hasAttribute("href"),
      );
    }
    if (selector === 'nav, aside, [role="navigation"], [data-testid], [aria-label]') {
      return descendants.filter(
        (node) =>
          node.tagName === "NAV" ||
          node.tagName === "ASIDE" ||
          node.getAttribute("role") === "navigation" ||
          node.hasAttribute("data-testid") ||
          node.hasAttribute("aria-label"),
      );
    }
    if (selector === "img[src]" || selector.includes("page-title") || selector.includes("page-icon")) {
      return [];
    }
    if (selector === '[role="img"]') {
      return descendants.filter((node) => node.getAttribute("role") === "img");
    }

    const exactAttribute = selector.match(/^\[([^\]]+)\]$/u);
    if (exactAttribute) {
      return descendants.filter((node) => node.hasAttribute(exactAttribute[1]));
    }

    if (selector.startsWith("h1, h2")) return descendants;
    if (selector === "div, span") {
      return descendants.filter(
        (node) => node.tagName === "DIV" || node.tagName === "SPAN",
      );
    }
    return [];
  }
}
