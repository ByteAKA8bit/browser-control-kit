// Why these exist: the tab guard is the only thing standing between an agent's
// "let me open one more tab" habit and the operator's RAM. Its boundaries —
// budget, LRU choice, held tabs, the operator's own tabs, the last-tab rule —
// are all decisions that look right until they are not, so they are pinned here
// against a fake context. No browser needed, by design: this suite is the one
// that must still run when Chrome is closed.
//
//   node --test test/tab-guard.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TabGuard, guardContext } from "../src/tab-guard.mjs";

/** Minimal stand-in for a Playwright Page: url, close, event emitter. */
function fakePage(url = "https://example.com/") {
  const listeners = new Map();
  return {
    _url: url,
    _closed: false,
    url: () => url,
    isClosed: () => listeners.get("__closed__") === true,
    on(event, fn) {
      listeners.set(event, fn);
    },
    emit(event, arg) {
      listeners.get(event)?.(arg);
    },
    evaluate: async () => undefined,
    async close() {
      listeners.set("__closed__", true);
      this._closed = true;
      listeners.get("close")?.();
    },
  };
}

/** Minimal stand-in for a BrowserContext. */
function fakeContext(initial = []) {
  const pages = [...initial];
  const handlers = [];
  return {
    pages: () => pages.filter((p) => !p._closed),
    on: (event, fn) => event === "page" && handlers.push(fn),
    off: () => {},
    async newPage(url = "about:blank") {
      const page = fakePage(url);
      pages.push(page);
      for (const fn of handlers) fn(page);
      return page;
    },
  };
}

const settled = () => new Promise((r) => setTimeout(r, 0));
const guardFor = (context, options = {}) => new TabGuard(context, { idleMs: 0, settleMs: 0, ...options });

describe("TabGuard ownership", () => {
  it("never counts or closes the tabs the operator already had open", async () => {
    const mine = fakePage("https://news.example/");
    const context = fakeContext([mine]);
    const guard = guardFor(context, { budget: 1 });

    const opened = await guard.newPage();
    assert.equal(guard.owned.size, 1, "only the tab we opened is ours");
    assert.ok(guard.protectedPages.has(mine));

    await guard.closeOwned();
    assert.equal(mine._closed, false, "the operator's tab survives");
    assert.equal(opened._closed, true);
    guard.dispose();
  });

  it("adopts tabs that appear on their own (window.open, target=_blank)", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 3 });
    await context.newPage("https://popup.example/"); // not via guard.newPage()
    await settled();
    assert.equal(guard.owned.size, 1);
    assert.equal(guard.report().tabs[0].origin, "spawned");
    guard.dispose();
  });

  it("applies the budget to popups it never asked for", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 1 });
    const asked = await guard.newPage();
    const popup = await context.newPage("https://popup.example/"); // window.open
    await settled();
    assert.equal(guard.owned.size, 1, "a popup cannot push us over the ceiling");
    assert.equal(asked._closed, true, "the older tab is the one that goes");
    assert.equal(popup._closed, false);
    guard.dispose();
  });

  it("ignores the extension bridge's own tab", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 2 });
    await context.newPage("chrome-extension://abc/connect.html");
    await settled();
    assert.equal(guard.owned.size, 0);
    guard.dispose();
  });
});

describe("TabGuard budget", () => {
  it("holds the tab count flat by evicting the least recently used tab", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 2 });

    const first = await guard.newPage();
    const second = await guard.newPage();
    guard.touch(second); // second is newer than first
    const third = await guard.newPage();

    assert.equal(guard.owned.size, 2, "budget is a ceiling, not a suggestion");
    assert.equal(first._closed, true, "LRU victim");
    assert.equal(second._closed, false);
    assert.equal(third._closed, false);
    assert.equal(guard.stats.evicted, 1);
    guard.dispose();
  });

  it("refuses to open a tab when every tab it owns is held", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 1 });
    const working = await guard.newPage();
    guard.hold(working);

    await assert.rejects(() => guard.newPage(), /tab budget exhausted/);
    assert.equal(working._closed, false, "a held tab is never sacrificed");
    assert.equal(guard.stats.refused, 1);
    guard.dispose();
  });

  it("releasing a hold makes the tab evictable again", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 1 });
    const working = await guard.newPage();
    const release = guard.hold(working);
    release();

    const next = await guard.newPage();
    assert.equal(working._closed, true);
    assert.equal(next._closed, false);
    guard.dispose();
  });

  it("with eviction disabled it refuses instead of silently closing a tab", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 1, evict: false });
    const kept = await guard.newPage();
    await assert.rejects(() => guard.newPage(), /tab budget exhausted/);
    assert.equal(kept._closed, false);
    guard.dispose();
  });
});

describe("TabGuard reaping", () => {
  it("closes tabs that went idle past the budgeted time, but not held ones", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 3, idleMs: 50 });
    const abandoned = await guard.newPage();
    const working = await guard.newPage();
    guard.hold(working);

    guard.owned.get(abandoned).lastUsed = Date.now() - 10_000;
    guard.owned.get(working).lastUsed = Date.now() - 10_000;
    const { reaped } = await guard.reap();

    assert.equal(reaped, 1);
    assert.equal(abandoned._closed, true);
    assert.equal(working._closed, false);
    guard.dispose();
  });

  it("activity on a tab postpones the reaper", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 3, idleMs: 50 });
    const page = await guard.newPage();
    guard.owned.get(page).lastUsed = Date.now() - 10_000;

    page.emit("load"); // the guard listens for load/framenavigated
    const { reaped } = await guard.reap();

    assert.equal(reaped, 0);
    assert.equal(page._closed, false);
    guard.dispose();
  });

  it("is off when BC_TAB_IDLE_MS is 0", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 3, idleMs: 0 });
    const page = await guard.newPage();
    guard.owned.get(page).lastUsed = 0;
    assert.deepEqual(await guard.reap(), { reaped: 0 });
    assert.equal(page._closed, false);
    guard.dispose();
  });
});

describe("TabGuard last-tab rule", () => {
  it("never closes the final ordinary tab (the browser would exit)", async () => {
    const context = fakeContext([]); // no operator tabs at all
    const guard = guardFor(context, { budget: 2 });
    const only = await guard.newPage();

    const { closed, kept } = await guard.closeOwned();
    assert.equal(closed, 0);
    assert.equal(kept, 1);
    assert.equal(only._closed, false);
    guard.dispose();
  });
});

describe("guardContext", () => {
  it("routes newPage through the budget and exposes the guard", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { budget: 1 });
    const governed = guardContext(context, guard);

    assert.equal(governed.tabGuard, guard);
    const first = await governed.newPage();
    const second = await governed.newPage();
    assert.equal(first._closed, true, "the budget applies to plain context.newPage() too");
    assert.equal(guard.owned.size, 1);
    assert.equal(governed.pages().includes(second), true, "everything else passes through");
    guard.dispose();
  });
});
