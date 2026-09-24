import assert from "node:assert/strict";
import test from "node:test";
import { MAX_GROUP_DEPTH } from "../src/link-library.js";
import { deferred, fixture, flush } from "../test-support/candidate-picker-fixture.mjs";

// Real shipped modal handlers and color editor, synthetic DOM/storage only.
// These tests do not exercise native rendering or the user's browser data.
const clone = value => structuredClone(value);
const latestCatalog = f => clone(f.context.initial.catalog);
const group = catalog => catalog.libraries[0].groups[1].groups[0];
const input = f => f.$("dialog-body").querySelectorAll("label").find(element => element.children[0]?.textContent === "이름")?.querySelector("input");
const hex = f => f.$("dialog-body").querySelector("#group-color-hex");
const reviewButton = f => f.$("dialog-body").querySelector(".metadata-review-button");
const note = f => f.$("dialog-body").querySelector(".metadata-review-note");
const comparison = f => f.$("dialog-body").querySelector(".metadata-review-comparison");
const ack = f => f.$("dialog-body").querySelector(".metadata-review-ack");
const visible = control => {
  if (!control) return false;
  for (let element = control; element; element = element.parentElement) if (element.hidden) return false;
  return true;
};
function open(f, kind = "renameGroup") {
  if (kind === "color") {
    f.run('groupColorDialog(flattenGroups(library()).find(({group}) => group.id === "destination").group)');
    hex(f).value = "#BADA55";
  } else {
    const action = kind === "nested" ? { type: "addGroup", parentGroupId: "destination" }
      : kind === "renameGroup" ? { type: kind, groupId: "destination" }
      : kind === "renameLibrary" ? { type: kind, libraryId: "library-personal" }
      : { type: kind };
    f.context.testAction = action;
    f.run('nameDialog("Metadata edit", testAction, "Original")');
    input(f).value = "  My draft  ";
  }
}
async function conflict(f, catalog = latestCatalog(f), revision = 8) {
  f.setCatalog(catalog, revision);
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "다른 창에서 목록이 변경되었습니다.", catalog, revision }));
  await f.submit();
}
async function review(f) {
  const control = reviewButton(f); assert.ok(control, "explicit metadata review exists");
  assert.equal(visible(control), true); assert.match(control.textContent, /입력 유지하고 최신 목록 검토/u);
  await control.emit("click"); await flush();
}
async function acknowledge(f, checked = true) {
  assert.ok(ack(f)); ack(f).checked = checked; await ack(f).emit("change");
}
function assertDraft(f, kind) { assert.equal(kind === "color" ? hex(f).value : input(f).value, kind === "color" ? "#BADA55" : "  My draft  "); }

for (const kind of ["renameGroup", "renameLibrary", "nested", "color"]) {
  test(`${kind} metadata: conflict preserves raw draft and blocks stale second dispatch`, async () => {
    const f = fixture(); open(f, kind); await conflict(f);
    assert.equal(f.$("dialog").open, true); assert.equal(f.actions.length, 1); assert.equal(f.loads(), 0);
    assertDraft(f, kind); assert.equal(f.$("dialog-submit").disabled, true);
    assert.match(f.$("dialog-error").textContent, /다른 창/u);
    await f.submit(); assert.equal(f.actions.length, 1, "direct submit cannot bypass the stale guard");
    assert.ok(reviewButton(f)); assert.equal(f.$("dialog-submit").disabled, true);
    assert.match(note(f).textContent, /다른 화면.*최신.*검토/u);
  });
}

const kinds = ["addLibrary", "renameLibrary", "addGroup", "nested", "renameGroup", "color"];
for (const kind of kinds) {
  test(`${kind} metadata: unrelated changes need a read and separate save, without overwrite acknowledgement`, async () => {
    const f = fixture(); open(f, kind); const latest = latestCatalog(f);
    latest.libraries[1].name = "Changed elsewhere";
    await conflict(f, latest); await review(f);
    assert.equal(f.loads(), 1); assert.equal(f.fetches(), 0); assert.equal(f.actions.length, 1);
    assertDraft(f, kind); assert.equal(f.$("dialog").open, true);
    assert.equal(visible(ack(f)), false); assert.equal(f.$("dialog-submit").disabled, false);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
    assert.equal(f.actions[1].action.type, kind === "nested" ? "addGroup" : kind === "color" ? "setGroupColor" : kind);
    assert.equal(f.actions[1].action[kind === "color" ? "color" : "name"], kind === "color" ? "#bada55" : "My draft");
    assert.equal(f.$("dialog").open, false);
    assert.equal(f.run('state.catalog.libraries.find(value => value.id === "other-library").name'), "Changed elsewhere");
  });

  test(`${kind} metadata: ordinary SAVE_FAILED retains the existing retry path`, async () => {
    const f = fixture(); open(f, kind);
    f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }));
    await f.submit(); assertDraft(f, kind); assert.equal(f.$("dialog").open, true);
    assert.equal(f.$("dialog-submit").disabled, false); assert.equal(visible(reviewButton(f)), false);
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 7);
    assert.equal(f.loads(), 0); assert.equal(f.$("dialog").open, false);
  });
}

for (const kind of ["renameLibrary", "renameGroup", "nested", "color"]) {
  for (const change of kind === "renameLibrary" ? ["library"] : ["name", "ancestor", "library"]) {
    test(`${kind} metadata: changed ${change} is compared and requires explicit acknowledgement`, async () => {
      const f = fixture(); open(f, kind); const latest = latestCatalog(f);
      if (change === "library") latest.libraries[0].name = "Remote library";
      else if (change === "ancestor") latest.libraries[0].groups[1].name = "Remote ancestor";
      else group(latest).name = "Remote name";
      await conflict(f, latest); await review(f);
      assert.equal(visible(comparison(f)), true);
      assert.match(comparison(f).textContent, change === "library" ? /Remote library/u : change === "ancestor" ? /Remote ancestor/u : /Remote name/u);
      assert.equal(visible(ack(f)), true); assert.equal(Boolean(ack(f).checked), false);
      assert.equal(f.$("dialog-submit").disabled, true); assertDraft(f, kind);
      await f.submit(); assert.equal(f.actions.length, 1);
      if (kind !== "color") { input(f).value = "Revised draft"; await input(f).emit("input"); assert.equal(f.$("dialog-submit").disabled, true); }
      await acknowledge(f); assert.equal(f.$("dialog-submit").disabled, false);
      await acknowledge(f, false); assert.equal(f.$("dialog-submit").disabled, true);
      await f.submit(); assert.equal(f.actions.length, 1);
      await acknowledge(f); f.setResponse(null); await f.submit();
      assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.$("dialog").open, false);
    });
  }
}

test("color metadata: changed color compares original and latest but preserves the user's draft", async () => {
  const f = fixture(), initial = latestCatalog(f); group(initial).color = "#112233";
  f.setCatalog(initial, 7); f.context.initial = { catalog: initial, revision: 7 }; f.run("adopt(initial)");
  open(f, "color"); const latest = latestCatalog(f); group(latest).color = "#667788";
  await conflict(f, latest); await review(f);
  assert.match(comparison(f).textContent.toLowerCase(), /#112233/u); assert.match(comparison(f).textContent.toLowerCase(), /#667788/u);
  assert.equal(f.$("dialog-submit").disabled, true); assertDraft(f, "color");
  await acknowledge(f); f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].action.color, "#bada55"); assert.equal(f.actions[1].expectedRevision, 8);
});

for (const kind of ["renameGroup", "nested", "color"]) {
  test(`${kind} metadata: same-named ancestors with different identities still require path review`, async () => {
    const f = fixture(), initial = latestCatalog(f); initial.libraries[0].groups[1].name = "Same parent";
    initial.libraries[0].groups.push({ id: "other-parent", name: "Same parent", links: [], groups: [], collapsed: false });
    f.setCatalog(initial, 7); f.context.initial = { catalog: initial, revision: 7 }; f.run("adopt(initial)");
    open(f, kind); const latest = latestCatalog(f);
    latest.libraries[0].groups[2].groups.push(latest.libraries[0].groups[1].groups.pop());
    await conflict(f, latest); await review(f);
    assert.equal(visible(ack(f)), true); assert.equal(f.$("dialog-submit").disabled, true);
    assertDraft(f, kind); await f.submit(); assert.equal(f.actions.length, 1);
    await acknowledge(f); f.setResponse(null); await f.submit(); assert.equal(f.actions[1].expectedRevision, 8);
  });

  test(`${kind} metadata: deleted group/parent is not silently recreated or changed to root`, async () => {
    const f = fixture(); open(f, kind); const latest = latestCatalog(f); latest.libraries[0].groups[1].groups = [];
    latest.libraries[1].groups.push({ id: "destination", name: "Unrelated same ID", links: [], groups: [], collapsed: false });
    await conflict(f, latest); await review(f);
    assert.equal(f.$("dialog-submit").disabled, true); assertDraft(f, kind); assert.ok(note(f).textContent);
    assert.equal(visible(ack(f)), false); await f.submit(); assert.equal(f.actions.length, 1);
    assert.doesNotMatch(comparison(f).textContent, /Unrelated same ID/u);
  });
}

for (const kind of kinds.filter(value => value !== "addLibrary")) {
  test(`${kind} metadata: deleting original library cannot redirect to automatic fallback`, async () => {
    const f = fixture(); open(f, kind); const latest = latestCatalog(f); latest.libraries.shift();
    await conflict(f, latest); assert.equal(f.run("libraryId"), "other-library"); await review(f);
    assert.equal(f.$("dialog-submit").disabled, true); assert.equal(visible(ack(f)), false); assertDraft(f, kind);
    await f.submit(); assert.equal(f.actions.length, 1); assert.equal(f.$("dialog").open, true);
    assert.equal(f.run('state.catalog.libraries[0].groups.length'), 1);
  });

  test(`${kind} metadata: background navigation never changes the captured operation library`, async () => {
    const f = fixture(); open(f, kind); f.run('libraryId = "other-library"; render();');
    await conflict(f); assert.equal(f.actions[0].action.libraryId, "library-personal");
    await review(f); f.setResponse(null); await f.submit();
    assert.equal(f.actions[1].action.libraryId, "library-personal"); assert.equal(f.actions[1].expectedRevision, 8);
  });
}

test("addLibrary metadata: origin deletion does not block reviewed global creation or select someone else's new library", async () => {
  const f = fixture(); open(f, "addLibrary"); const latest = latestCatalog(f); latest.libraries.shift();
  latest.libraries[0].name = "Created elsewhere";
  await conflict(f, latest); await review(f); assertDraft(f, "addLibrary");
  assert.equal(f.$("dialog-submit").disabled, false); assert.equal(visible(ack(f)), false);
  assert.equal(f.run("libraryId"), "other-library"); f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.run("library().name"), "My draft");
  assert.notEqual(f.run("libraryId"), "other-library");
  assert.equal(f.run('state.catalog.libraries.find(value => value.id === "other-library").name'), "Created elsewhere");
});

for (const kind of ["renameLibrary", "renameGroup", "nested", "color"]) {
  test(`${kind} metadata: a second conflict resets acknowledgement even when remote values stay the same`, async () => {
    const f = fixture(); open(f, kind); const latest = latestCatalog(f); latest.libraries[0].name = "Remote name";
    await conflict(f, latest); await review(f); await acknowledge(f);
    await conflict(f, clone(latest), 9); assert.equal(f.actions.length, 2); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); assert.equal(f.actions.length, 2);
    await review(f); assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
    assertDraft(f, kind); await acknowledge(f); f.setResponse(null); await f.submit();
    assert.equal(f.actions[2].expectedRevision, 9); assert.equal(f.loads(), 2); assert.equal(f.fetches(), 0);
  });
}

for (const kind of ["renameGroup", "color"]) {
  test(`${kind} metadata: latest read failures are sanitized and keep saving locked until retried`, async () => {
    for (const failure of ["throw", "result"]) {
      const f = fixture(); open(f, kind); await conflict(f);
      f.setLoadResponse(async () => { if (failure === "throw") throw new Error("private storage diagnostic"); return { ok: false, error: "private storage diagnostic" }; });
      await review(f); assert.equal(f.$("dialog-submit").disabled, true); assertDraft(f, kind);
      assert.doesNotMatch(f.$("dialog-body").textContent + f.$("dialog-error").textContent, /private storage diagnostic/u);
      await f.submit(); assert.equal(f.actions.length, 1); f.setLoadResponse(null); await review(f);
      assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.loads(), 2);
    }
  });

  test(`${kind} metadata: invalid or stale snapshots cannot unlock a save`, async () => {
    for (const invalid of ["older", "negative", "fractional", "unsafe", "missing-revision", "missing-catalog", "bad-catalog"]) {
      const f = fixture(); open(f, kind); await conflict(f); const result = { ok: true, catalog: latestCatalog(f), revision: 8 };
      if (invalid === "older") result.revision = 7;
      if (invalid === "negative") result.revision = -1;
      if (invalid === "fractional") result.revision = 8.5;
      if (invalid === "unsafe") result.revision = Number.MAX_SAFE_INTEGER + 1;
      if (invalid === "missing-revision") delete result.revision;
      if (invalid === "missing-catalog") delete result.catalog;
      if (invalid === "bad-catalog") result.catalog = { libraries: [] };
      f.setLoadResponse(async () => result); await review(f);
      assert.equal(f.$("dialog-submit").disabled, true, invalid); assertDraft(f, kind);
      await f.submit(); assert.equal(f.actions.length, 1, invalid); assert.equal(f.run("state.revision"), 8, invalid);
    }
  });

  test(`${kind} metadata: pending review locks edits and duplicate reads while keeping cancellation available`, async () => {
    const f = fixture(), pending = deferred(); open(f, kind); await conflict(f); f.setLoadResponse(() => pending.promise);
    await reviewButton(f).emit("click"); await flush();
    assert.equal(f.loads(), 1); assert.ok(f.$("dialog-body").querySelectorAll("input,select,button").every(control => control.disabled));
    assert.equal(f.$("dialog-submit").disabled, true); assert.equal(f.$("dialog-close").disabled, false); assert.equal(f.$("dialog-cancel").disabled, false);
    await reviewButton(f).emit("click"); await flush(); await f.submit(); assert.equal(f.loads(), 1); assert.equal(f.actions.length, 1);
    pending.resolve({ ok: true, catalog: latestCatalog(f), revision: 8 }); await flush();
    assert.equal(f.$("dialog-submit").disabled, false); assert.equal(reviewButton(f).disabled, false);
    assert.equal((kind === "color" ? hex(f) : input(f)).disabled, false); assertDraft(f, kind);
  });

  test(`${kind} metadata: cancelling a pending read discards its later response`, async () => {
    const f = fixture(), pending = deferred(); open(f, kind); await conflict(f); f.setLoadResponse(() => pending.promise);
    await reviewButton(f).emit("click"); await flush(); await f.$("dialog-cancel").emit("click");
    assert.equal(f.$("dialog").open, false);
    pending.resolve({ ok: true, catalog: latestCatalog(f), revision: 9 }); await flush();
    assert.equal(f.$("dialog").open, false); assert.equal(f.run("state.revision"), 8); assert.equal(f.actions.length, 1);
  });

  test(`${kind} metadata: stale read cannot mutate a replacement dialog`, async () => {
    const f = fixture(), pending = deferred(); open(f, kind); await conflict(f); f.setLoadResponse(() => pending.promise);
    await reviewButton(f).emit("click"); await flush(); await f.$("dialog-cancel").emit("click");
    f.run('nameDialog("Replacement", {type: "addGroup"})'); const originalBody = f.$("dialog-body").children[0];
    pending.resolve({ ok: true, catalog: latestCatalog(f), revision: 9 }); await flush();
    assert.equal(f.$("dialog-title").textContent, "Replacement"); assert.equal(f.$("dialog-body").children[0], originalBody);
    assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.run("state.revision"), 8); assert.equal(f.actions.length, 1);
  });

  test(`${kind} metadata: a newer background revision defeats an older in-flight read`, async () => {
    const f = fixture(), pending = deferred(); open(f, kind); await conflict(f); f.setLoadResponse(() => pending.promise);
    await reviewButton(f).emit("click"); await flush();
    f.context.newer = { catalog: latestCatalog(f), revision: 10 }; f.run("adopt(newer)");
    pending.resolve({ ok: true, catalog: latestCatalog(f), revision: 9 }); await flush();
    assert.equal(f.run("state.revision"), 10); assert.equal(f.$("dialog-submit").disabled, true); assertDraft(f, kind);
    await f.submit(); assert.equal(f.actions.length, 1);
  });
}

test("renameGroup metadata: saving a name preserves a remotely changed color", async () => {
  const f = fixture(); open(f); const latest = latestCatalog(f); group(latest).color = "#123456";
  await conflict(f, latest); await review(f); assert.equal(visible(ack(f)), false); f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].action.color, undefined);
  assert.equal(f.run('flattenGroups(library()).find(({group}) => group.id === "destination").group.color'), "#123456");
  assert.equal(f.run('flattenGroups(library()).find(({group}) => group.id === "destination").group.name'), "My draft");
});

test("color metadata: saving color preserves a reviewed remote name", async () => {
  const f = fixture(); open(f, "color"); const latest = latestCatalog(f); group(latest).name = "Remote name";
  await conflict(f, latest); await review(f); await acknowledge(f); f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].action.name, undefined);
  assert.equal(f.run('flattenGroups(library()).find(({group}) => group.id === "destination").group.name'), "Remote name");
  assert.equal(f.run('flattenGroups(library()).find(({group}) => group.id === "destination").group.color'), "#bada55");
});

test("color metadata: invalid raw hex survives review and is validated only when saving", async () => {
  const f = fixture(); open(f, "color"); await conflict(f);
  hex(f).value = "#bad"; await hex(f).emit("input"); await review(f);
  assert.equal(hex(f).value, "#bad"); assert.equal(f.actions.length, 1); assert.equal(f.loads(), 1);
  f.setResponse(null); await f.submit();
  assert.equal(f.actions.length, 1); assert.equal(f.$("dialog").open, true); assert.equal(hex(f).getAttribute("aria-invalid"), "true");
  hex(f).value = "#123ABC"; await hex(f).emit("input"); await f.submit();
  assert.equal(f.actions[1].action.color, "#123abc"); assert.equal(f.actions[1].expectedRevision, 8);
});

test("color metadata: invalid save returns focus to the editable hex field after busy controls unlock", async () => {
  const f = fixture(); open(f, "color"); hex(f).value = "#bad"; await hex(f).emit("input");
  f.$("dialog-submit").focus(); assert.equal(f.document.activeElement, f.$("dialog-submit"));
  await f.submit();
  assert.ok(f.document.activeElement === hex(f), "invalid hex field regains focus after validation"); assert.equal(hex(f).disabled, false);
  assert.equal(hex(f).value, "#bad"); assert.equal(hex(f).getAttribute("aria-invalid"), "true");
  assert.equal(f.actions.length, 0); assert.equal(f.$("dialog").open, true);
});

test("color metadata: default color remains an explicit null after review", async () => {
  const f = fixture(); open(f, "color"); await conflict(f);
  await f.clickText("기본 색상"); await review(f); assert.equal(hex(f).value, "");
  f.setResponse(null); await f.submit(); assert.equal(f.actions[1].action.color, null); assert.equal(f.actions[1].expectedRevision, 8);
});

test("nested metadata: a parent moved to maximum depth cannot silently create a root sibling", async () => {
  const f = fixture(); open(f, "nested"); const latest = latestCatalog(f);
  const destination = latest.libraries[0].groups[1].groups.pop();
  let descendant = destination;
  for (let depth = MAX_GROUP_DEPTH - 1; depth >= 1; depth -= 1) {
    descendant = { id: `depth-${depth}`, name: `Depth ${depth}`, links: [], collapsed: false, groups: [descendant] };
  }
  latest.libraries[0].groups.push(descendant);
  await conflict(f, latest); await review(f);
  assert.equal(f.$("dialog-submit").disabled, true); assertDraft(f, "nested");
  assert.match(note(f).textContent, /깊이|단계/u); await f.submit(); assert.equal(f.actions.length, 1);
  if (ack(f)) { await acknowledge(f); await f.submit(); assert.equal(f.actions.length, 1); }
});

for (const kind of ["addGroup", "renameLibrary"]) {
  test(`${kind} metadata: reviewing retains invalid empty draft without silently restoring an old value`, async () => {
    const f = fixture(); open(f, kind); await conflict(f);
    input(f).value = "   "; await input(f).emit("input"); await review(f);
    assert.equal(input(f).value, "   "); assert.equal(f.actions.length, 1);
    input(f).value = "Corrected draft"; await input(f).emit("input"); f.setResponse(null); await f.submit();
    assert.equal(f.actions[1].action.name, "Corrected draft"); assert.equal(f.actions[1].expectedRevision, 8);
  });
}
