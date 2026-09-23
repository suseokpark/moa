import test from "node:test";
import assert from "node:assert/strict";
import { prepareLinkInput } from "../src/link-entry.js";

test("address-first entry accepts a domain and supplies an optional title", () => {
  assert.deepEqual(prepareLinkInput({ url: " example.com/docs " }), { url: "https://example.com/docs", title: "example.com" });
  assert.deepEqual(prepareLinkInput({ url: "https://www.example.com/a", title: "  업무 문서  " }), { url: "https://www.example.com/a", title: "업무 문서" });
  assert.equal(prepareLinkInput({ url: "https://www.example.com" }).title, "example.com");
  assert.equal(prepareLinkInput({ url: "http://localhost:4175/docs" }).url, "http://localhost:4175/docs");
});

test("entry normalization does not weaken existing URL security rules", () => {
  for (const url of ["", "just some words", "javascript:alert(1)", "data:text/html,a", "file:///tmp/a", "chrome://settings", "https:", "https://user:pass@example.com", "example.com/?token=secret", "example.com/oauth/callback", "example.com\\bad", "example.com\n/bad"]) {
    assert.throws(() => prepareLinkInput({ url }), undefined, url);
  }
});

test("optional titles are bounded and invalid inputs fail before saving", () => {
  assert.throws(() => prepareLinkInput({ url: "example.com", title: "a".repeat(301) }));
  assert.throws(() => prepareLinkInput({ url: "example.com", title: "a\nb" }));
  assert.throws(() => prepareLinkInput({ url: null }));
  assert.throws(() => prepareLinkInput({ url: "example.com", title: {} }));
});
