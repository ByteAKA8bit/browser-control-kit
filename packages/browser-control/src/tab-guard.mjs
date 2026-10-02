// Keep an agent from eating the operator's RAM one tab at a time.
//
// The failure mode this exists for: an LLM agent driving this library opens a
// tab per step ("let me check that in a new tab"), never closes anything, and
// twenty minutes later Chrome is holding 40 renderer processes — in the browser
// the operator is personally using. Agents do not reliably clean up, so the
// budget is enforced here instead of being asked for politely.
//
// Policy (all of it opt-outable, none of it silent):
//   * BUDGET — the tool may own at most N tabs. Asking for one more evicts the
//     least-recently-used tab we own, it does not grow the browser.
//   * OWNERSHIP — only tabs this process opened (or popups they spawned) are
//     ours. Every tab that existed at attach() time is the operator's and is
//     never closed, never navigated, never counted.
//   * IDLE REAPING — a tab we own that has done nothing for BC_TAB_IDLE_MS is
//     closed. This is what actually gives the memory back during a long run.
//   * HOLDS — TabPool (and anyone else with a long-lived tab) calls hold() so a
//     working tab is never evicted or reaped out from under it.
//
// Constraints inherited from src/pool.mjs (learned by killing Chrome 152):
// closing is serialised with a settle delay, and the browser is never left with
// no tabs at all, because then it exits and takes the extension bridge with it.
//
// Known blind spot on the extension transport: a tab the extension may not
// attach to (chrome:// WebUI, the Web Store, another extension's page, file://
// without file access) never becomes a Playwright page, so it never shows up in
// context.pages() and this guard cannot see or close it. Those are also the
// tabs an agent is least likely to spawn in bulk.
import { MAX_TABS, MAX_TABS_EXTENSION } from "./pool.mjs";

// Same sessionStorage marker as src/pool.mjs and cleanup.mjs: tabs we own stay
// recognisable across runs, so `npm run cleanup` can finish the job if a process
// is killed before it can tidy up.
const MARKER = "bcPoolTab";
const TAB_SETTLE_MS = Number(process.env.BC_TAB_SETTLE_MS ?? 400);
// 0 disables reaping. Default 5 min: long enough that a slow task keeps its tab,
// short enough that an abandoned one does not survive a coffee break.
const IDLE_MS = Number(process.env.BC_TAB_IDLE_MS ?? 300_000);
const REAP_EVERY_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tabs the tool may own by default, per transport. */
export function defaultBudget(mode) {
  const override = Number(process.env.BC_TAB_BUDGET ?? NaN);
  if (Number.isFinite(override) && override > 0) return override;
  return mode === "extension" ? MAX_TABS_EXTENSION : MAX_TABS;
}

/**
 * Track and cap the tabs this process opens in the operator's browser.
 * @param {import("playwright-core").BrowserContext} context
 * @param {{ mode?: string, budget?: number, idleMs?: number, evict?: boolean, settleMs?: number }} options
 */
export class TabGuard {
  constructor(context, { mode = "extension", budget, idleMs = IDLE_MS, evict = process.env.BC_TAB_EVICT !== "0", settleMs = TAB_SETTLE_MS } = {}) {
    this.context = context;
    this.mode = mode;
    this.budget = budget ?? defaultBudget(mode);
    this.idleMs = idleMs;
    this.evict = evict;
    this.settleMs = settleMs;
    /** Pages that existed before we attached: the operator's, off limits. */
    this.protectedPages = new Set(context.pages());
    /**
     * The relay's own tabs, remembered BY IDENTITY: a caller that navigates one
     * away (the dom-input suite used to grab `pages()[0]`) would otherwise hide
     * it from a URL match, and it leaked one tab per run.
     */
    this.bridgePages = new Set(context.pages().filter((p) => p.url().startsWith("chrome-extension://")));
    /** page -> { origin, bornAt, lastUsed, holds } */
    this.owned = new Map();
    this.stats = { created: 0, spawned: 0, evicted: 0, reaped: 0, refused: 0, closed: 0, overflow: 0 };
    this._closeChain = Promise.resolve();
    this._timer = null;
    this._creating = 0; // tabs opened through newPage() arrive as "page" events too
    this._onPage = (page) => this.adopt(page, this._creating > 0 ? "created" : "spawned");
    this.context.on("page", this._onPage);
    if (this.idleMs > 0) {
      this._timer = setInterval(() => void this.reap(), REAP_EVERY_MS);
      this._timer.unref?.(); // never keep the process alive just to reap
    }
    // Last line of defence. A caller that forgets browser.close(), a test that
    // throws, a Ctrl-C — none of them may leave tabs in the operator's browser,
    // and sixteen leaked bridge tabs say politeness is not a strategy.
    this._reclaim = async () => {
      if (this._reclaiming) return;
      this._reclaiming = true;
      await this.closeOwned().catch(() => {});
      if (this.mode === "extension" && process.env.BC_KEEP_BRIDGE_TAB !== "1") await this.closeBridge().catch(() => {});
    };
    this._onBeforeExit = () => void this._reclaim();
    this._onSignal = async () => {
      await this._reclaim();
      process.exit(130);
    };
    process.once("beforeExit", this._onBeforeExit);
    process.once("SIGINT", this._onSignal);
    process.once("SIGTERM", this._onSignal);
  }

  /** Start tracking a tab we are responsible for. */
  adopt(page, origin = "spawned") {
    if (!page || this.owned.has(page) || this.protectedPages.has(page)) return page;
    if (page.url?.().startsWith("chrome-extension://")) return page; // the bridge's own tab
    const now = Date.now();
    this.owned.set(page, { origin, bornAt: now, lastUsed: now, holds: 0 });
    this.stats[origin === "created" ? "created" : "spawned"] += 1;
    page.on?.("close", () => this.owned.delete(page));
    // Activity signals, cheap ones: a tab that navigates or loads is in use.
    page.on?.("load", () => this.touch(page));
    page.on?.("framenavigated", () => this.touch(page));
    void this.#mark(page);
    // A tab we did not ask for (window.open, target=_blank) can push us over
    // budget, so the ceiling is re-applied here and not only in newPage().
    if (origin !== "created") void this.#trim();
    return page;
  }

  /** Record activity so the reaper and the LRU eviction order stay honest. */
  touch(page) {
    const entry = this.owned.get(page);
    if (entry) entry.lastUsed = Date.now();
    return page;
  }

  /** Pin a tab: held tabs are never evicted or reaped (TabPool uses this). */
  hold(page) {
    const entry = this.owned.get(page) ?? this.owned.get(this.adopt(page, "held"));
    if (entry) entry.holds += 1;
    return () => this.unhold(page);
  }

  unhold(page) {
    const entry = this.owned.get(page);
    if (entry) entry.holds = Math.max(0, entry.holds - 1);
  }

  /**
   * The governed replacement for context.newPage(): makes room first, so the tab
   * count stays flat no matter how enthusiastic the caller is.
   */
  async newPage() {
    await this.#makeRoom(1);
    this._creating += 1;
    try {
      const page = await this.context.newPage();
      await sleep(this.settleMs); // serialise attach churn (see pool.mjs SAFETY GATE)
      return this.adopt(page, "created");
    } finally {
      this._creating -= 1;
    }
  }

  /** Close every tab we own (called before browser.close()). */
  async closeOwned() {
    const victims = [...this.owned.keys()];
    let closed = 0;
    for (const page of victims) {
      if (await this.#close(page, "release")) closed += 1;
    }
    return { closed, kept: victims.length - closed };
  }

  /** Close tabs we own that have been idle for longer than the budgeted time. */
  async reap() {
    if (this.idleMs <= 0) return { reaped: 0 };
    const deadline = Date.now() - this.idleMs;
    let reaped = 0;
    for (const [page, entry] of [...this.owned]) {
      if (entry.holds > 0 || entry.lastUsed > deadline) continue;
      if (await this.#close(page, "idle")) {
        this.stats.reaped += 1;
        reaped += 1;
      }
    }
    return { reaped };
  }

  /** What the guard is doing, for logs and for the agent to read back. */
  report() {
    const tabs = [...this.owned.entries()].map(([page, entry]) => ({
      url: page.url?.().slice(0, 70) ?? "",
      origin: entry.origin,
      held: entry.holds > 0,
      idleMs: Date.now() - entry.lastUsed,
    }));
    return {
      budget: this.budget,
      owned: this.owned.size,
      operatorTabs: this.protectedPages.size,
      idleMs: this.idleMs,
      evict: this.evict,
      ...this.stats,
      tabs,
    };
  }

  /** Stop reaping and let go of the context (does not close anything). */
  dispose() {
    clearInterval(this._timer);
    this._timer = null;
    this.context.off?.("page", this._onPage);
    process.off("beforeExit", this._onBeforeExit);
    process.off("SIGINT", this._onSignal);
    process.off("SIGTERM", this._onSignal);
  }

  async #makeRoom(wanted) {
    while (this.owned.size + wanted > this.budget) {
      const victim = this.#lru();
      if (!victim) {
        this.stats.refused += 1;
        throw new Error(
          `tab budget exhausted: ${this.owned.size}/${this.budget} tabs are in use and none can be evicted. ` +
            "Close a tab, finish the work holding it, or raise BC_TAB_BUDGET — the browser is the operator's, " +
            "and unbounded tabs are how it ends up swapping (see src/tab-guard.mjs).",
        );
      }
      if (!(await this.#close(victim, "evict"))) {
        this.owned.delete(victim); // could not close it; stop counting it as ours
        continue;
      }
      this.stats.evicted += 1;
    }
  }

  /**
   * Re-apply the ceiling after a tab arrived uninvited. Unlike #makeRoom this
   * cannot throw — nobody is waiting on a window.open — so an unevictable
   * overflow is recorded and reported instead.
   */
  async #trim() {
    while (this.owned.size > this.budget) {
      const victim = this.#lru();
      if (!victim) {
        this.stats.overflow += 1;
        return;
      }
      if (await this.#close(victim, "evict")) this.stats.evicted += 1;
      else this.owned.delete(victim);
    }
  }

  /** Least-recently-used tab we own and are allowed to close. */
  #lru() {
    if (!this.evict) return null;
    let best = null;
    let bestAt = Infinity;
    for (const [page, entry] of this.owned) {
      if (entry.holds > 0 || page.isClosed?.()) continue;
      if (entry.lastUsed < bestAt) {
        best = page;
        bestAt = entry.lastUsed;
      }
    }
    return best;
  }

  /** Serialised, settle-delayed close that refuses to empty the browser. */
  #close(page, why) {
    const run = this._closeChain.then(async () => {
      if (!this.owned.has(page)) return false;
      if (page.isClosed?.()) {
        this.owned.delete(page);
        return false;
      }
      // Count every tab we can see, the bridge's connect.html included: it is a
      // real tab holding Chrome open, and on the extension transport it is often
      // the ONLY other tab we can see (the operator's are not enumerable).
      const alive = this.context.pages().filter((p) => !p.isClosed?.());
      if (alive.length <= 1) return false; // with no tabs left the browser exits
      await page.close().catch(() => {});
      await sleep(this.settleMs);
      this.owned.delete(page);
      this.stats.closed += 1;
      return true;
    });
    this._closeChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Marker is set after navigation — NEVER via addInitScript on extension. */
  async #mark(page) {
    await page.evaluate?.((m) => sessionStorage.setItem(m, "1"), MARKER).catch(() => {});
  }

  /**
   * The relay opens its own chrome-extension://…/connect.html tab for every
   * attach() and never closes it: sixteen runs left sixteen tabs in the
   * operator's browser (measured 2026-10-02). Letting go of the browser means
   * letting go of that tab too — deliberately ignoring the keep-one-tab rule,
   * because this tab only exists to serve a connection we are abandoning.
   */
  async closeBridge() {
    const live = this.context.pages().filter((p) => !p.isClosed?.());
    const bridges = live.filter((p) => this.bridgePages.has(p) || /chrome-extension:\/\/.*\/(connect|status)\.html/.test(p.url()));
    for (const page of bridges) await page.close().catch(() => {}); // the relay may already be tearing down
    return bridges.length;
  }
}

/**
 * A BrowserContext that routes tab creation through the guard. Everything else
 * passes straight through, so callers cannot tell the difference — except that
 * `context.newPage()` now respects the budget and `context.tabGuard` exists.
 */
export function guardContext(context, guard) {
  return new Proxy(context, {
    get(target, prop, receiver) {
      if (prop === "tabGuard") return guard;
      if (prop === "newPage") return () => guard.newPage();
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A Browser whose close() hands the tabs back first. An agent that forgets to
 * tidy up still leaves the browser as it found it.
 */
export function guardBrowser(browser, guard) {
  return new Proxy(browser, {
    get(target, prop, receiver) {
      if (prop === "close") {
        return async (...args) => {
          await guard.closeOwned().catch(() => {});
          // BC_KEEP_BRIDGE_TAB=1 keeps the relay's tab for debugging the bridge.
          if (guard.mode === "extension" && process.env.BC_KEEP_BRIDGE_TAB !== "1") await guard.closeBridge().catch(() => {});
          guard.dispose();
          return await target.close(...args).catch(() => {}); // closing the bridge tab can race the relay's own teardown
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
