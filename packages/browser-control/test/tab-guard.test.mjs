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
import { readFile } from "node:fs/promises";
import { TabGuard, guardContext, tabCeiling } from "../src/tab-guard.mjs";

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
const guardFor = (context, options = {}) => new TabGuard(context, { idleMs: 0, blankMs: 0, recycleMs: 0, settleMs: 0, ...options });
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

  it("evicts an idle tab rather than exceeding the transport ceiling", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 1 });

    const first = await guard.newPage();
    const second = await guard.newPage();

    assert.equal(first._closed, true, "the least recently used tab pays for the new one");
    assert.equal(second._closed, false);
    assert.equal(guard.owned.size, 1, "the footprint stays flat");
    assert.equal(guard.stats.evicted, 1);
    guard.dispose();
  });

  it("never asks the operating system how much memory is left", async () => {
    // Deliberate: system memory is reported differently on every platform and
    // other applications move it under us. The guard governs its own footprint.
    const source = await readFile(new URL("../src/tab-guard.mjs", import.meta.url), "utf8");
    assert.ok(!/freemem|totalmem|vm_stat|MEMORY_FLOOR/.test(source), "tab-guard must not probe the machine");
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

  it("keeps a tab that was used more recently than the recycle window", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 4, recycleMs: 60_000 });

    const working = await guard.newPage();
    age(guard, working, 1_000); // quiet for a second, not for a window
    const next = await guard.newPage();

    assert.notEqual(next, working, "a tab somebody used a second ago is not spare capacity");
    assert.equal(guard.stats.recycled, 0);
    assert.equal(guard.owned.size, 2);
    guard.dispose();
  });

  it("never recycles a tab whose renderer died without telling us", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 4, recycleMs: 50 });

    const dead = await guard.newPage();
    age(guard, dead, 10_000);
    dead._closed = true; // renderer gone; no "close" event ever arrives

    const next = await guard.newPage();
    assert.notEqual(next, dead, "the idlest tab we own is still a corpse");
    assert.equal(next.isClosed(), false);
    assert.equal(guard.stats.recycled, 0);
    guard.dispose();
  });

  it("breaks a tie between equally idle tabs on the older one, not the newer", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 2 });

    const first = await guard.newPage();
    const second = await guard.newPage();
    age(guard, first, 10_000);
    guard.owned.get(second).lastUsed = guard.owned.get(first).lastUsed; // exactly as idle

    await guard.newPage();
    assert.equal(first._closed, true, "a tie goes to the tab we have had longest");
    assert.equal(second._closed, false);
    assert.equal(guard.stats.evicted, 1);
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

  it("refuses to evict the last tab, and stops counting a tab it cannot close", async () => {
    const context = fakeContext([]); // the browser has nothing else of its own
    const guard = guardFor(context, { ceiling: 1 });

    const first = await guard.newPage();
    const second = await guard.newPage(); // the ceiling says evict; the browser says no

    assert.equal(first._closed, false, "closing it would exit the browser and take the bridge with it");
    assert.equal(guard.stats.evicted, 0);
    assert.equal(guard.stats.closed, 0);
    assert.equal(guard.owned.has(first), false, "a tab we cannot close is no longer counted as ours");
    assert.equal(guard.owned.size, 1, "so the new tab still fits");
    assert.equal(second._closed, false);
    guard.dispose();
  });

  it("the reaper obeys the same rule: the last tab survives being idle", async () => {
    const context = fakeContext([]);
    const guard = guardFor(context, { ceiling: 3, idleMs: 50 });

    const only = await guard.newPage();
    age(guard, only, 10_000);
    assert.deepEqual(await guard.reap(), { reaped: 0, blanked: 0 });
    assert.equal(only._closed, false);
    assert.equal(guard.owned.size, 1, "kept, and still ours: the refusal is about the browser, not the tab");

    await guard.newPage(); // now there is something else to keep Chrome alive
    age(guard, only, 10_000);
    assert.equal((await guard.reap()).reaped, 1);
    assert.equal(only._closed, true);
    guard.dispose();
  });

  it("does not count a tab the operator already closed towards the survivor", async () => {
    const theirs = fakePage("https://news.example/");
    const context = fakeContext([theirs]);
    const guard = guardFor(context, { ceiling: 2 });
    const mine = await guard.newPage();

    await theirs.close(); // the operator closed their own tab while we worked
    const { closed, kept } = await guard.closeOwned();

    assert.equal(closed, 0, "a closed tab keeps nothing alive");
    assert.equal(kept, 1);
    assert.equal(mine._closed, false);
    guard.dispose();
  });
});

describe("policy inputs", () => {
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

// Names are the agent-facing lifetime: the caller says what a tab is FOR and
// never touches a handle, so these pin the promises the MCP tools lean on.
describe("named surfaces", () => {
  it("gives the same page back for the same name", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3 });

    const first = await guard.surface("docs");
    await first.goto("https://docs.example/guide");
    age(guard, first, 10_000);
    const again = await guard.surface("docs");

    assert.equal(again, first, "a name means one tab");
    assert.equal(guard.owned.size, 1, "re-requesting a name opens nothing");
    assert.ok(guard.owned.get(first).lastUsed > Date.now() - 1_000, "asking for it counts as using it");
    assert.equal(first.url(), "https://docs.example/guide", "and it is not blanked on the way back");
    guard.dispose();
  });

  it("binds a new name to an idle tab we already own instead of opening one", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 4, recycleMs: 50 });

    const spare = await guard.newPage();
    age(guard, spare, 10_000);
    const bound = await guard.surface("docs");

    assert.equal(bound, spare, "recycling comes before opening, named or not");
    assert.equal(guard.owned.size, 1);
    assert.equal(guard.stats.recycled, 1);
    assert.equal(guard.stats.created, 1, "exactly one tab was ever opened");
    guard.dispose();
  });

  it("the scratch surface is still just newPage()", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 4, recycleMs: 50 });

    const first = await guard.surface();
    age(guard, first, 10_000);
    const second = await guard.surface(null);

    assert.equal(second, first, "unnamed pages are recycled as aggressively as ever");
    assert.deepEqual(guard.surfaces(), [], "and nothing is bound by using it");
    guard.dispose();
  });

  it("survives a reap that takes the unbound tab, and is reapable again once released", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3, idleMs: 50, blankMs: 10 });

    const kept = await guard.surface("docs");
    await kept.goto("https://docs.example/guide");
    const scratch = await guard.newPage();
    age(guard, kept, 10_000);
    age(guard, scratch, 10_000);

    assert.equal((await guard.reap()).reaped, 1, "only the unbound tab goes");
    assert.equal(scratch._closed, true);
    assert.equal(kept._closed, false, "a named surface is not a leak, it is a request");
    assert.equal(kept.url(), "https://docs.example/guide", "nor is it blanked under the name");

    assert.equal(guard.release("docs"), true);
    assert.equal(guard.release("docs"), false, "releasing twice is not a thing");
    age(guard, kept, 10_000);
    assert.equal((await guard.reap()).reaped, 1);
    assert.equal(kept._closed, true, "released means ordinary again");
    guard.dispose();
  });

  it("at the ceiling with everything bound it releases the least-recently-used name instead of refusing", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 2 });

    const one = await guard.surface("one");
    const two = await guard.surface("two");
    age(guard, one, 10_000);
    age(guard, two, 1_000);

    const three = await guard.surface("three");
    assert.equal(three, one, "the oldest name's tab is the one handed over");
    assert.equal(one._closed, false, "reused, not closed: no new renderer either");
    assert.equal(guard.owned.size, 2, "the ceiling holds");
    assert.equal(guard.stats.surfacesEvicted, 1, "losing a name must be visible");
    assert.deepEqual(
      guard.surfaces().map((s) => s.name),
      ["two", "three"],
    );
    assert.equal(guard.report().surfacesEvicted, 1);

    const back = await guard.surface("one");
    assert.notEqual(back, three, "the old name is genuinely gone, not aliased");
    assert.equal(guard.stats.surfacesEvicted, 2);
    guard.dispose();
  });

  it("drops the binding when the tab closes underneath it", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3 });

    const page = await guard.surface("docs");
    await page.close(); // the operator closed it

    assert.deepEqual(guard.surfaces(), []);
    assert.equal(guard.release("docs"), false, "a dead page leaves no binding behind");
    const fresh = await guard.surface("docs");
    assert.notEqual(fresh, page, "asking again gets a live tab, not a corpse");
    assert.equal(fresh._closed, false);
    guard.dispose();
  });

  it("reports what is bound, for humans and for the agent", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3 });

    const docs = await guard.surface("docs");
    await docs.goto("https://docs.example/guide");
    const parked = await guard.surface("parked");
    age(guard, docs, 5_000);

    const view = guard.surfaces();
    assert.deepEqual(
      view.map((s) => s.name),
      ["docs", "parked"],
    );
    assert.deepEqual(Object.keys(view[0]).sort(), ["blanked", "idleMs", "name", "url"]);
    assert.equal(view[0].url, "https://docs.example/guide");
    assert.equal(view[0].blanked, false);
    assert.ok(view[0].idleMs >= 5_000);
    assert.equal(view[1].blanked, true, "a fresh tab is still on about:blank");

    const report = guard.report();
    assert.deepEqual(
      report.surfaces.map((s) => [s.name, s.url, s.blanked]),
      [
        ["docs", "https://docs.example/guide", false],
        ["parked", "about:blank", true],
      ],
    );
    assert.equal(report.tabs.find((t) => t.name === "docs").held, true, "a bound tab reads as held");
    guard.dispose();
  });

  it("refuses an empty name rather than inventing one", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 3 });
    await assert.rejects(() => guard.surface("   "), /non-empty string name/);
    assert.equal(guard.owned.size, 0, "a bad name opens nothing");
    guard.dispose();
  });

  it("spends an unbound tab at the ceiling before it breaks any binding", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 2 });

    const docs = await guard.surface("docs");
    const scratch = await guard.newPage();
    age(guard, docs, 10_000); // the name is the stalest thing we own
    age(guard, scratch, 1_000);

    const notes = await guard.surface("notes");
    assert.equal(scratch._closed, true, "the unbound tab pays, however fresh it is");
    assert.notEqual(notes, docs);
    assert.equal(guard.stats.surfacesEvicted, 0, "no name was lost");
    assert.deepEqual(
      guard.surfaces().map((s) => s.name),
      ["docs", "notes"],
    );
    guard.dispose();
  });

  it("leaves a surface alone while a second holder is working in it", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 2 });

    const busy = await guard.surface("busy");
    guard.hold(busy); // TabPool is driving this tab too
    const spare = await guard.surface("spare");
    age(guard, busy, 10_000); // the stalest name, and still not the victim
    age(guard, spare, 1_000);

    const third = await guard.surface("third");
    assert.equal(third, spare, "only the name itself holds `spare`, so it is the one that can go");
    assert.deepEqual(
      guard.surfaces().map((s) => s.name),
      ["busy", "third"],
    );
    assert.equal(guard.stats.surfacesEvicted, 1);
    assert.equal(guard.owned.size, 2);
    guard.dispose();
  });

  it("refuses rather than taking the tab somebody else is working in", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 1 });

    const only = await guard.surface("one");
    guard.hold(only); // held by the name AND by a worker

    await assert.rejects(() => guard.surface("two"), /transport tolerates 1 attached tabs/);
    assert.equal(guard.stats.surfacesEvicted, 0, "an in-use surface is not evictable capacity");
    assert.equal(guard.stats.refused, 1);
    assert.equal(only._closed, false);
    assert.deepEqual(
      guard.surfaces().map((s) => s.name),
      ["one"],
    );
    guard.dispose();
  });

  it("breaks a tie between equally idle names on the one bound first", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 2 });

    const one = await guard.surface("one");
    const two = await guard.surface("two");
    age(guard, one, 10_000);
    guard.owned.get(two).lastUsed = guard.owned.get(one).lastUsed; // exactly as idle

    const three = await guard.surface("three");
    assert.equal(three, one, "a tie goes to the oldest binding");
    assert.deepEqual(
      guard.surfaces().map((s) => s.name),
      ["two", "three"],
    );
    guard.dispose();
  });

  it("never hands a name the tab of a surface whose renderer died", async () => {
    const context = fakeContext([fakePage()]);
    const guard = guardFor(context, { ceiling: 2 });

    const gone = await guard.surface("gone");
    const live = await guard.surface("live");
    age(guard, gone, 10_000); // stalest, but dead
    age(guard, live, 1_000);
    gone._closed = true; // renderer gone; no "close" event ever arrives

    const fresh = await guard.surface("fresh");
    assert.equal(fresh, live, "a dead tab is not capacity to hand out");
    assert.equal(fresh.isClosed(), false);
    assert.equal(guard.stats.surfacesEvicted, 1);
    assert.equal(guard.owned.size, 2, "and no new renderer was opened either");
    guard.dispose();
  });
});
