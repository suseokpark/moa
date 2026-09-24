import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_GROUP_ID } from "../src/link-library.js";
import { deferred, fixture, flush } from "../test-support/candidate-picker-fixture.mjs";

// Exercise shipped dialog/event handlers and the reducer with synthetic storage.
// This does not claim native browser, Chrome permissions, or user-data QA.
const clone = value => structuredClone(value);
const latestCatalog = f => clone(f.context.initial.catalog);
const target = f => f.$("dialog-body").querySelector(".edit-target-group");
const reviewButton = f => f.$("dialog-body").querySelector(".edit-review-button");
const note = f => f.$("dialog-body").querySelector(".edit-review-note");
const ack = f => f.$("dialog-body").querySelector(".edit-review-ack");
const input = (f, label) => f.$("dialog-body").querySelectorAll("label").find(element => element.children[0]?.textContent === label)?.querySelector("input");
const currentLink = f => f.run('flattenGroups(library()).flatMap(({group}) => group.links).find(link => link.id === "saved")');
const visible = control => {
  if (!control) return false;
  for (let element = control; element; element = element.parentElement) if (element.hidden) return false;
  return true;
};
async function open(f, kind = "add") {
  if (kind === "add") f.run('linkDialog(null, { groupId: "destination" })');
  else { f.context.testLink = clone(currentLink(f)); f.run(kind === "edit" ? "linkDialog(testLink)" : "moveDialog(testLink)"); }
  if (kind !== "move") {
    input(f, "웹 주소").value = "https://example.org/my-draft";
    input(f, "이름 (선택)").value = "My draft";
  } else { const select = f.$("dialog-body").querySelector("select"); select.value = "destination"; await select.emit("change"); }
}
async function conflict(f, catalog = latestCatalog(f), revision = 8) {
  f.setCatalog(catalog, revision);
  f.setResponse(async () => ({ ok: false, conflict: true, code: "CONFLICT", error: "다른 창에서 목록이 변경되었습니다.", catalog, revision }));
  await f.submit();
}
async function review(f) {
  const control = reviewButton(f); assert.ok(control, "explicit latest-list review control exists");
  assert.equal(visible(control), true); assert.match(control.textContent, /입력 유지하고 최신 목록 검토/u);
  await control.emit("click"); await flush();
}
async function choose(f, id) { assert.ok(target(f)); target(f).value = id; await target(f).emit("change"); }

for (const kind of ["add", "edit", "move"]) {
  test(`${kind} link: conflict blocks a second dispatch while preserving the draft`, async () => {
    const f = fixture(); await open(f, kind); await conflict(f);
    assert.equal(f.$("dialog").open, true); assert.equal(f.actions.length, 1); assert.equal(f.loads(), 0);
    assert.equal(f.$("dialog-submit").disabled, true, "stale revision must not remain saveable");
    if (kind !== "move") {
      assert.equal(input(f, "웹 주소").value, "https://example.org/my-draft");
      assert.equal(input(f, "이름 (선택)").value, "My draft");
    }
    await f.submit(); assert.equal(f.actions.length, 1, "direct submit cannot bypass the guard");
    assert.ok(reviewButton(f));
  });
}

for (const kind of ["edit", "move"]) {
  test(`${kind} link: moving its unchanged source group between same-named parents still requires path review`, async () => {
    const f = fixture(), initial = latestCatalog(f), source = initial.libraries[0].groups[0].links.pop();
    initial.libraries[0].groups.push(
      { id: "parent-a", name: "Same parent", links: [], collapsed: false, groups: [
        { id: "same-leaf", name: "Same leaf", links: [source], collapsed: false, groups: [] }
      ] },
      { id: "parent-b", name: "Same parent", links: [], collapsed: false, groups: [] }
    );
    f.setCatalog(initial, 7); f.context.initial = { catalog: initial, revision: 7 }; f.run("adopt(initial)");
    await open(f, kind);
    const latest = latestCatalog(f), groups = latest.libraries[0].groups;
    groups.find(group => group.id === "parent-b").groups.push(groups.find(group => group.id === "parent-a").groups.pop());
    await conflict(f, latest); await review(f);
    assert.equal(f.$("dialog-submit").disabled, true, "same labels and same leaf ID do not mean the same ancestor identity");
    assert.equal(visible(ack(f)), true); assert.equal(Boolean(ack(f).checked), false);
    assert.match(note(f).textContent, /그룹 경로가 바뀌었습니다/u);
    await f.submit(); assert.equal(f.actions.length, 1);
    ack(f).checked = true; await ack(f).emit("change"); f.setResponse(null); await f.submit();
    assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.$("dialog").open, false);
  });
}

test("add link: explicit review keeps draft and target ID, refreshes paths and only a separate submit saves", async () => {
  const f = fixture(); await open(f);
  const latest = latestCatalog(f); latest.libraries[0].groups[1].name = "Renamed parent";
  latest.libraries[0].groups[1].groups[0].name = "Renamed destination";
  await conflict(f, latest); await review(f);
  assert.equal(f.loads(), 1); assert.equal(f.fetches(), 0); assert.equal(f.actions.length, 1);
  assert.equal(input(f, "웹 주소").value, "https://example.org/my-draft");
  assert.equal(input(f, "이름 (선택)").value, "My draft");
  assert.equal(target(f).value, "destination"); assert.match(target(f).selectedOptions[0].textContent, /Renamed parent.*Renamed destination/u);
  assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.$("dialog").open, true);
  f.setResponse(null); await f.submit();
  assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
  assert.equal(f.actions[1].action.groupId, "destination"); assert.equal(f.actions[1].action.libraryId, "library-personal");
  assert.equal(f.actions[1].action.link.title, "My draft"); assert.equal(f.$("dialog").open, false);
});

for (const kind of ["edit", "move"]) {
  test(`${kind} link: an unrelated change needs explicit review but no overwrite acknowledgement`, async () => {
    const f = fixture(); await open(f, kind);
    const latest = latestCatalog(f); latest.libraries[0].groups[1].name = "Renamed parent";
    await conflict(f, latest); await review(f);
    assert.equal(f.actions.length, 1); assert.equal(f.loads(), 1); assert.equal(f.fetches(), 0);
    assert.equal(visible(ack(f)), false); assert.equal(f.$("dialog-submit").disabled, false);
    if (kind === "move") { assert.equal(target(f).value, "destination"); assert.match(target(f).selectedOptions[0].textContent, /Renamed parent/u); }
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
    assert.equal(f.actions[1].action.linkId, "saved"); assert.equal(f.actions[1].action.libraryId, "library-personal");
    assert.equal(f.$("dialog").open, false);
  });

  for (const change of ["title", "url", "group"]) {
    test(`${kind} link: changed ${change} is shown and requires a separate acknowledgement`, async () => {
      const f = fixture(); await open(f, kind);
      const latest = latestCatalog(f), originalGroup = latest.libraries[0].groups[0], saved = originalGroup.links[0];
      if (change === "title") saved.title = "Remote title";
      else if (change === "url") saved.url = "https://example.org/remote-address";
      else { originalGroup.links = []; latest.libraries[0].groups[1].links.push(saved); }
      await conflict(f, latest); await review(f);
      const comparison = f.$("dialog-body").querySelector(".edit-review-comparison");
      assert.ok(comparison); assert.equal(visible(comparison), true);
      assert.match(comparison.textContent, change === "title" ? /Remote title/u : change === "url" ? /https:\/\/example.org\/remote-address/u : /Parent/u);
      assert.equal(visible(ack(f)), true); assert.equal(Boolean(ack(f).checked), false);
      assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1);
      if (kind === "edit") {
        assert.equal(input(f, "이름 (선택)").value, "My draft"); assert.equal(input(f, "웹 주소").value, "https://example.org/my-draft");
        input(f, "이름 (선택)").value = "Revised draft"; await input(f, "이름 (선택)").emit("input");
        assert.equal(f.$("dialog-submit").disabled, true, "typing is not overwrite acknowledgement");
      }
      ack(f).checked = true; await ack(f).emit("change"); assert.equal(f.$("dialog-submit").disabled, false);
      f.setResponse(null); await f.submit();
      assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
      assert.equal(f.actions[1].action.libraryId, "library-personal");
      if (kind === "edit") assert.equal(f.actions[1].action.title, "Revised draft");
      else {
        assert.equal(f.actions[1].action.targetGroupId, "destination");
        const moved = f.run('flattenGroups(library()).find(({group}) => group.id === "destination").group.links[0]');
        assert.equal(moved.title, saved.title); assert.equal(moved.url, saved.url);
      }
    });
  }

  for (const removed of ["link", "library"]) {
    test(`${kind} link: deleted ${removed} cannot be reinterpreted as a new link or another library`, async () => {
      const f = fixture(); await open(f, kind); const latest = latestCatalog(f);
      if (removed === "link") latest.libraries[0].groups[0].links = [];
      else latest.libraries.shift();
      await conflict(f, latest); await review(f);
      assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, true);
      assert.equal(visible(f.$("dialog-body").querySelector(".edit-target-library")), false);
      if (kind === "edit") {
        assert.equal(input(f, "이름 (선택)").value, "My draft"); assert.equal(input(f, "웹 주소").value, "https://example.org/my-draft");
      }
      assert.ok(note(f)?.textContent); await f.submit(); assert.equal(f.actions.length, 1); assert.equal(f.fetches(), 0);
    });
  }
}

for (const kind of ["add", "move"]) {
  test(`${kind} link: a removed destination requires a fresh explicit group choice`, async () => {
    const f = fixture(); await open(f, kind); const latest = latestCatalog(f); latest.libraries[0].groups[1].groups = [];
    await conflict(f, latest); await review(f);
    assert.equal(target(f).value, ""); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); assert.equal(f.actions.length, 1);
    await choose(f, "parent"); assert.equal(f.$("dialog-submit").disabled, false);
    f.setResponse(null); await f.submit(); assert.equal(f.actions[1].expectedRevision, 8);
    assert.equal(f.actions[1].action[kind === "add" ? "groupId" : "targetGroupId"], "parent");
  });
}

test("add link: removed original library requires explicit library and group even when system group IDs match", async () => {
  const f = fixture(); await open(f); await choose(f, SYSTEM_GROUP_ID);
  const latest = latestCatalog(f); latest.libraries.shift();
  await conflict(f, latest); await review(f);
  const select = f.$("dialog-body").querySelector(".edit-target-library");
  assert.equal(visible(select), true); assert.equal(select.value, ""); assert.equal(target(f).value, "");
  assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1);
  select.value = "other-library"; await select.emit("change");
  assert.equal(target(f).value, "", "a matching system ID in another library is not destination consent");
  assert.equal(f.$("dialog-submit").disabled, true); await choose(f, SYSTEM_GROUP_ID);
  assert.equal(input(f, "이름 (선택)").value, "My draft");
  f.setResponse(null); await f.submit();
  assert.equal(f.actions[1].action.libraryId, "other-library"); assert.equal(f.actions[1].action.groupId, SYSTEM_GROUP_ID);
  assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.fetches(), 0);
});

for (const kind of ["add", "edit", "move"]) {
  test(`${kind} link: SAVE_FAILED is retryable without a conflict review or losing inputs`, async () => {
    const f = fixture(); await open(f, kind);
    f.setResponse(async () => ({ ok: false, code: "SAVE_FAILED", error: "저장하지 못했습니다." }));
    await f.submit();
    assert.equal(f.$("dialog").open, true); assert.equal(f.$("dialog-submit").disabled, false); assert.equal(f.loads(), 0);
    assert.equal(visible(reviewButton(f)), false);
    if (kind !== "move") assert.equal(input(f, "이름 (선택)").value, "My draft");
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 2); assert.equal(f.actions[0].expectedRevision, 7); assert.equal(f.actions[1].expectedRevision, 7);
    assert.equal(f.$("dialog").open, false);
  });

  test(`${kind} link: second conflict requires a new explicit read instead of silently advancing revision`, async () => {
    const f = fixture(); await open(f, kind); await conflict(f); await review(f);
    const latest = latestCatalog(f); latest.libraries[0].name = "Changed again";
    await conflict(f, latest, 9);
    assert.equal(f.actions.length, 2); assert.equal(f.actions[1].expectedRevision, 8);
    assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 2);
    await review(f); assert.equal(f.loads(), 2); assert.equal(f.fetches(), 0);
    f.setResponse(null); await f.submit(); assert.equal(f.actions.length, 3); assert.equal(f.actions[2].expectedRevision, 9);
  });
}

for (const kind of ["edit", "move"]) {
  test(`${kind} link: acknowledgement is reset after a second conflict and new remote values are reviewed`, async () => {
    const f = fixture(); await open(f, kind); const latest = latestCatalog(f); latest.libraries[0].groups[0].links[0].title = "First remote title";
    await conflict(f, latest); await review(f); ack(f).checked = true; await ack(f).emit("change");
    const newer = clone(latest); newer.libraries[0].groups[0].links[0].title = "Second remote title";
    await conflict(f, newer, 9); assert.equal(f.$("dialog-submit").disabled, true);
    await review(f); assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
    assert.match(f.$("dialog-body").querySelector(".edit-review-comparison").textContent, /Second remote title/u);
    await f.submit(); assert.equal(f.actions.length, 2);
    ack(f).checked = true; await ack(f).emit("change"); f.setResponse(null); await f.submit();
    assert.equal(f.actions[2].expectedRevision, 9); assert.equal(f.$("dialog").open, false);
  });
}

for (const kind of ["add", "edit", "move"]) {
  test(`${kind} link: failed latest reads stay locked and do not leak raw diagnostics`, async () => {
    for (const fail of ["throw", "result"]) {
      const f = fixture(); await open(f, kind); await conflict(f);
      f.setLoadResponse(async () => {
        if (fail === "throw") throw new Error("private storage diagnostic");
        return { ok: false, error: "private storage diagnostic" };
      });
      await review(f); assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1);
      assert.doesNotMatch(f.$("dialog-body").textContent + f.$("dialog-error").textContent, /private storage diagnostic/u);
      if (kind !== "move") assert.equal(input(f, "이름 (선택)").value, "My draft");
      f.setLoadResponse(null); await review(f); assert.equal(f.loads(), 2); assert.equal(f.$("dialog-submit").disabled, false);
    }
  });
}

test("add link: invalid or older latest snapshots cannot unlock stale saves", async () => {
  for (const invalid of ["older", "negative", "fractional", "unsafe", "missing-revision", "missing-catalog", "bad-catalog"]) {
    const f = fixture(); await open(f); await conflict(f);
    const result = { ok: true, catalog: latestCatalog(f), revision: 8 };
    if (invalid === "older") result.revision = 7;
    if (invalid === "negative") result.revision = -1;
    if (invalid === "fractional") result.revision = 8.5;
    if (invalid === "unsafe") result.revision = Number.MAX_SAFE_INTEGER + 1;
    if (invalid === "missing-revision") delete result.revision;
    if (invalid === "missing-catalog") delete result.catalog;
    if (invalid === "bad-catalog") result.catalog = { libraries: [] };
    f.setLoadResponse(async () => result); await review(f);
    assert.equal(f.$("dialog-submit").disabled, true, invalid); assert.equal(f.run("state.revision"), 8, invalid);
    await f.submit(); assert.equal(f.actions.length, 1, invalid); assert.equal(input(f, "이름 (선택)").value, "My draft");
  }
});

test("edit link: pending review blocks duplicate reads/saves and cancellation discards the response", async () => {
  const f = fixture(), pending = deferred(); await open(f, "edit"); await conflict(f);
  f.setLoadResponse(() => pending.promise); await reviewButton(f).emit("click"); await flush();
  assert.equal(f.loads(), 1); assert.equal(f.$("dialog-submit").disabled, true);
  await reviewButton(f).emit("click"); await flush(); await f.submit();
  assert.equal(f.loads(), 1); assert.equal(f.actions.length, 1); assert.equal(f.$("dialog-cancel").disabled, false);
  await f.$("dialog-cancel").emit("click"); assert.equal(f.$("dialog").open, false);
  const newest = latestCatalog(f); newest.libraries[0].name = "Not adopted after cancellation";
  pending.resolve({ ok: true, catalog: newest, revision: 9 }); await flush();
  assert.equal(f.run("state.revision"), 8); assert.equal(f.$("dialog").open, false); assert.equal(f.actions.length, 1);
});

test("move link: stale review response cannot alter a replacement dialog", async () => {
  const f = fixture(), pending = deferred(); await open(f, "move"); await conflict(f);
  f.setLoadResponse(() => pending.promise); await reviewButton(f).emit("click"); await flush();
  await f.$("dialog-cancel").emit("click"); f.run('nameDialog("그룹 만들기", {type: "addGroup"})');
  const body = f.$("dialog-body").children[0], error = f.$("dialog-error").textContent;
  pending.resolve({ ok: true, catalog: latestCatalog(f), revision: 9 }); await flush();
  assert.equal(f.$("dialog-title").textContent, "그룹 만들기"); assert.equal(f.$("dialog-body").children[0], body);
  assert.equal(f.$("dialog-error").textContent, error); assert.equal(f.$("dialog-submit").disabled, false);
  assert.equal(f.run("state.revision"), 8); assert.equal(f.actions.length, 1);
});

test("add link: a load older than background state cannot change the draft target or enable save", async () => {
  const f = fixture(), pending = deferred(); await open(f); await conflict(f);
  f.setLoadResponse(() => pending.promise); await reviewButton(f).emit("click"); await flush();
  f.context.newer = { catalog: latestCatalog(f), revision: 10 }; f.run("adopt(newer)");
  pending.resolve({ ok: true, catalog: latestCatalog(f), revision: 9 }); await flush();
  assert.equal(f.run("state.revision"), 10); assert.equal(f.$("dialog-submit").disabled, true);
  assert.equal(input(f, "이름 (선택)").value, "My draft"); await f.submit(); assert.equal(f.actions.length, 1);
});

for (const kind of ["add", "edit", "move"]) {
  test(`${kind} link: the original library remains the target even if background navigation changes`, async () => {
    const f = fixture(); await open(f, kind);
    f.run('libraryId = "other-library"; render();');
    await conflict(f); assert.equal(f.actions[0].action.libraryId, "library-personal");
    await review(f); f.setResponse(null); await f.submit();
    assert.equal(f.actions[1].action.libraryId, "library-personal"); assert.equal(f.actions[1].expectedRevision, 8);
    assert.equal(f.run('state.catalog.libraries.find(item => item.id === "other-library").groups[0].links.length'), 0);
  });
}

test("edit link: an unrelated icon update survives explicit review and saving typed fields", async () => {
  const f = fixture(); await open(f, "edit"); const latest = latestCatalog(f); latest.libraries[0].groups[0].links[0].icon = "🌿";
  await conflict(f, latest); await review(f);
  assert.equal(visible(ack(f)), false); f.setResponse(null); await f.submit();
  assert.equal(f.run('library().groups[0].links[0].icon'), "🌿"); assert.equal(f.run('library().groups[0].links[0].title'), "My draft");
});

test("edit link: unchecking acknowledgement relocks overwrite and cannot be bypassed by submitting", async () => {
  const f = fixture(); await open(f, "edit"); const latest = latestCatalog(f); latest.libraries[0].groups[0].links[0].title = "Remote title";
  await conflict(f, latest); await review(f);
  ack(f).checked = true; await ack(f).emit("change"); assert.equal(f.$("dialog-submit").disabled, false);
  ack(f).checked = false; await ack(f).emit("change"); assert.equal(f.$("dialog-submit").disabled, true);
  f.setResponse(null); await f.submit(); assert.equal(f.actions.length, 1); assert.equal(f.$("dialog").open, true);
});

for (const kind of ["add", "edit"]) {
  test(`${kind} link: reviewing a conflict does not bypass URL validation on the next save`, async () => {
    const f = fixture(); await open(f, kind); await conflict(f); await review(f);
    input(f, "웹 주소").value = "javascript:alert(1)"; await input(f, "웹 주소").emit("input");
    f.setResponse(null); await f.submit();
    assert.equal(f.actions.length, 1); assert.equal(f.$("dialog").open, true);
    assert.equal(input(f, "웹 주소").getAttribute("aria-invalid"), "true");
    input(f, "웹 주소").value = "example.org/corrected"; await input(f, "웹 주소").emit("input");
    await f.submit(); assert.equal(f.actions[1].expectedRevision, 8);
    const result = f.actions[1].action;
    assert.equal(kind === "add" ? result.link.url : result.url, "https://example.org/corrected");
    assert.equal(f.$("dialog").open, false);
  });
}

for (const kind of ["edit", "move"]) {
  for (const renamed of ["source-group", "ancestor"]) {
    test(`${kind} link: a renamed ${renamed} changes the displayed source path and requires acknowledgement`, async () => {
      const f = fixture();
      if (renamed === "ancestor") {
        const initial = latestCatalog(f), source = initial.libraries[0].groups[0];
        initial.libraries[0].groups[1].groups[0].links.push(source.links.pop());
        f.setCatalog(initial, 7); f.context.initial = { catalog: initial, revision: 7 }; f.run("adopt(initial)");
      }
      await open(f, kind); if (kind === "move") await choose(f, "parent");
      const latest = latestCatalog(f);
      latest.libraries[0].groups[renamed === "ancestor" ? 1 : 0].name = "Renamed source path";
      await conflict(f, latest); await review(f);
      assert.match(f.$("dialog-body").querySelector(".edit-review-comparison").textContent, /Renamed source path/u);
      assert.equal(visible(ack(f)), true); assert.equal(Boolean(ack(f).checked), false);
      assert.equal(f.$("dialog-submit").disabled, true); await f.submit(); assert.equal(f.actions.length, 1);
      ack(f).checked = true; await ack(f).emit("change"); f.setResponse(null); await f.submit();
      assert.equal(f.actions[1].expectedRevision, 8); assert.equal(f.$("dialog").open, false);
    });
  }

  test(`${kind} link: a second conflict with unchanged remote values still resets acknowledgement`, async () => {
    const f = fixture(); await open(f, kind); const latest = latestCatalog(f); latest.libraries[0].groups[0].links[0].title = "Remote title";
    await conflict(f, latest); await review(f); ack(f).checked = true; await ack(f).emit("change");
    await conflict(f, clone(latest), 9); await review(f);
    assert.equal(Boolean(ack(f).checked), false); assert.equal(f.$("dialog-submit").disabled, true);
    await f.submit(); assert.equal(f.actions.length, 2);
    ack(f).checked = true; await ack(f).emit("change"); f.setResponse(null); await f.submit();
    assert.equal(f.actions[2].expectedRevision, 9); assert.equal(f.$("dialog").open, false);
  });

  test(`${kind} link: a matching link ID in another library is never substituted for a deleted original`, async () => {
    for (const removeLibrary of [false, true]) {
      const f = fixture(); await open(f, kind); const latest = latestCatalog(f);
      latest.libraries[1].groups[0].links.push({ id: "saved", title: "Different library link", url: "https://example.org/different", icon: "", provider: "generic" });
      if (removeLibrary) latest.libraries.shift(); else latest.libraries[0].groups[0].links = [];
      await conflict(f, latest); await review(f);
      assert.equal(f.$("dialog-submit").disabled, true); assert.equal(visible(ack(f)), false);
      await f.submit(); assert.equal(f.actions.length, 1); assert.equal(f.$("dialog").open, true);
      assert.doesNotMatch(f.$("dialog-body").querySelector(".edit-review-comparison").textContent, /Different library link/u);
    }
  });
}

for (const kind of ["add", "edit", "move"]) {
  test(`${kind} link: review disables editable controls while leaving both cancellation controls available`, async () => {
    const f = fixture(), pending = deferred(); await open(f, kind); await conflict(f);
    f.setLoadResponse(() => pending.promise); await reviewButton(f).emit("click"); await flush();
    assert.ok(f.$("dialog-body").querySelectorAll("input,select,button").every(control => control.disabled));
    assert.equal(f.$("dialog-submit").disabled, true);
    assert.equal(f.$("dialog-close").disabled, false); assert.equal(f.$("dialog-cancel").disabled, false);
    pending.resolve({ ok: true, catalog: latestCatalog(f), revision: 8 }); await flush();
    assert.equal(reviewButton(f).disabled, false); assert.equal(f.$("dialog-submit").disabled, false);
    if (kind !== "move") {
      assert.equal(input(f, "웹 주소").disabled, false); assert.equal(input(f, "이름 (선택)").disabled, false);
      assert.equal(input(f, "이름 (선택)").value, "My draft");
    }
    if (kind !== "edit") assert.equal(target(f).disabled, false);
    assert.equal(f.actions.length, 1); assert.equal(f.loads(), 1);
  });
}
