// An app's page.goto (daemon/page.ts): it returns once the new page has
// loaded, not while the page it's leaving is still there. A stand-in page
// runs the broker's scripts the way Chromium would, and takes its time to
// swap documents, as a real navigation does.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { cdpPage } from "../../../daemon/page.ts";

type Doc = { id: number; href: string; readyState: string; window: Record<string, unknown> };

// A page whose navigations commit `commit` ms after they're asked for, and
// finish loading `load` ms after that. A change of hash alone keeps the
// document, as in a browser. `never` keeps the old page, as a 204 does.
function standIn(start: string, { commit = 500, load = 300, never = false } = {}) {
  let count = 0;
  const fresh = (href: string, readyState: string): Doc => ({ id: ++count, href, readyState, window: {} });
  const page = { doc: fresh(start, "complete") };
  const assign = (to: string) => {
    const next = new URL(to, page.doc.href);
    const [now, then] = [page.doc.href.split("#")[0], next.href.split("#")[0]];
    if (next.hash && now === then) {
      page.doc.href = next.href;
      return;
    }
    if (never) return;
    setTimeout(() => {
      const doc = fresh(next.href, "loading");
      page.doc = doc;
      setTimeout(() => (doc.readyState = "complete"), load);
    }, commit);
  };
  const devtools = {
    async evaluateIn(_target: string, expression: string) {
      const { doc } = page;
      return runInNewContext(expression, {
        window: doc.window,
        document: { readyState: doc.readyState },
        location: { href: doc.href, assign },
        URL,
      });
    },
  };
  return { page, broker: cdpPage(devtools, () => "the app's page") };
}

test("goto waits for the new page when the navigation is slow to start", async () => {
  const { page, broker } = standIn("https://example.test/", { commit: 500 });
  const before = page.doc.id;
  await broker.call("goto", ["https://example.test/search?q=sintel"]);
  assert.notEqual(page.doc.id, before);
  assert.equal(page.doc.href, "https://example.test/search?q=sintel");
  assert.equal(page.doc.readyState, "complete");
});

test("goto to the address the page is on waits for it to load again", async () => {
  const { page, broker } = standIn("https://example.test/home", { commit: 400 });
  const before = page.doc.id;
  await broker.call("goto", ["https://example.test/home"]);
  assert.notEqual(page.doc.id, before);
  assert.equal(page.doc.readyState, "complete");
});

test("goto to another part of the same page keeps the page, and doesn't wait for a new one", async () => {
  const { page, broker } = standIn("https://example.test/album/7");
  const before = page.doc.id;
  const started = Date.now();
  await broker.call("goto", ["https://example.test/album/7#tracks"]);
  assert.equal(page.doc.id, before);
  assert.equal(page.doc.href, "https://example.test/album/7#tracks");
  assert.ok(Date.now() - started < 2_000);
});

test("goto that never gets a new page fails in its time, with the address", async () => {
  const { broker } = standIn("https://example.test/", { never: true });
  await assert.rejects(broker.call("goto", ["https://example.test/gone", 800]), /the page didn't load https:\/\/example\.test\/gone in time/);
});
