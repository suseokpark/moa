import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../test-support/candidate-picker-fixture.mjs";

const labels = f => f.checks().map(check => check.getAttribute("aria-label"));
const toggle = f => f.$("dialog-body").querySelector(".candidate-selection-review");
const review = async f => { assert.ok(toggle(f)); await toggle(f).emit("click"); };

for (const bookmarks of [false, true]) {
  const kind = bookmarks ? "bookmarks" : "tabs";
  test(`${kind}: selected-only review includes hidden selections and restores the exact search without writing`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open();
    const before = structuredClone(f.run("state"));
    assert.ok(toggle(f)); assert.equal(toggle(f).disabled, true);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "false");
    await f.check("Alpha"); await f.search(" Beta  "); await f.check("Beta");
    await review(f);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "true");
    assert.deepEqual(labels(f), ["Alpha 선택", "Beta 선택"]);
    assert.ok(f.checks().every(check => check.checked));
    assert.equal(f.count(), "2개 선택"); assert.equal(f.filter().disabled, true);
    assert.equal(f.filter().value, " Beta  "); assert.equal(f.all().parentElement.hidden, true);
    assert.equal(f.$("dialog-body").querySelector(".candidate-select-results").hidden, true);
    const help = f.$("dialog-body").querySelector("#candidate-selection-review-help");
    assert.equal(toggle(f).getAttribute("aria-describedby"), help.id);
    assert.match(help.textContent, /검색.*관계없이/u);
    await review(f);
    assert.equal(toggle(f).getAttribute("aria-pressed"), "false");
    assert.equal(f.filter().disabled, false); assert.equal(f.filter().value, " Beta  ");
    assert.deepEqual(labels(f), ["Beta 선택"]); assert.equal(f.count(), "2개 선택 · 화면 밖 1개 포함");
    assert.equal(f.all().parentElement.hidden, false);
    assert.equal(f.fetches(), 1); assert.equal(f.loads(), 0); assert.equal(f.actions.length, 0);
    assert.deepEqual(structuredClone(f.run("state")), before);
  });

  test(`${kind}: removing selected rows focuses the next, then previous row, then the escape toggle`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open();
    for (const title of ["Alpha", "Beta", "Gamma"]) await f.check(title);
    await review(f);
    await f.check("Beta");
    assert.deepEqual(labels(f), ["Alpha 선택", "Gamma 선택"]);
    assert.equal(f.document.activeElement.getAttribute("aria-label"), "Gamma 선택");
    await f.check("Gamma");
    assert.equal(f.document.activeElement.getAttribute("aria-label"), "Alpha 선택");
    await f.check("Alpha");
    assert.equal(f.checks().length, 0); assert.equal(f.document.activeElement, toggle(f));
    assert.equal(toggle(f).disabled, false); assert.equal(toggle(f).getAttribute("aria-pressed"), "true");
    assert.match(f.$("dialog-body").querySelector(".tab-candidates").textContent, /선택한 항목이 없습니다/u);
    assert.equal(f.$("dialog-submit").disabled, true);
    await review(f); assert.equal(f.checks().length, 3); assert.equal(toggle(f).disabled, true);
    assert.equal(f.document.activeElement, f.filter());
    assert.equal(f.actions.length, 0);
  });

  test(`${kind}: clear selection keeps an empty review with a usable return path`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open(); await f.check("Alpha"); await f.search("no-match");
    await review(f); await f.clickText("선택 해제");
    assert.equal(f.count(), "0개 선택"); assert.equal(toggle(f).getAttribute("aria-pressed"), "true");
    assert.equal(f.document.activeElement, toggle(f)); assert.equal(toggle(f).disabled, false);
    await review(f); assert.equal(f.filter().value, "no-match"); assert.equal(f.filter().disabled, false);
    assert.equal(f.checks().length, 0); assert.equal(f.actions.length, 0);
  });

  test(`${kind}: review retains destination and new-group draft, then saves only retained selected links once`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open();
    await f.check("Alpha"); await f.check("Beta"); await f.target("destination");
    await f.clickText("새 그룹에 담기");
    const name = f.$("dialog-body").querySelector(".candidate-new-group-name");
    const parent = f.$("dialog-body").querySelector(".candidate-new-group-parent");
    name.value = "검토한 자료"; await name.emit("input"); parent.value = "group:parent"; await parent.emit("change");
    await f.search("Gamma"); await review(f); await f.check("Alpha");
    assert.equal(name.value, "검토한 자료"); assert.equal(parent.value, "group:parent");
    assert.equal(f.$("dialog-body").querySelector(".candidate-target-group").value, "destination");
    assert.equal(f.actions.length, 0); await f.submit();
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].action.type, "addLinksToNewGroup");
    assert.equal(f.actions[0].action.name, "검토한 자료");
    assert.equal(f.actions[0].action.parentGroupId, "parent");
    assert.deepEqual(f.actions[0].action.links.map(link => link.title), ["Beta"]);
  });
}
