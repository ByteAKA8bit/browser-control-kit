// Parallelism: drive several tabs of the operator's real browser at once.
//
// Why it belongs in the tool and not in a test suite: a suite may have to run
// serially (shared fixtures, one approval queue), but the *capability* must
// exist — crawling, per-account matrices, warm-up of N sessions, screenshot
// sweeps are all embarrassingly parallel.
//
// Design notes / constraints that shaped this:
//   * One CDP/extension connection multiplexes fine, but each tab is a separate
//     target. So a pool owns N tabs and hands them out; it never runs two tasks
//     on the same tab (Playwright serialises per-page anyway, so sharing a tab
//     would just queue silently).
//   * Tabs are marked in sessionStorage (`bcPoolTab`) and reused across runs, so
//     repeated runs do not accumulate tabs in the operator's browser.
//   * Failures are isolated: a task that throws marks its own result, releases
//     its tab and never kills the batch (unless `stopOnError`).
//   * Tab count is capped, because every tab is real memory in a browser the
//     operator is also using.
import { controlPage } from "./page.mjs";

const MARKER = "bcPoolTab";
export const MAX_TABS = Number(process.env.BC_MAX_TABS ?? 4);
// The extension bridge tolerates far fewer attached tabs than raw CDP: past ~3
// the relay tears the connection down, and if the browser then has no tabs left
// of its own it simply exits. Keep the extension ceiling low and separate.
export const MAX_TABS_EXTENSION = Number(process.env.BC_MAX_TABS_EXTENSION ?? 3);
let poolsStartedOnExtension = 0;

// ── SAFETY GATE ────────────────────────────────────────────────────────────
// 2026-09-05: creating and closing tabs in quick succession over the EXTENSION
// transport crashed the operator's Chrome browser process four times in a row
// (EXC_BREAKPOINT / SIGTRAP = internal CHECK; crash reports at 00:18:33/40/48/57).
// The extension drives chrome.debugger per tab, and attach/detach churn appears
// to race. Until that is understood and reproduced somewhere disposable:
//   * tab CREATION over the extension transport requires BC_ALLOW_TAB_CREATE=1
//   * creation and closing are serialised with a settle delay
//   * the pool never closes the last remaining tab (the extension tears the
//     whole connection down when every attached tab disappears)
// Reusing tabs the operator already has open is unaffected and stays default.
const CREATE_GUARD_HINT =
  "creating tabs over the extension transport is gated after it crashed Chrome " +
  "(see src/pool.mjs SAFETY GATE). Reuse existing tabs, use BC_MODE=cdp, " +
  "or set BC_ALLOW_TAB_CREATE=1 if you accept the risk.";
const TAB_SETTLE_MS = Number(process.env.BC_TAB_SETTLE_MS ?? 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fixed set of tabs plus a concurrency-limited map over them. */
export class TabPool {
  /**
   * @param {import("playwright-core").BrowserContext} context
   * @param {{ size?: number, capabilities?: object, prepare?: (page: any, index: number) => Promise<void>, reuse?: boolean }} options
   */
  constructor(context, { size = 3, capabilities = {}, prepare, reuse = true, mode } = {}) {
    if (size < 1) throw new Error("TabPool size must be >= 1");
    if (size > MAX_TABS) throw new Error(`TabPool size ${size} exceeds BC_MAX_TABS=${MAX_TABS} (tabs are real memory in the operator's browser)`);
    this.context = context;
    this.size = size;
    this.capabilities = capabilities;
    this.mode = mode ?? capabilities.mode ?? process.env.BC_MODE ?? "extension";
    if (this.mode === "extension" && size > MAX_TABS_EXTENSION) {
      throw new Error(
        `TabPool size ${size} exceeds BC_MAX_TABS_EXTENSION=${MAX_TABS_EXTENSION}: the extension bridge drops the connection with more attached tabs`,
      );
    }
    this.prepare = prepare;
    this.reuse = reuse;
    this.pages = [];
    this.rawPages = [];
    this.createdPages = [];
    this._idle = [];
    this._waiters = [];
  }

  async start() {
    if (this.mode === "extension") {
      poolsStartedOnExtension += 1;
      if (poolsStartedOnExtension > 1) {
        throw new Error("TabPool: only ONE pool per connection is supported on the extension transport (repeated pools accumulate attached tabs until the bridge drops). Reuse the pool, or use BC_MODE=cdp.");
      }
      // Losing every tab makes Chrome quit, so insist that the browser holds a
      // tab that is not one of ours. The extension's connect.html counts: it is
      // a real tab, and on this transport it is usually the only one we can see
      // — context.pages() does not enumerate the operator's tabs (measured
      // 2026-10-02). Demanding a visible "ordinary" tab here only taught callers
      // to create one, and that tab was then leaked on every run.
      const visible = this.context.pages().filter((p) => !p.isClosed?.());
      if (visible.length === 0) {
        throw new Error("TabPool: the browser has no tabs at all. Open a page first — if the pool's tabs are the only ones, Chrome exits when the bridge closes.");
      }
    }
    const claimed = this.reuse ? await this.#claimReusableTabs() : [];
    const mayCreate = this.mode !== "extension" || process.env.BC_ALLOW_TAB_CREATE === "1";
    for (let i = 0; i < this.size; i += 1) {
      let raw = claimed[i];
      if (!raw) {
        if (!mayCreate) {
          if (this.pages.length === 0) throw new Error(`TabPool: no reusable tab found and ${CREATE_GUARD_HINT}`);
          this.size = this.pages.length; // degrade to what we safely have
          break;
        }
        raw = await this.context.newPage();
        this.createdPages.push(raw);
        await sleep(TAB_SETTLE_MS); // serialise attach churn
      }
      // NEVER addInitScript over the extension transport: Page.addScriptTo-
      // EvaluateOnNewDocument through chrome.debugger kills the browser process
      // (reproduced twice with test/crash-repro.mjs addInitScript; Chrome writes
      // an EXC_BREAKPOINT report on CrBrowserMain). Mark after navigation instead.
      await raw.evaluate((m) => sessionStorage.setItem(m, "1"), MARKER).catch(() => {});
      if (this.mode !== "extension") {
        await raw.addInitScript({ content: `sessionStorage.setItem(${JSON.stringify(MARKER)}, "1")` }).catch(() => {});
      }
      this.rawPages.push(raw);
      // A pool tab is in use for the pool's lifetime: pin it so the tab guard's
      // LRU eviction and idle reaper never close it mid-run (src/tab-guard.mjs).
      this.context.tabGuard?.hold(raw);
      const page = controlPage(raw, this.capabilities);
      if (this.prepare) await this.prepare(page, i);
      this.pages.push(page);
      this._idle.push(page);
    }
    return this;
  }

  /**
   * Prefer tabs previously marked by a pool; otherwise fall back to any usable
   * http(s) tab already open — reuse is the safe path, creation is not.
   */
  async #claimReusableTabs() {
    const marked = [];
    const others = [];
    for (const p of this.context.pages()) {
      try {
        const isMarked = await p.evaluate((m) => sessionStorage.getItem(m) === "1", MARKER);
        (isMarked ? marked : others).push(p);
      } catch {
        // extension/devtools pages cannot be evaluated — never touch them
      }
    }
    // Only pool-marked tabs by default: silently hijacking the operator's own
    // tabs (navigating them away) is worse than refusing to run.
    const pool = process.env.BC_REUSE_ANY === "1" ? [...marked, ...others] : marked;
    return pool.slice(0, this.size);
  }

  /** Borrow a tab (waits when all are busy). */
  async acquire() {
    if (this._idle.length) return this._idle.shift();
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  release(page) {
    const waiter = this._waiters.shift();
    if (waiter) waiter(page);
    else this._idle.push(page);
  }

  /**
   * Run `worker(item, page, index)` over `items`, at most `size` at a time.
   * Always resolves: every slot is `{ ok, value | error, ms, tab }`.
   */
  async map(items, worker, { stopOnError = false } = {}) {
    const list = [...items];
    const results = new Array(list.length);
    let cursor = 0;
    let aborted = false;

    const runner = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= list.length || aborted) return;
        const page = await this.acquire();
        const tab = this.pages.indexOf(page);
        const started = Date.now();
        try {
          const value = await worker(list[index], page, index);
          results[index] = { ok: true, value, ms: Date.now() - started, tab };
        } catch (err) {
          results[index] = { ok: false, error: String(err?.message ?? err), ms: Date.now() - started, tab };
          if (stopOnError) aborted = true;
        } finally {
          this.release(page);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.size, list.length) }, runner));
    return results;
  }

  /**
   * Close what we opened. Tabs are a resource: leaving them behind fills up the
   * operator's browser and the next run inherits junk, so closing is the
   * default on every transport.
   *
   * Two rules, both learned by killing Chrome 152:
   *   * close SERIALLY with a settle delay — simultaneous detaches raced
   *   * never close the last ordinary tab — with no tabs left the browser exits
   *     and takes the extension bridge with it
   */
  async close({ closeReused = false } = {}) {
    const candidates = closeReused ? [...new Set([...this.createdPages, ...this.rawPages])] : [...this.createdPages];
    let closed = 0;
    for (const page of candidates) {
      if (page.isClosed?.()) continue;
      // "Never leave the browser with no tabs" — but count EVERY tab we can see,
      // including the extension's own connect.html, which is a real tab holding
      // Chrome open. Counting only non-extension tabs leaked one tab per run on
      // the extension transport, where context.pages() shows nothing but our own
      // tabs plus the bridge (measured 2026-10-02: the operator's tabs are not
      // enumerable there, so "the last ordinary tab" was always one of ours).
      const alive = this.context.pages().filter((p) => !p.isClosed?.());
      if (alive.length <= 1) break;
      await page.close().catch(() => {});
      await sleep(TAB_SETTLE_MS);
      closed += 1;
    }
    for (const page of this.rawPages) this.context.tabGuard?.unhold(page);
    this.pages = [];
    this.rawPages = [];
    this.createdPages = [];
    this._idle = [];
    if (this.mode === "extension") poolsStartedOnExtension = Math.max(0, poolsStartedOnExtension - 1);
    return { closed, kept: candidates.length - closed };
  }
}

/** Convenience: pool up, map, tear down. */
export async function parallelMap(context, items, worker, options = {}) {
  const pool = await new TabPool(context, options).start();
  try {
    return await pool.map(items, worker, options);
  } finally {
    await pool.close();
  }
}
