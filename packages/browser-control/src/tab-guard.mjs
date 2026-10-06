// Cap the tabs this process opens in the operator's browser, so an agent that
// opens a tab per step cannot fill it with renderer processes (~40-80 MB each).
//
// Non-goals: measuring the machine's memory (every platform reports it
// differently and other applications move the number), and governing tabs this
// process did not open — every tab that existed at attach() time is the
// operator's: never closed, never navigated, never counted.
//
// Invariant: the guard may only touch tabs it adopted, and it cannot adopt what
// it cannot see — a page the extension may not attach to (chrome:// WebUI, the
// Web Store, another extension's page, file://) never reaches context.pages().
import { MARKER, MAX_TABS, MAX_TABS_EXTENSION, TAB_SETTLE_MS, wouldEmptyBrowser } from "./pool.mjs";
import { serialiseNavigation } from "./page.mjs";

/** A tab already parked on about:blank holds no page memory worth reclaiming. */
const isBlank = (page) => {
  const url = page.url?.() ?? "";
  return url === "" || url === "about:blank";
};

// MARKER / TAB_SETTLE_MS / wouldEmptyBrowser come from src/pool.mjs, which owns
// the crash constants. The sessionStorage marker keeps tabs we own recognisable
// across runs (so `npm run cleanup` can finish after a kill); a second spelling
// of it is the difference between reclaiming a tab and leaking it.

// "Is this tab still wanted?" has no correct constant: a crawler touches a tab
// every 200 ms, an agent that stops to think every 30 s. So the windows are
// measured — an EWMA of the gap between operations, ignoring gaps long enough
// to be pauses rather than rhythm — and each decision is a multiple of that
// beat. Floors and caps bound a pathological cadence; BC_TAB_*_MS pins a window
// outright when the operator wants a number.
const CADENCE_SEED_MS = 1_000; // before anything is measured
const CADENCE_ALPHA = 0.3; // EWMA weight of the newest gap
const CADENCE_PAUSE_MS = 120_000; // a gap longer than this is a pause, not rhythm
const RECYCLE = { beats: 5, min: 1_000, max: 60_000, pinned: process.env.BC_TAB_RECYCLE_MS };
const BLANK = { beats: 30, min: 30_000, max: 600_000, pinned: process.env.BC_TAB_BLANK_MS };
const IDLE = { beats: 120, min: 120_000, max: 1_800_000, pinned: process.env.BC_TAB_IDLE_MS };
const REAP_EVERY_MS = 30_000;
const BACKGROUND_MS = 5_000; // how long a background Target.createTarget may take to surface its page
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A window expressed in the caller's own beats, unless it was pinned. */
function window_(spec, cadence) {
  if (spec.pinned !== undefined) return Number(spec.pinned);
  return Math.min(spec.max, Math.max(spec.min, Math.round(cadence * spec.beats)));
}

/**
 * The hard ceiling, for transport stability only: the extension bridge drops
 * the connection past MAX_TABS_EXTENSION attached tabs. BC_TAB_BUDGET pins it.
 */
export function tabCeiling(mode) {
  const pinned = Number(process.env.BC_TAB_BUDGET ?? NaN);
  if (Number.isFinite(pinned) && pinned > 0) return pinned;
  return mode === "extension" ? MAX_TABS_EXTENSION : MAX_TABS;
}

/**
 * Track and cap the tabs this process opens in the operator's browser.
 * @param {import("playwright-core").BrowserContext} context
 * @param {{ mode?: string, ceiling?: number, idleMs?: number, blankMs?: number, recycleMs?: number,
 *          evict?: boolean, settleMs?: number }} options
 */
export class TabGuard {
  constructor(
    context,
    {
      mode = "extension",
      ceiling,
      idleMs,
      blankMs,
      recycleMs,
      evict = process.env.BC_TAB_EVICT !== "0",
      settleMs = TAB_SETTLE_MS,
    } = {},
  ) {
    this.context = context;
    this.mode = mode;
    this.ceiling = ceiling ?? tabCeiling(mode);
    /** Explicit overrides win; otherwise every window is measured. */
    this.pinned = { idleMs, blankMs, recycleMs };
    /** The caller's rhythm: an EWMA of the gap between operations we observe. */
    this.cadence = CADENCE_SEED_MS;
    this.evict = evict;
    this.settleMs = settleMs;
    /** Pages that existed before we attached: the operator's, off limits. */
    this.protectedPages = new Set(context.pages());
    /**
     * The relay's own tabs, remembered BY IDENTITY: a caller that navigates one
     * away hides it from a URL match, and it leaked one tab per run.
     */
    this.bridgePages = new Set(context.pages().filter((p) => p.url().startsWith("chrome-extension://")));
    /** page -> { origin, bornAt, lastUsed, holds, name } */
    this.owned = new Map();
    /** name -> page. One name, one tab; the binding is a hold. */
    this.named = new Map();
    /** The unnamed page. One per guard: an agent that navigates without a name
     * must not get a new renderer (and an eviction) per step. */
    this._scratch = null;
    this.stats = { created: 0, recycled: 0, spawned: 0, evicted: 0, reaped: 0, blanked: 0, refused: 0, closed: 0, overflow: 0, surfacesEvicted: 0 };
    this._closeChain = Promise.resolve();
    this._timer = null;
    this._creating = 0; // tabs opened through newPage() arrive as "page" events too
    this._onPage = (page) => this.adopt(page, this._creating > 0 ? "created" : "spawned");
    this.context.on("page", this._onPage);
    if (this.idleAfter() > 0) {
      this._timer = setInterval(() => void this.reap(), REAP_EVERY_MS);
      this._timer.unref?.(); // never keep the process alive just to reap
    }
    // Last line of defence: a forgotten browser.close(), a throwing test or a
    // Ctrl-C must not leave tabs behind in the operator's browser.
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
    // A tab can go away under us; the name must not outlive the page it meant.
    page.on?.("close", () => {
      this.#unbind(page);
      if (this._scratch === page) this._scratch = null;
      this.owned.delete(page);
    });
    // Activity signals, cheap ones: a tab that navigates or loads is in use.
    page.on?.("load", () => this.touch(page));
    page.on?.("framenavigated", () => this.touch(page));
    void this.#mark(page);
    // A tab we did not ask for (window.open, target=_blank) can push us over
    // budget, so the ceiling is re-applied here and not only in newPage().
    if (origin !== "created") void this.#trim();
    return page;
  }

  /** Record activity; the gap since the previous operation is this caller's beat. */
  touch(page) {
    const now = Date.now();
    const entry = this.owned.get(page);
    if (this._lastTouch) {
      const gap = now - this._lastTouch;
      // A long silence is a pause, not a rhythm: learning it would hoard tabs.
      if (gap >= 0 && gap < CADENCE_PAUSE_MS) this.cadence = CADENCE_ALPHA * gap + (1 - CADENCE_ALPHA) * this.cadence;
    }
    this._lastTouch = now;
    if (entry) entry.lastUsed = now;
    return page;
  }

  /** Quiet long enough to be someone else's tab. */
  recycleAfter() {
    return window_({ ...RECYCLE, pinned: this.pinned.recycleMs ?? RECYCLE.pinned }, this.cadence);
  }

  /** Quiet long enough that its renderer should give the page back. */
  blankAfter() {
    return window_({ ...BLANK, pinned: this.pinned.blankMs ?? BLANK.pinned }, this.cadence);
  }

  /** Quiet long enough to be abandoned. */
  idleAfter() {
    return window_({ ...IDLE, pinned: this.pinned.idleMs ?? IDLE.pinned }, this.cadence);
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

  /** Governed context.newPage(): recycle an idle tab we own before opening one. */
  async newPage() {
    const recycled = this.#idlest();
    if (recycled) return this.#recycle(recycled);
    await this.#admit();
    this._creating += 1;
    try {
      const page = (await this.#backgroundPage()) ?? (await this.context.newPage());
      await sleep(this.settleMs); // serialise attach churn (see pool.mjs SAFETY GATE)
      return this.adopt(page, "created");
    } finally {
      this._creating -= 1;
    }
  }

  /**
   * A tab that does NOT become the operator's active tab. Only raw CDP can ask
   * for one (`Target.createTarget { background: true }`); the extension relay
   * forwards `chrome.tabs.create` with no such option, so there this returns
   * null and the caller opens an ordinary — therefore foreground — tab.
   * One browser session for the whole guard, detached in dispose(); the page
   * listener and its timer are removed on every path, including the failing one.
   */
  async #backgroundPage() {
    if (this.mode === "extension" || this._background === false) return null;
    let onPage = null;
    let timer = null;
    try {
      this._bgSession ??= await this.context.browser().newBrowserCDPSession();
      const appeared = new Promise((resolve, reject) => {
        onPage = resolve;
        this.context.on("page", onPage);
        timer = setTimeout(() => reject(new Error("the background target never surfaced as a page")), BACKGROUND_MS);
        timer.unref?.();
      });
      await this._bgSession.send("Target.createTarget", { url: "about:blank", background: true });
      return await appeared;
    } catch {
      this._background = false; // one refusal is enough; every later tab is an ordinary one
      return null;
    } finally {
      clearTimeout(timer);
      if (onPage) this.context.off?.("page", onPage);
    }
  }

  /** Hand a tab we already own back to the caller, emptied first. */
  async #recycle(page) {
    if (this._scratch === page) this._scratch = null; // it belongs to whoever asked for it now
    await serialiseNavigation(() => page.goto("about:blank", { waitUntil: "commit" })).catch(() => {});
    this.stats.recycled += 1;
    const entry = this.owned.get(page);
    if (entry) entry.blanked = true;
    return this.touch(page);
  }

  /**
   * The page bound to `name`, creating or recycling one if needed; with no name
   * this is the scratch page, which every unnamed call shares. A bound name is
   * a hold, so a named surface is never recycled and never reaped until
   * release(name) or surface eviction; the scratch page is held by nobody and
   * is the first thing spent when the ceiling bites.
   */
  async surface(name) {
    if (name === undefined || name === null) return this.#scratch();
    const key = typeof name === "string" ? name.trim() : "";
    if (!key) throw new Error("surface(name) wants a non-empty string name (or no argument at all for the scratch surface).");
    const bound = this.named.get(key);
    // Same name, same page — even if it was blanked while nobody was looking.
    if (bound && !bound.isClosed?.() && this.owned.has(bound)) return this.touch(bound);
    if (bound) this.release(key); // the tab went away under us
    const evicted = this.#surfaceToEvict();
    const page = evicted ? await this.#recycle(evicted) : await this.newPage();
    this.named.set(key, page);
    const entry = this.owned.get(page);
    if (entry) entry.name = key;
    this.hold(page);
    return this.touch(page);
  }

  /**
   * The scratch page: the same tab for every unnamed call, so a run of unnamed
   * navigations costs one tab instead of one per step (which, at the ceiling,
   * meant open-evict-open — the operator watching tabs appear and vanish).
   * Not held: it is still recycled, evicted and reaped like any unnamed tab.
   */
  async #scratch() {
    const page = this._scratch;
    const entry = page && this.owned.get(page);
    if (entry && !page.isClosed?.() && entry.name === undefined) return this.touch(page);
    this._scratch = await this.newPage();
    return this._scratch;
  }

  /**
   * Drop a binding; the tab stays open as an ordinary owned tab.
   * @returns {boolean} whether the name was bound
   */
  release(name) {
    const key = typeof name === "string" ? name.trim() : "";
    const page = key ? this.named.get(key) : undefined;
    if (!page) return false;
    this.named.delete(key);
    const entry = this.owned.get(page);
    if (entry && entry.name === key) delete entry.name;
    this.unhold(page);
    return true;
  }

  /** What is bound right now, for humans and for the agent to read back. */
  surfaces() {
    const now = Date.now();
    const out = [];
    for (const [name, page] of this.named) {
      const entry = this.owned.get(page);
      if (!entry) continue;
      out.push({ name, url: page.url?.() ?? "", idleMs: now - entry.lastUsed, blanked: isBlank(page) });
    }
    return out;
  }

  /** Forget whatever name pointed at this page (the page is gone or taken). */
  #unbind(page) {
    const entry = this.owned.get(page);
    const name = entry?.name;
    if (name !== undefined && this.named.get(name) === page) {
      this.named.delete(name);
      return name;
    }
    for (const [key, bound] of this.named) {
      if (bound === page) {
        this.named.delete(key);
        return key;
      }
    }
    return null;
  }

  /**
   * The ceiling is full and every tab we own is a bound surface: the LRU name
   * loses its binding and its tab is handed over, no close and no new renderer.
   * Counted as surfacesEvicted, because losing a named surface must be visible.
   */
  #surfaceToEvict() {
    if (this.owned.size < this.ceiling) return null;
    if (this.#idlest() || this.#lru()) return null; // an unbound tab can pay instead
    // holds > 1 means somebody else (TabPool) is working in this tab too.
    const best = this.#oldest(this.named.values(), (entry) => entry.holds <= 1);
    if (!best) return null;
    const name = this.#unbind(best);
    this.unhold(best);
    const entry = this.owned.get(best);
    if (entry && entry.name === name) delete entry.name;
    this.stats.surfacesEvicted += 1;
    return best;
  }

  /**
   * The tab we own that has been quiet longest among those `keep` accepts. Every
   * eviction choice here is this one argmin, so they cannot drift apart over
   * questions like "is a closed tab eligible?".
   */
  #oldest(pages, keep) {
    let best = null;
    let bestAt = Infinity;
    for (const page of pages) {
      const entry = this.owned.get(page);
      if (!entry || page.isClosed?.() || !keep(entry)) continue;
      if (entry.lastUsed < bestAt) {
        best = page;
        bestAt = entry.lastUsed;
      }
    }
    return best;
  }

  /** An unheld tab nobody has touched for a while: the natural one to reuse. */
  #idlest() {
    const after = this.recycleAfter();
    if (after <= 0) return null;
    const quiet = Date.now() - after;
    return this.#oldest(this.owned.keys(), (entry) => entry.holds === 0 && entry.lastUsed <= quiet);
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

  /**
   * Give the memory back before the tab is gone, then take the tab: an idle tab
   * is blanked after the blank window (which drops its renderer's page) and
   * closed after the idle window. Blanking goes through the process-wide
   * navigation lock, because concurrent navigation over the bridge crashes Chrome.
   */
  async reap() {
    const idleAfter = this.idleAfter();
    const blankAfter = this.blankAfter();
    if (idleAfter <= 0) return { reaped: 0, blanked: 0 };
    const now = Date.now();
    let reaped = 0;
    let blanked = 0;
    for (const [page, entry] of [...this.owned]) {
      if (entry.holds > 0) continue;
      const idle = now - entry.lastUsed;
      if (idle >= idleAfter) {
        if (await this.#close(page, "idle")) {
          this.stats.reaped += 1;
          reaped += 1;
        }
      } else if (blankAfter > 0 && idle >= blankAfter && !entry.blanked && !isBlank(page)) {
        entry.blanked = true;
        await serialiseNavigation(() => page.goto("about:blank", { waitUntil: "commit" })).catch(() => {});
        this.stats.blanked += 1;
        blanked += 1;
      }
    }
    return { reaped, blanked };
  }

  /** What the guard is doing, for logs and for the agent to read back. */
  report() {
    const tabs = [...this.owned.entries()].map(([page, entry]) => ({
      url: page.url?.().slice(0, 70) ?? "",
      origin: entry.origin,
      held: entry.holds > 0,
      name: entry.name ?? null,
      idleMs: Date.now() - entry.lastUsed,
    }));
    return {
      owned: this.owned.size,
      ceiling: this.ceiling,
      operatorTabs: this.protectedPages.size,
      // Measured, not configured: the caller's beat and the windows it implies.
      cadenceMs: Math.round(this.cadence),
      recycleAfterMs: this.recycleAfter(),
      blankAfterMs: this.blankAfter(),
      idleAfterMs: this.idleAfter(),
      evict: this.evict,
      ...this.stats,
      surfaces: this.surfaces(),
      scratch: this._scratch && !this._scratch.isClosed?.() ? (this._scratch.url?.() ?? "") : null,
      backgroundTabs: this.mode !== "extension" && this._background !== false,
      tabs,
    };
  }

  /** Stop reaping and let go of the context (does not close anything). */
  dispose() {
    clearInterval(this._timer);
    this._timer = null;
    this.context.off?.("page", this._onPage);
    this._bgSession?.detach().catch(() => {}); // the browser may already be gone
    this._bgSession = null;
    process.off("beforeExit", this._onBeforeExit);
    process.off("SIGINT", this._onSignal);
    process.off("SIGTERM", this._onSignal);
  }

  /**
   * Make room for one more tab: idle tabs we own are handed back first. The only
   * refusal is the transport ceiling, where one more attached tab drops the
   * connection.
   */
  async #admit() {
    while (this.owned.size >= this.ceiling) {
      const victim = this.#lru();
      if (!victim) {
        this.stats.refused += 1;
        throw new Error(
          `cannot open another tab: the ${this.mode} transport tolerates ${this.ceiling} attached tabs and all of them are in use. ` +
            "Finish or release the work holding one, close one, or raise BC_TAB_BUDGET if your transport can take it " +
            "(the extension bridge drops the connection past three — src/tab-guard.mjs).",
        );
      }
      if (await this.#close(victim, "evict")) this.stats.evicted += 1;
      else this.owned.delete(victim); // could not close it; stop counting it as ours
    }
  }

  /**
   * Re-apply the limits after a tab arrived uninvited. Unlike #admit this cannot
   * throw — nobody is waiting on a window.open — so an unevictable overflow is
   * recorded and reported instead.
   */
  async #trim() {
    while (this.owned.size > this.ceiling) {
      if (this.owned.size === 0) return;
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
    return this.#oldest(this.owned.keys(), (entry) => entry.holds === 0);
  }

  /** Serialised, settle-delayed close that refuses to empty the browser. */
  #close(page, why) {
    const run = this._closeChain.then(async () => {
      if (!this.owned.has(page)) return false;
      if (page.isClosed?.()) {
        this.owned.delete(page);
        return false;
      }
      // Same last-tab rule as pool.mjs, imported so there is only one copy of it.
      if (wouldEmptyBrowser(this.context)) return false;
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
   * The relay opens its own chrome-extension://…/connect.html tab per attach()
   * and never closes it: sixteen runs left sixteen tabs (measured 2026-10-02).
   * Deliberately ignores the keep-one-tab rule — this tab only serves the
   * connection we are abandoning.
   */
  async closeBridge() {
    const live = this.context.pages().filter((p) => !p.isClosed?.());
    const bridges = live.filter((p) => this.bridgePages.has(p) || /chrome-extension:\/\/.*\/(connect|status)\.html/.test(p.url()));
    for (const page of bridges) await page.close().catch(() => {}); // the relay may already be tearing down
    return bridges.length;
  }
}

/** A BrowserContext whose newPage() routes through the guard; all else passes through. */
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

/** A Browser whose close() hands the tabs back first. */
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
