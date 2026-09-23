import assert from "node:assert/strict";
import test from "node:test";
import { createLinkSelection } from "../src/link-selection.js";

const LIBRARY = "library-example";
const LINKS = ["link-one", "link-two", "link-three"];

test("link selection starts inactive and ignores toggles until selection mode starts", () => {
  const selection = createLinkSelection();
  selection.reconcile(LIBRARY, LINKS);
  assert.equal(selection.isActive(), false);
  assert.equal(selection.count(), 0);
  assert.deepEqual(selection.selected(), []);
  assert.equal(selection.toggle(LINKS[0]), false);
  assert.equal(selection.toggleVisible(LINKS), false);
  assert.equal(selection.start(LIBRARY), true);
  assert.equal(selection.isActive(), true);
  assert.equal(selection.toggle(LINKS[0]), true);
  assert.equal(selection.has(LINKS[0]), true);
  assert.equal(selection.count(), 1);
  assert.equal(selection.toggle(LINKS[0]), true);
  assert.equal(selection.has(LINKS[0]), false);
  assert.equal(selection.count(), 0);
});

test("start accepts the current library's IDs directly and ignores non-link or other-library IDs", () => {
  const selection = createLinkSelection();
  selection.start(LIBRARY, LINKS);
  for (const invalid of ["group-example", "other-library-link", "", null, undefined, 1]) {
    assert.equal(selection.toggle(invalid), false);
  }
  assert.deepEqual(selection.selected(), []);
  selection.toggleVisible([LINKS[0], "group-example", "other-library-link"]);
  assert.deepEqual(selection.selected(), [LINKS[0]]);
});

test("repeated starts and same-library reconciliation preserve selections across renders and searches", () => {
  const selection = createLinkSelection();
  selection.start(LIBRARY, LINKS);
  selection.toggle(LINKS[1]);
  for (let render = 0; render < 5; render += 1) {
    assert.equal(selection.start(LIBRARY), false);
    assert.equal(selection.reconcile(LIBRARY, [...LINKS].reverse()), false);
    assert.equal(selection.isActive(), true);
    assert.deepEqual(selection.selected(), [LINKS[1]]);
  }
});

test("toggle visible selects all when partially selected and deselects all when fully selected", () => {
  const selection = createLinkSelection();
  selection.start(LIBRARY, LINKS);
  selection.toggle(LINKS[0]);
  assert.equal(selection.toggleVisible(LINKS), true);
  assert.deepEqual(selection.selected(), LINKS);
  assert.equal(selection.toggleVisible(LINKS), true);
  assert.deepEqual(selection.selected(), []);
  assert.equal(selection.isActive(), true, "deselecting all keeps selection mode open");
});

test("toggle visible preserves selected links hidden by filtering or folded groups", () => {
  const selection = createLinkSelection();
  selection.start(LIBRARY, LINKS);
  selection.toggle(LINKS[2]);
  selection.toggleVisible([LINKS[0], LINKS[1]]);
  assert.deepEqual(selection.selected(), [LINKS[2], LINKS[0], LINKS[1]]);
  selection.toggleVisible([LINKS[0], LINKS[1]]);
  assert.deepEqual(selection.selected(), [LINKS[2]]);
  selection.toggleVisible([]);
  assert.deepEqual(selection.selected(), [LINKS[2]], "empty results never clear hidden selections");
});

test("visible ID deduplication and invalid input never select non-library IDs", () => {
  const selection = createLinkSelection();
  selection.start(LIBRARY, LINKS);
  for (const visible of [undefined, null, "link-one", 2, {}, [], ["unknown"]]) {
    assert.equal(selection.toggleVisible(visible), false);
    assert.equal(selection.count(), 0);
  }
  selection.toggleVisible([LINKS[0], LINKS[0], null, "unknown"]);
  assert.deepEqual(selection.selected(), [LINKS[0]]);
  selection.toggleVisible(new Set([LINKS[0]]));
  assert.equal(selection.count(), 0);
});

test("reconciliation prunes only removed links and preserves selection mode when none remain", () => {
  const selection = createLinkSelection();
  selection.start(LIBRARY, LINKS);
  selection.toggleVisible(LINKS);
  assert.equal(selection.reconcile(LIBRARY, [LINKS[1], LINKS[2], "new-link"]), true);
  assert.deepEqual(selection.selected(), [LINKS[1], LINKS[2]]);
  assert.equal(selection.has("new-link"), false, "new links are not selected automatically");
  assert.equal(selection.toggle(LINKS[0]), false, "removed links cannot be selected again");
  selection.reconcile(LIBRARY, []);
  assert.equal(selection.count(), 0);
  assert.equal(selection.isActive(), true);
});

test("switching libraries clears and exits selection mode even if link IDs overlap", () => {
  const selection = createLinkSelection();
  selection.start(LIBRARY, LINKS);
  selection.toggleVisible(LINKS);
  assert.equal(selection.reconcile("library-other", [LINKS[0], "other-link"]), true);
  assert.equal(selection.isActive(), false);
  assert.deepEqual(selection.selected(), []);
  assert.equal(selection.toggle(LINKS[0]), false);
  selection.start("library-other");
  assert.equal(selection.toggle("other-link"), true);
  assert.equal(selection.toggle(LINKS[1]), false);
  selection.reconcile(LIBRARY, LINKS);
  assert.equal(selection.isActive(), false);
  assert.deepEqual(selection.selected(), [], "returning to a library does not restore old selections");
});

test("starting a different library cannot reuse the preceding library's allowed IDs", () => {
  const selection = createLinkSelection();
  selection.start(LIBRARY, LINKS);
  selection.toggle(LINKS[0]);
  selection.start("library-other");
  assert.equal(selection.isActive(), true);
  assert.equal(selection.count(), 0);
  assert.equal(selection.toggle(LINKS[0]), false);
  selection.reconcile("library-other", ["other-link"]);
  assert.equal(selection.toggle("other-link"), true);
});

test("stop clears selected links and restarting does not restore selections", () => {
  const selection = createLinkSelection();
  selection.start(LIBRARY, LINKS);
  selection.toggle(LINKS[1]);
  assert.equal(selection.stop(), true);
  assert.equal(selection.stop(), false);
  assert.equal(selection.isActive(), false);
  assert.equal(selection.count(), 0);
  selection.start(LIBRARY);
  assert.deepEqual(selection.selected(), []);
  assert.equal(selection.toggle(LINKS[0]), true, "same-library allowed IDs remain reusable");
});

test("missing library clears mode and cannot enter selection mode", () => {
  const selection = createLinkSelection();
  for (const missing of [undefined, null, "", 5]) {
    selection.start(LIBRARY, LINKS);
    selection.toggle(LINKS[0]);
    selection.reconcile(missing, LINKS);
    assert.equal(selection.isActive(), false);
    assert.equal(selection.count(), 0);
    selection.start(missing, LINKS);
    assert.equal(selection.isActive(), false);
    assert.equal(selection.toggle(LINKS[0]), false);
  }
});

test("selection has no shared or externally mutable state", () => {
  const allowed = new Set(LINKS);
  const first = createLinkSelection(), second = createLinkSelection();
  first.start(LIBRARY, allowed);
  first.toggle(LINKS[0]);
  allowed.clear(); allowed.add("foreign-link");
  assert.equal(first.toggle(LINKS[1]), true, "allowed IDs are copied on reconcile");
  assert.equal(first.toggle("foreign-link"), false);
  const returned = first.selected();
  returned.length = 0; returned.push("foreign-link");
  assert.deepEqual(first.selected(), [LINKS[0], LINKS[1]]);
  assert.equal(second.isActive(), false);
  assert.deepEqual(second.selected(), []);
});

test("refreshing allowed IDs through start prunes removed selections without resetting retained ones", () => {
  const selection = createLinkSelection();
  selection.start(LIBRARY, LINKS);
  selection.toggleVisible(LINKS);
  assert.equal(selection.start(LIBRARY, [LINKS[1], LINKS[2]]), true);
  assert.deepEqual(selection.selected(), [LINKS[1], LINKS[2]]);
  assert.equal(selection.isActive(), true);
  assert.equal(selection.start(LIBRARY, [LINKS[1], LINKS[2]]), false);
});
