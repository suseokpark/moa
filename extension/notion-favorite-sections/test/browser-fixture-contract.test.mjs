import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixtureNames = [
  "browser-interaction-fixture.html",
  "browser-smoke-fixture.html",
  "browser-live-demo.html"
];

const fixtures = new Map(
  await Promise.all(
    fixtureNames.map(async (name) => [
      name,
      await readFile(new URL(name, import.meta.url), "utf8")
    ])
  )
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

for (const [name, source] of fixtures) {
  test(`${name} loads the Moa brand before the panel shell`, () => {
    const brandIndex = source.search(/src="\.\.\/src\/moa-brand\.js(?:\?[^"]*)?"/u);
    const panelIndex = source.search(/src="\.\.\/src\/notion-tree-panel\.js(?:\?[^"]*)?"/u);
    assert.ok(brandIndex >= 0, "the shared Moa brand module must be loaded");
    assert.ok(panelIndex > brandIndex, "the brand must load before the panel shell");
  });

  test(`${name} exposes a semantic native tab content surface`, () => {
    const selectedTab = source.match(
      /<div(?=[^>]*\bid="([^"]+)")(?=[^>]*\brole="tab")(?=[^>]*\baria-controls="([^"]+)")(?=[^>]*\baria-selected="true")[^>]*>/u
    );
    assert.ok(selectedTab, "one selected native tab must own an id and aria-controls");

    const [, tabId, panelId] = selectedTab;
    const directPanel = new RegExp(
      `data-fixture-content-surface[^>]*>\\s*<div(?=[^>]*data-fixture-native-panel)(?=[^>]*id="${escapeRegExp(panelId)}")(?=[^>]*role="tabpanel")(?=[^>]*aria-labelledby="${escapeRegExp(tabId)}")[^>]*>`,
      "u"
    );
    assert.match(source, directPanel);
    assert.match(
      source,
      /data-fixture-content-surface[^>]*style="[^"]*display:\s*flex;\s*flex-direction:\s*column;\s*position:\s*relative[^"]*"/u
    );
  });
}

for (const name of [
  "browser-interaction-fixture.html",
  "browser-smoke-fixture.html"
]) {
  test(`${name} verifies the opaque overlay without mutating native rows`, () => {
    const source = fixtures.get(name);
    for (const required of [
      "data-notion-tree-primary-navigation-view-host",
      "lastElementChild",
      "getBoundingClientRect",
      "elementFromPoint",
      "backgroundColor",
      "fixtureNativePanel.innerHTML",
      "fixtureUnderlayClickCount",
      "probeHitAfterClose"
    ]) {
      assert.ok(source.includes(required), `missing browser assertion: ${required}`);
    }
    assert.match(
      source,
      /!fixtureNativePanel\.contains\(probeHitWhileOpen\)/u
    );
    assert.match(
      source,
      /(?:rectCovers\(viewRect,\s*surfaceRect\)|viewRect\.bottom\s*>=\s*surfaceRect\.bottom(?:\s*-\s*1)?)/u
    );
  });
}

test("interaction fixture retains direct and legacy storage coverage", () => {
  const source = fixtures.get("browser-interaction-fixture.html");
  assert.match(source, /fixtureUsesLegacyProfile/u);
  assert.match(source, /profile:\$\{fixtureLegacyProfileId\}:workspace:/u);
  assert.match(source, /resetWasOneCasSet/u);
  assert.match(source, /storageScopeCorrect/u);
  assert.match(source, /pickerSearchFocused/u);
  assert.match(source, /pickerSearchFiltered/u);
  assert.match(source, /input\[aria-label="즐겨찾기 검색"\]/u);
  assert.match(source, /selectedDestinationExplicitly/u);
  assert.match(source, /bulkAddWasOneCasSet/u);
  assert.match(source, /pickerHasNoHorizontalOverflow/u);
  assert.match(source, /layeredEscapeClosedMenuOnly/u);
  assert.match(source, /select\[aria-label="즐겨찾기 추가 목적지"\]/u);
  assert.match(source, /button\[aria-label="선택한 즐겨찾기 추가"\]/u);
});

test("smoke fixture retains storage fail-open controls", () => {
  const source = fixtures.get("browser-smoke-fixture.html");
  assert.match(source, /addButton\?\.disabled/u);
  assert.match(source, /refreshButton\?\.disabled/u);
  assert.match(source, /resetButton\?\.disabled/u);
  assert.match(source, /closeRestoredNativeSurface/u);
});

test("live demo exposes its internal surface state for manual Chromium checks", () => {
  const source = fixtures.get("browser-live-demo.html");
  assert.match(source, /window\.__nfsLiveDemo/u);
  assert.match(source, /directLastChild:/u);
  assert.match(source, /opaque:/u);
  assert.match(source, /covers:/u);
  assert.match(source, /data-fixture-underlay-probe/u);
});
