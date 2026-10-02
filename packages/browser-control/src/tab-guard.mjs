// Keep an agent from eating the operator's RAM one tab at a time.
//
// The failure mode this exists for: an LLM agent driving this library opens a
// tab per step ("let me check that in a new tab"), never closes anything, and
// twenty minutes later Chrome is holding 40 renderer processes — in the browser
// the operator is personally using. Agents do not reliably clean up, so the
// discipline lives here instead of being asked for politely.
//
// A fixed "you get N tabs" would be both rude and wrong: the right number is
// however many tabs are doing work right now, on this machine, at this moment.
// So the policy is about pressure and recycling, not about a magic number:
//
//   * RECYCLE FIRST — a tab we own that nobody is using is not a free tab to
//     keep, it is the tab the next request gets. Reuse costs no memory; a new
//     renderer process costs ~40-80 MB of the operator's RAM.
//   * ADMIT UNDER PRESSURE — a new tab is granted while the machine can afford
//     one. When memory is tight the least-recently-used idle tab is taken back
//     first, and only an all-busy, under-pressure browser refuses — loudly,
//     with the reason.
//   * TRANSPORT CEILING — the one hard number, and it is not a style choice:
//     the extension bridge drops the connection past ~3 attached tabs
//     (MAX_TABS_EXTENSION, measured 2026-09-05). Stability, not policy.
//   * OWNERSHIP — only tabs this process opened (or popups they spawned) are
//     ours. Every tab that existed at attach() time is the operator's and is
//     never closed, never navigated, never counted.
//   * MEMORY BEFORE CLOSURE — an idle tab is parked on about:blank well before
//     it is closed, which hands the renderer's page back immediately. Both
//     windows are measured, not declared (see "cadence" below).
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
import { execFileSync } from "node:child_process";
import os from "node:os";
import { MAX_TABS, MAX_TABS_EXTENSION } from "./pool.mjs";
import { serialiseNavigation } from "./page.mjs";

/** A tab already parked on about:blank holds no page memory worth reclaiming. */
const isBlank = (page) => {
  const url = page.url?.() ?? "";
  return url === "" || url === "about:blank";
};

// Same sessionStorage marker as src/pool.mjs and cleanup.mjs: tabs we own stay
// recognisable across runs, so `npm run cleanup` can finish the job if a process
// is killed before it can tidy up.
const MARKER = "bcPoolTab";
const TAB_SETTLE_MS = Number(process.env.BC_TAB_SETTLE_MS ?? 400);

// "Is this tab still wanted?" has no correct constant. A crawler touches a tab
// every 200 ms; an agent that stops to think touches one every 30 s. Five
// seconds would steal the second one's tab and never reuse the first one's.
//
// So the windows are measured, not declared: the guard tracks the gap between
// operations on the tabs it owns (an EWMA, ignoring gaps so long they are
// obviously pauses rather than rhythm) and expresses each decision as a
// multiple of THAT. A tab is reusable once it has been quiet for several of the
// caller's own beats; blanked after a few dozen; closed after a few hundred.
// Floors and caps keep a pathological cadence from producing a silly window,
// and BC_TAB_*_MS pins any of them when the operator wants a number.
const CADENCE_SEED_MS = 1_000; // before anything is measured
const CADENCE_ALPHA = 0.3; // EWMA weight of the newest gap
const CADENCE_PAUSE_MS = 120_000; // a gap longer than this is a pause, not rhythm
const RECYCLE = { beats: 5, min: 1_000, max: 60_000, pinned: process.env.BC_TAB_RECYCLE_MS };
const BLANK = { beats: 30, min: 30_000, max: 600_000, pinned: process.env.BC_TAB_BLANK_MS };
const IDLE = { beats: 120, min: 120_000, max: 1_800_000, pinned: process.env.BC_TAB_IDLE_MS };
const REAP_EVERY_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A window expressed in the caller's own beats, unless it was pinned. */
function window_(spec, cadence) {
  if (spec.pinned !== undefined) return Number(spec.pinned);
  return Math.min(spec.max, Math.max(spec.min, Math.round(cadence * spec.beats)));
}

/** Available memory below this fraction counts as pressure. */
const MEMORY_FLOOR = Number(process.env.BC_MEM_FLOOR ?? 0.2);

/**
 * How much room the machine has left, 0 (none) to 1 (plenty).
 *
 * `os.freemem()` is the portable signal and it is useless on macOS: it counts
 * only untouched pages, so a healthy 16 GB machine reads 1% free and every tab
 * request gets refused (measured 2026-10-02, against 24% actually available).
 * On darwin the answer comes from `vm_stat` — free + inactive + speculative +
 * purgeable, i.e. the pages the kernel can still hand out — cached for a few
 * seconds because this sits on the admission path.
 */
export function headroom() {
  const total = os.totalmem();
  if (total <= 0) return 1;
  if (os.platform() !== "darwin") return os.freemem() / total;
  const now = Date.now();
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  memo = { at: now, value: darwinAvailable() / total };
  return memo.value;
}

let memo = null;
const MEMO_MS = 5_000;

/** Pages the macOS kernel can still hand out, in bytes. */
function darwinAvailable() {
  try {
    const out = execFileSync("vm_stat", { encoding: "utf8" });
    const pageSize = Number(/page size of (\d+)/.exec(out)?.[1] ?? 4096);
    const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
    return (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * pageSize;
  } catch {
    return os.freemem(); // vm_stat missing or unreadable: fall back to the portable answer
  }
}

/**
 * The hard ceiling, which exists for transport stability only — the extension
 * bridge drops the connection past MAX_TABS_EXTENSION attached tabs. Everything
 * else is decided by pressure. BC_TAB_BUDGET pins it explicitly when the
 * operator wants a number.
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
 *          evict?: boolean, settleMs?: number, headroom?: () => number }} options
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
      headroom: headroomOf = headroom,
    } = {},
  ) {
    this.context = context;
    this.mode = mode;
    /** Transport stability limit, not a policy number (see the header). */
    this.ceiling = ceiling ?? tabCeiling(mode);
    this.headroom = headroomOf;
    /** Explicit overrides win; otherwise every window is measured (see the header). */
    this.pinned = { idleMs, blankMs, recycleMs };
    /** The caller's rhythm: an EWMA of the gap between operations we observe. */
    this.cadence = CADENCE_SEED_MS;
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
    this.stats = { created: 0, recycled: 0, spawned: 0, evicted: 0, reaped: 0, blanked: 0, refused: 0, grantedUnderPressure: 0, closed: 0, overflow: 0 };
    this._closeChain = Promise.resolve();
    this._timer = null;
    this._creating = 0; // tabs opened through newPage() arrive as "page" events too
    this._onPage = (page) => this.adopt(page, this._creating > 0 ? "created" : "spawned");
    this.context.on("page", this._onPage);
    if (this.idleAfter() > 0) {
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

  /**
   * Record activity, and learn from it. The gap since the previous operation is
   * this caller's beat; every idle decision is expressed in those beats, so a
   * fast crawler and a slow, thinking agent each get a window that fits them.
   */
  touch(page) {
    const now = Date.now();
    const entry = this.owned.get(page);
    if (this._lastTouch) {
      const gap = now - this._lastTouch;
      // A long silence is a pause, not a rhythm: learning from it would make the
      // guard hoard tabs for the rest of the session.
      if (gap >= 0 && gap < CADENCE_PAUSE_MS) this.cadence = CADENCE_ALPHA * gap + (1 - CADENCE_ALPHA) * this.cadence;
    }
    this._lastTouch = now;
    if (entry) entry.lastUsed = now;
    return page;
  }

  /**
   * The beat every idle decision is measured in. Under memory pressure it runs
   * four times faster: that is how pressure is answered — by reclaiming sooner,
   * not by refusing work that would have freed nothing.
   */
  #beat() {
    return this.headroom() < MEMORY_FLOOR ? this.cadence / 4 : this.cadence;
  }

  /** Quiet long enough to be someone else's tab. */
  recycleAfter() {
    return window_({ ...RECYCLE, pinned: this.pinned.recycleMs ?? RECYCLE.pinned }, this.#beat());
  }

  /** Quiet long enough that its renderer should give the page back. */
  blankAfter() {
    return window_({ ...BLANK, pinned: this.pinned.blankMs ?? BLANK.pinned }, this.#beat());
  }

  /** Quiet long enough to be abandoned. */
  idleAfter() {
    return window_({ ...IDLE, pinned: this.pinned.idleMs ?? IDLE.pinned }, this.#beat());
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
   * The governed replacement for context.newPage().
   *
   * Recycling comes first: handing back a tab we already own costs nothing,
   * while a new one costs the operator a renderer process. Only when every tab
   * we own is busy does this consider growing, and only while the machine has
   * room for it.
   */
  async newPage() {
    const recycled = this.#idlest();
    if (recycled) {
      await serialiseNavigation(() => recycled.goto("about:blank", { waitUntil: "commit" })).catch(() => {});
      this.stats.recycled += 1;
      const entry = this.owned.get(recycled);
      if (entry) entry.blanked = true;
      return this.touch(recycled);
    }
    await this.#admit();
    this._creating += 1;
    try {
      const page = await this.context.newPage();
      await sleep(this.settleMs); // serialise attach churn (see pool.mjs SAFETY GATE)
      return this.adopt(page, "created");
    } finally {
      this._creating -= 1;
    }
  }

  /** An unheld tab nobody has touched for a while: the natural one to reuse. */
  #idlest() {
    const after = this.recycleAfter();
    if (after <= 0) return null;
    const quiet = Date.now() - after;
    let best = null;
    let bestAt = Infinity;
    for (const [page, entry] of this.owned) {
      if (entry.holds > 0 || page.isClosed?.() || entry.lastUsed > quiet) continue;
      if (entry.lastUsed < bestAt) {
        best = page;
        bestAt = entry.lastUsed;
      }
    }
    return best;
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
   * Give the memory back before the tab is gone, then take the tab.
   *
   * A Chrome tab parked on a real application holds a renderer process with the
   * whole DOM, JS heap and caches in it; closing is not the only lever and not
   * the first one. An idle tab we own is blanked once it has been quiet for the
   * blank window, which drops that renderer's page, and closed once it has been
   * quiet for the idle window. Both are the caller's measured cadence in beats
   * (see the header). Blanking goes through the process-wide navigation lock,
   * because concurrent navigation over the extension bridge crashes Chrome.
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
      idleMs: Date.now() - entry.lastUsed,
    }));
    return {
      owned: this.owned.size,
      ceiling: this.ceiling,
      headroom: Number(this.headroom().toFixed(2)),
      operatorTabs: this.protectedPages.size,
      // Measured, not configured: the caller's beat and the windows it implies.
      cadenceMs: Math.round(this.cadence),
      recycleAfterMs: this.recycleAfter(),
      blankAfterMs: this.blankAfter(),
      idleAfterMs: this.idleAfter(),
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

  /**
   * Decide whether the browser can afford one more tab right now.
   *
   * Refusing work does not free a single byte — only reclaiming does. So memory
   * pressure makes this hand back idle tabs before it grants a new one, and if
   * there is nothing idle to hand back it grants anyway and lets the reaper
   * squeeze harder (the windows shrink under pressure, see #beat). The one
   * genuine refusal is the transport's ceiling, where another tab would drop
   * the connection: that is not a policy, it is physics.
   */
  async #admit() {
    for (;;) {
      const tight = this.headroom() < MEMORY_FLOOR && this.owned.size > 0;
      const overCeiling = this.owned.size >= this.ceiling;
      if (!overCeiling && !tight) return;
      const victim = this.#lru();
      if (!victim) {
        if (!overCeiling) {
          // Under pressure with every tab in use: the work is real, the tabs are
          // real, and saying no would only break the caller.
          this.stats.grantedUnderPressure += 1;
          return;
        }
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
    while (this.owned.size > this.ceiling || this.headroom() < MEMORY_FLOOR) {
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
