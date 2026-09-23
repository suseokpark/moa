import assert from "node:assert/strict";
import test from "node:test";
import { createCloudClient } from "../src/cloud-client.js";

function withLocation(t, protocol) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "location", original);
    else delete globalThis.location;
  });
}

function fakeChrome(sendMessage = async () => ({ ok: true })) {
  const messages = [];
  return { messages, api: { runtime: { id: "ebbgmhdbonpillbfjapebljagnbjembj", async sendMessage(message) {
    messages.push(message);
    return sendMessage(message);
  } } } };
}

for (const protocol of ["http:", "chrome-extension:"]) {
  test(`cloud client pauses every operation without runtime messages in ${protocol}`, async t => {
    withLocation(t, protocol);
    const f = fakeChrome(async () => { throw new Error("runtime must remain untouched"); });
    const client = createCloudClient(f.api);
    for (const result of await Promise.all([client.status(), client.connect(), client.disconnect(), client.upload(3, "account"), client.list("account"), client.read("file", "account")])) {
      assert.equal(result.ok, false);
      assert.equal(result.code, "CLOUD_PAUSED");
      assert.match(result.error, /JSON/u);
    }
    assert.deepEqual(f.messages, []);
  });
}
