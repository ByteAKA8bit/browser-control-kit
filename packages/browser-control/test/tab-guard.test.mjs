// Why these exist: the tab guard decides what happens in the operator's own
// Chrome. Its policy is deliberately not "you get N tabs" — it recycles idle
// tabs, admits new ones only while the machine has room, blanks before it
// closes, and protects everything that was open before we attached. Those are
// judgement calls with sharp edges, so they are pinned here against a fake
// browser. No real browser needed: this suite must run when Chrome is closed.
//
//   node --test test/tab-guard.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TabGuard, guardContext, headroom, tabCeiling } from "../src/tab-guard.mjs";

/** Minimal stand-in for a Playwright Page: url, navigation, close, events. */
function fakePage(url = "https://example.com/") {
  const listeners = new Map();
  return {
    _closed: false,
    _navigations: [],
    url() {
      return url;
    },
    isClosed() {
      return this._closed;
    },
    on(event, fn) {
      listeners.set(event, fn);
    },
    emit(event, arg) {
      listeners.get(event)?.(arg);
    },
    evaluate: async () => undefined,
    async goto(to) {
      this._navigations.push(to);
      url = to;
    },
    async close() {
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
/** Default: plenty of memory, no recycling, no reaping — each test opts in. */
const guardFor = (context, options = {}) =>
  new TabGuard(context, { idleMs: 0, blankMs: 0, recycleMs: 0, settleMs: 0, headroom: () => 1, ...options });
/** Make a tab look untouched for `ms`. */
const age = (guard, page, ms) => {
  guard.owned.get(page).lastUsed = Date.now() - ms;
};

describe("TabGuard ownership", () => {
  it("never counts or closes the tabs the operator already had open", async () => {
    const mine = fakePage("https://news.example/");
    const context = fakeContext([mine]);
    const guard = guardFor(context, { ceiling: 1 });

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
    const guard = guardFor(context, { ceiling: 3 });
    await context.newPage("https://popup.example/"); // not via guard.newPage()
    await settled();
    assert.equal(guard.owned.size, 1);
    assert.equal(guard.report().tabs[0].origin, "spawned");
    guard.dispose();
  });

  it("ignores the extension bridge's own tab", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 2 });
    await context.newPage("chrome-extension://abc/connect.html");
    await settled();
    assert.equal(guard.owned.size, 0);
    guard.dispose();
  });

  it("remembers the bridge tab by identity, even if someone navigates it away", async () => {
    const bridge = fakePage("chrome-extension://abc/connect.html");
    const context = fakeContext([bridge]);
    const guard = guardFor(context);

    await bridge.goto("about:blank"); // the dom-input suite used to do exactly this
    assert.equal(await guard.closeBridge(), 1, "a navigated-away bridge tab is still the bridge tab");
    assert.equal(bridge._closed, true);
    guard.dispose();
  });
});

describe("TabGuard admission", () => {
  it("reuses an idle tab instead of opening a second one", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 4, recycleMs: 50 });

    const first = await guard.newPage();
    age(guard, first, 10_000);
    const second = await guard.newPage();

    assert.equal(second, first, "an idle tab we own is the next tab");
    assert.equal(guard.owned.size, 1, "recycling does not grow the browser");
    assert.equal(guard.stats.recycled, 1);
    assert.deepEqual(first._navigations, ["about:blank"], "a recycled tab is blanked, not handed over dirty");
    guard.dispose();
  });

  it("opens a tab when every tab it owns is busy", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 4, recycleMs: 50 });

    const busy = await guard.newPage();
    guard.hold(busy); // held: in use, not available for recycling
    age(guard, busy, 10_000);
    const extra = await guard.newPage();

    assert.notEqual(extra, busy);
    assert.equal(guard.owned.size, 2, "real concurrency gets real tabs");
    guard.dispose();
  });

  it("takes an idle tab back instead of growing when memory is tight", async () => {
    const context = fakeContext([fakePage()]);
    let room = 1;
    const guard = guardFor(context, { ceiling: 10, headroom: () => room });

    const first = await guard.newPage();
    room = 0.02; // the machine is now under pressure
    const second = await guard.newPage();

    assert.equal(first._closed, true, "the least recently used tab pays for the new one");
    assert.equal(second._closed, false);
    assert.equal(guard.owned.size, 1, "pressure keeps the footprint flat without a quota");
    assert.equal(guard.stats.evicted, 1);
    guard.dispose();
  });

  it("grants the tab anyway when pressure has nothing to reclaim — and reclaims sooner instead", async () => {
    const context = fakeContext([fakePage()]);
    let room = 1;
    const guard = guardFor(context, { ceiling: 10, headroom: () => room, idleMs: undefined, blankMs: undefined, recycleMs: undefined });
    const working = await guard.newPage();
    guard.hold(working); // the only tab we own, and it is in use
    guard.cadence = 8_000; // a deliberate caller: windows clear of both floor and cap
    const relaxed = guard.idleAfter();

    room = 0.02;
    const second = await guard.newPage();

    assert.notEqual(second, working, "refusing would have freed nothing and broken the caller");
    assert.equal(guard.stats.grantedUnderPressure, 1);
    assert.ok(guard.idleAfter() < relaxed, `pressure must shorten the idle window: ${guard.idleAfter()} vs ${relaxed}`);
    guard.dispose();
  });

  it("respects the transport ceiling when nothing can be evicted", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 1 });
    const held = await guard.newPage();
    guard.hold(held);

    await assert.rejects(() => guard.newPage(), /transport tolerates 1 attached tabs/);
    guard.dispose();
  });

  it("applies the same limits to popups it never asked for", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 1 });
    const asked = await guard.newPage();
    const popup = await context.newPage("https://popup.example/"); // window.open
    await settled();

    assert.equal(guard.owned.size, 1, "a popup cannot push us over the ceiling");
    assert.equal(asked._closed, true, "the older tab is the one that goes");
    assert.equal(popup._closed, false);
    guard.dispose();
  });

  it("with eviction disabled it refuses instead of silently closing a tab", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 1, evict: false });
    const kept = await guard.newPage();
    await assert.rejects(() => guard.newPage(), /cannot open another tab/);
    assert.equal(kept._closed, false);
    guard.dispose();
  });

  it("releasing a hold makes the tab available again", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 1 });
    const working = await guard.newPage();
    const release = guard.hold(working);
    release();

    const next = await guard.newPage();
    assert.equal(working._closed, true);
    assert.equal(next._closed, false);
    guard.dispose();
  });
});

describe("TabGuard reclaiming", () => {
  it("blanks an idle tab before it closes it: memory back first, tab later", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3, idleMs: 10_000, blankMs: 50 });
    const page = await guard.newPage();
    await page.goto("https://heavy.example/app");
    age(guard, page, 1_000);

    const first = await guard.reap();
    assert.deepEqual(first, { reaped: 0, blanked: 1 });
    assert.equal(page.url(), "about:blank", "the renderer's page is handed back");
    assert.equal(page._closed, false, "the tab itself is still there");

    age(guard, page, 20_000);
    const second = await guard.reap();
    assert.equal(second.reaped, 1);
    assert.equal(page._closed, true);
    guard.dispose();
  });

  it("never reclaims a held tab", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3, idleMs: 50, blankMs: 10 });
    const working = await guard.newPage();
    await working.goto("https://heavy.example/app");
    guard.hold(working);
    age(guard, working, 10_000);

    assert.deepEqual(await guard.reap(), { reaped: 0, blanked: 0 });
    assert.equal(working._closed, false);
    assert.equal(working.url(), "https://heavy.example/app");
    guard.dispose();
  });

  it("activity on a tab postpones reclaiming", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3, idleMs: 50 });
    const page = await guard.newPage();
    age(guard, page, 10_000);

    page.emit("load"); // the guard listens for load/framenavigated
    assert.equal((await guard.reap()).reaped, 0);
    assert.equal(page._closed, false);
    guard.dispose();
  });

  it("is off when the idle window is pinned to 0", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3, idleMs: 0 });
    const page = await guard.newPage();
    age(guard, page, 10_000_000);
    assert.deepEqual(await guard.reap(), { reaped: 0, blanked: 0 });
    assert.equal(page._closed, false);
    guard.dispose();
  });
});

describe("measured windows", () => {
  it("learns the caller's rhythm instead of trusting a constant", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3, idleMs: undefined, blankMs: undefined, recycleMs: undefined });
    const page = await guard.newPage();
    const seeded = guard.cadence;

    for (let i = 0; i < 20; i += 1) {
      guard.touch(page); // a caller hammering the page: tiny gaps
    }
    assert.ok(guard.cadence < seeded, `a fast caller should shrink the beat, got ${guard.cadence}`);
    assert.ok(guard.recycleAfter() >= 1_000, "but never below the floor");
    guard.dispose();
  });

  it("does not learn from a pause, so a thinking agent keeps its tab", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3, idleMs: undefined, blankMs: undefined, recycleMs: undefined });
    const page = await guard.newPage();
    guard.touch(page);
    const before = guard.cadence;

    guard._lastTouch = Date.now() - 10 * 60_000; // ten minutes away from the keyboard
    guard.touch(page);

    assert.equal(guard.cadence, before, "a ten-minute gap is a pause, not a rhythm");
    guard.dispose();
  });

  it("orders the windows: reuse before blanking before closing", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { idleMs: undefined, blankMs: undefined, recycleMs: undefined });
    assert.ok(guard.recycleAfter() < guard.blankAfter(), "a tab is reusable long before it is blanked");
    assert.ok(guard.blankAfter() < guard.idleAfter(), "memory comes back before the tab does");
    guard.dispose();
  });

  it("lets an explicit number win over the measurement", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { recycleMs: 42, blankMs: 4242, idleMs: 42_424 });
    assert.equal(guard.recycleAfter(), 42);
    assert.equal(guard.blankAfter(), 4242);
    assert.equal(guard.idleAfter(), 42_424);
    guard.dispose();
  });
});

describe("TabGuard last-tab rule", () => {
  it("never leaves the browser with no tabs at all", async () => {
    const context = fakeContext([]); // not even a bridge tab
    const guard = guardFor(context, { ceiling: 2 });
    const only = await guard.newPage();

    const { closed, kept } = await guard.closeOwned();
    assert.equal(closed, 0);
    assert.equal(kept, 1);
    assert.equal(only._closed, false);
    guard.dispose();
  });
});

describe("policy inputs", () => {
  it("reads headroom as a fraction of this machine's memory", () => {
    const room = headroom();
    assert.ok(room > 0 && room <= 1, `headroom should be a fraction, got ${room}`);
  });

  it("keeps the extension ceiling below the raw-CDP one, and lets the operator pin it", () => {
    assert.ok(tabCeiling("extension") < tabCeiling("cdp"), "the bridge tolerates fewer tabs than raw CDP");
    process.env.BC_TAB_BUDGET = "7";
    try {
      assert.equal(tabCeiling("extension"), 7, "an explicit number wins over the transport default");
    } finally {
      delete process.env.BC_TAB_BUDGET;
    }
  });
});

describe("guardContext", () => {
  it("routes newPage through the policy and exposes the guard", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 1 });
    const governed = guardContext(context, guard);

    assert.equal(governed.tabGuard, guard);
    const first = await governed.newPage();
    const second = await governed.newPage();
    assert.equal(first._closed, true, "the policy applies to plain context.newPage() too");
    assert.equal(guard.owned.size, 1);
    assert.equal(governed.pages().includes(second), true, "everything else passes through");
    guard.dispose();
  });
});
