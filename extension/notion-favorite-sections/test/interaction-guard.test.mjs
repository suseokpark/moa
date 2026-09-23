import assert from "node:assert/strict";
import test from "node:test";
import { createInteractionGuard } from "../src/interaction-guard.js";

class Target {
  constructor() { this.listeners = new Map(); this.visibilityState = "visible"; }
  addEventListener(type, handler, capture = false) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ handler, capture });
  }
  removeEventListener(type, handler, capture = false) {
    this.listeners.set(type, (this.listeners.get(type) || [])
      .filter(entry => entry.handler !== handler || entry.capture !== capture));
  }
  fire(type, extra = {}) {
    const event = { type, pointerId: 1, isPrimary: true, button: 0, ...extra };
    for (const { handler } of this.listeners.get(type) || []) handler(event);
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, entries) => sum + entries.length, 0); }
}

function fixture() {
  const document = new Target(), window = new Target(), pending = new Map(), cancelled = [];
  let nextId = 0, idles = 0;
  const guard = createInteractionGuard({ eventTarget: document, windowTarget: window,
    onIdle: () => { idles += 1; },
    schedule: callback => { const id = nextId++; pending.set(id, callback); return id; },
    cancel: id => { cancelled.push(id); pending.delete(id); } });
  return { guard, document, window, pending, cancelled, get idles() { return idles; },
    flush() { const tasks = [...pending.values()]; pending.clear(); tasks.forEach(callback => callback()); } };
}

test("pointer guard captures the whole press, release and click dispatch before yielding once", () => {
  const f = fixture();
  assert.equal(f.guard.isActive(), false);
  for (const type of ["pointerdown", "pointerup", "pointercancel"]) {
    assert.equal(f.document.listeners.get(type)[0].capture, true);
  }
  f.document.fire("pointerdown");
  assert.equal(f.guard.isActive(), true);
  assert.equal(f.pending.size, 0, "a held press is not timed out");
  f.document.fire("pointerup");
  assert.equal(f.guard.isActive(), true);
  f.document.fire("click");
  assert.equal(f.guard.isActive(), true, "the original click target must remain mounted");
  assert.equal(f.idles, 0);
  f.flush();
  assert.equal(f.guard.isActive(), false);
  assert.equal(f.idles, 1);
  f.document.fire("pointerup"); f.flush();
  assert.equal(f.idles, 1, "an idle release must not emit twice");
});

test("a fresh press cancels the previous release and stays active until its own release", () => {
  const f = fixture();
  f.document.fire("pointerdown"); f.document.fire("pointerup");
  const previousRelease = [...f.pending.values()][0];
  f.document.fire("pointerdown", { pointerId: 2 });
  assert.deepEqual(f.cancelled, [0], "timer handle zero is cancellable");
  previousRelease(); f.flush();
  assert.equal(f.guard.isActive(), true);
  assert.equal(f.idles, 0, "even a stale queued callback cannot release a new gesture");
  f.document.fire("pointerup", { pointerId: 2 });
  f.flush();
  assert.equal(f.guard.isActive(), false);
  assert.equal(f.idles, 1);
});

test("unrelated pointers and secondary touches cannot end or replace a primary gesture", () => {
  const f = fixture();
  f.document.fire("pointerdown", { pointerId: 7 });
  f.document.fire("pointerdown", { pointerId: 8, isPrimary: false });
  for (const type of ["pointerup", "pointercancel"]) {
    f.document.fire(type, { pointerId: 8 });
    f.document.fire(type, { pointerId: 7, isPrimary: false });
  }
  assert.equal(f.pending.size, 0);
  assert.equal(f.guard.isActive(), true);
  f.document.fire("pointerup", { pointerId: 7 }); f.flush();
  assert.equal(f.idles, 1);
  f.document.fire("pointerdown", { isPrimary: false });
  assert.equal(f.guard.isActive(), false);
});

test("middle and right mouse gestures retain their targets through auxclick", () => {
  for (const button of [1, 2]) {
    const f = fixture();
    f.document.fire("pointerdown", { button }); f.document.fire("pointerup", { button });
    f.document.fire("auxclick", { button });
    assert.equal(f.guard.isActive(), true);
    f.flush();
    assert.equal(f.guard.isActive(), false); assert.equal(f.idles, 1);
  }
});

test("pointer cancellation, window blur and hidden visibility release a lost gesture on the next task", () => {
  for (const completion of ["pointercancel", "blur", "hidden"]) {
    const f = fixture(); f.document.fire("pointerdown");
    if (completion === "blur") f.window.fire("blur");
    else if (completion === "hidden") {
      f.document.visibilityState = "hidden"; f.document.fire("visibilitychange");
    } else f.document.fire("pointercancel");
    assert.equal(f.guard.isActive(), true); assert.equal(f.idles, 0);
    f.flush();
    assert.equal(f.guard.isActive(), false); assert.equal(f.idles, 1);
  }
});

test("visible visibility changes do not release a press, duplicate completion emits idle only once", () => {
  const f = fixture(); f.document.fire("pointerdown");
  f.document.fire("visibilitychange");
  assert.equal(f.pending.size, 0);
  f.document.fire("pointerup"); f.window.fire("blur");
  f.document.visibilityState = "hidden"; f.document.fire("visibilitychange");
  assert.equal(f.pending.size, 1);
  f.flush();
  assert.equal(f.idles, 1);
  f.window.fire("blur"); f.document.fire("visibilitychange"); f.flush();
  assert.equal(f.idles, 1);
});

test("destroy removes every handler, cancels pending work, and never calls idle", () => {
  const f = fixture(); f.document.fire("pointerdown"); f.document.fire("pointerup");
  const queued = [...f.pending.values()][0];
  f.guard.destroy();
  assert.equal(f.document.listenerCount, 0); assert.equal(f.window.listenerCount, 0);
  assert.equal(f.pending.size, 0); assert.equal(f.guard.isActive(), false);
  f.document.fire("pointerdown"); queued(); f.flush();
  assert.equal(f.guard.isActive(), false); assert.equal(f.idles, 0);
  assert.doesNotThrow(() => f.guard.destroy());
});
