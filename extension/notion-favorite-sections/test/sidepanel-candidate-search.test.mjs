import assert from "node:assert/strict";
import test from "node:test";
import { fixture, tab } from "../test-support/candidate-picker-fixture.mjs";

const labels = f => f.checks().map(check => check.getAttribute("aria-label"));

test("tab import finds the same candidate when search words are reversed", async () => {
  const f = fixture([tab("디자인 가이드", "https://example.org/design"), tab("디자인 모음", "https://example.org/collection")]);
  await f.open(); await f.search("디자인 가이드");
  assert.deepEqual(labels(f), ["디자인 가이드 선택"]);
  await f.search("가이드 디자인");
  assert.deepEqual(labels(f), ["디자인 가이드 선택"]);
  assert.equal(f.actions.length, 0);
});

for (const bookmarks of [false, true]) {
  const kind = bookmarks ? "bookmarks" : "tabs";
  test(`${kind}: words can match different fields of one candidate, never different candidates`, async () => {
    const f = fixture([
      { ...tab("Design Guide", "https://example.org/reference/guide"), folderPath: "Work / Reading" },
      { ...tab("Design Only", "https://example.org/unrelated"), folderPath: "Elsewhere" },
      { ...tab("Other", "https://example.org/reference"), folderPath: "Reading" }
    ], { bookmarks });
    await f.open(); await f.search(bookmarks ? "reading reference DESIGN" : "reference DESIGN");
    assert.deepEqual(labels(f), ["Design Guide 선택"]);
    await f.search("unrelated guide"); assert.deepEqual(labels(f), []);
    await f.search("missing Design"); assert.deepEqual(labels(f), []);
    assert.equal(f.fetches(), 1); assert.equal(f.actions.length, 0);
  });

  test(`${kind}: search explains the shared all-words rule through its accessible description`, async () => {
    const f = fixture(undefined, { bookmarks }); await f.open();
    const hint = f.$("dialog-body").querySelector("#candidate-search-help");
    assert.ok(hint, "a visible short hint explains order-independent search");
    assert.equal(f.filter().getAttribute("aria-describedby"), hint.id);
    assert.match(hint.textContent, /순서.*모든 단어/u);
    assert.match(hint.textContent, bookmarks ? /폴더/u : /이름·주소/u);
  });

  test(`${kind}: blank, repeated and Unicode whitespace searches preserve candidate order and only deduplicate words`, async () => {
    const f = fixture([tab("Design Guide", "https://example.org/one"), tab("Guide Design", "https://example.org/two"), tab("Other", "https://example.org/three")], { bookmarks });
    await f.open(); const all = labels(f);
    for (const query of ["", " \t\n\u3000 "]) {
      await f.search(query); assert.deepEqual(labels(f), all);
    }
    for (const query of ["GUIDE design", "  design\tGUIDE\n design  ", "guide\u3000Design"]) {
      await f.search(query); assert.deepEqual(labels(f), all.slice(0, 2));
      assert.equal(f.filter().value, query);
    }
    assert.equal(f.actions.length, 0);
  });

  test(`${kind}: punctuation and encoded URL text are literal, not operators or decoded aliases`, async () => {
    const f = fixture([
      tab('Design [Guide] "alpha"', "https://example.org/%E6%97%85%E8%A1%8C?a=one#two"),
      tab("Design Guide alpha", "https://example.org/other")
    ], { bookmarks });
    await f.open();
    for (const query of ['[guide] "alpha"', "#two design", "%e6%97%85 design"]) {
      await f.search(query); assert.deepEqual(labels(f), ['Design [Guide] "alpha" 선택']);
    }
    for (const query of ["旅行 design", "design|guide", "design .*", "design -guide", '"Design Guide"']) {
      await f.search(query); assert.deepEqual(labels(f), []);
    }
  });

  test(`${kind}: reversed and empty-result searches preserve hidden selection, existing destination and new-group draft`, async () => {
    const f = fixture([tab("디자인 가이드", "https://example.org/design"), tab("Keep", "https://example.org/keep")], { bookmarks });
    const before = structuredClone(f.run("state"));
    await f.open(); await f.check("Keep"); await f.target("destination");
    await f.clickText("새 그룹에 담기");
    const name = f.$("dialog-body").querySelector(".candidate-new-group-name");
    const parent = f.$("dialog-body").querySelector(".candidate-new-group-parent");
    name.value = "모을 자료"; await name.emit("input"); parent.value = "group:parent"; await parent.emit("change");
    await f.search("가이드 디자인"); await f.check("디자인 가이드");
    assert.equal(f.count(), "2개 선택 · 화면 밖 1개 포함");
    await f.search("없는 결과"); assert.equal(f.count(), "2개 선택 · 화면 밖 2개 포함");
    await f.search(" "); assert.equal(f.count(), "2개 선택"); assert.ok(f.checks().every(check => check.checked));
    assert.equal(name.value, "모을 자료"); assert.equal(parent.value, "group:parent");
    await f.clickText("기존 그룹에 담기");
    assert.equal(f.$("dialog-body").querySelector(".candidate-target-group").value, "destination");
    await f.clickText("새 그룹에 담기");
    assert.equal(name.value, "모을 자료"); assert.equal(parent.value, "group:parent");
    assert.equal(f.actions.length, 0); assert.deepEqual(structuredClone(f.run("state")), before);
    await f.$("dialog-cancel").emit("click"); assert.equal(f.actions.length, 0);
  });
}
