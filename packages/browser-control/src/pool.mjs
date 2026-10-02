// Parallelism: drive several tabs of the operator's real browser at once
// (crawls, per-account matrices, screenshot sweeps are embarrassingly parallel).
//
// Non-goals: two tasks on one tab (Playwright serialises per-page, so sharing
// would queue silently), and unbounded growth — every tab is real memory in a
// browser the operator is also using, so the tab count is capped.
// Invariant: a failing task marks its own result and releases its tab, never
// killing the batch unless `stopOnError`.
import { controlPage } from "./page.mjs";

// Ownership marker, shared verbatim with src/tab-guard.mjs and cleanup.mjs: a
// second spelling of it would strand every tab written with the other one.
export const MARKER = "bcPoolTab";
export const MAX_TABS = Number(process.env.BC_MAX_TABS ?? 4);
// The extension bridge tolerates far fewer attached tabs than raw CDP: past ~3
// the relay tears the connection down, and a browser left with no tabs exits.
export const MAX_TABS_EXTENSION = Number(process.env.BC_MAX_TABS_EXTENSION ?? 3);
let poolsStartedOnExtension = 0;

// ── SAFETY GATE ────────────────────────────────────────────────────────────
// 2026-09-05: creating and closing tabs in quick succession over the EXTENSION
// transport crashed the operator's Chrome four times in a row (EXC_BREAKPOINT /
// SIGTRAP = internal CHECK; crash reports at 00:18:33/40/48/57; chrome.debugger
// attach/detach churn appears to race) → tab CREATION over the extension needs
// BC_ALLOW_TAB_CREATE=1, creation and closing are serialised with a settle
// delay, and the pool never closes the last remaining tab (the extension tears
// the connection down when every attached tab disappears). Reuse is unaffected.
const CREATE_GUARD_HINT =
  "creating tabs over the extension transport is gated after it crashed Chrome " +
  "(see src/pool.mjs SAFETY GATE). Reuse existing tabs, use BC_MODE=cdp, " +
  "or set BC_ALLOW_TAB_CREATE=1 if you accept the risk.";
export const TAB_SETTLE_MS = Number(process.env.BC_TAB_SETTLE_MS ?? 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * "Never leave the browser with no tabs" — one copy of the third crash
 * invariant, shared with src/tab-guard.mjs and cleanup.mjs. Counts EVERY tab
 * including the extension's connect.html: it is a real tab holding Chrome open,
 * and on that transport context.pages() shows only our own tabs plus the bridge
 * (measured 2026-10-02), so excluding it leaked one tab per run.
 */
export function wouldEmptyBrowser(context) {
  const alive = context.pages().filter((p) => !p.isClosed?.());
  return alive.length <= 1;
}

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
      // Chrome quits once it loses every tab, and context.pages() cannot see the
      // operator's tabs here (measured 2026-10-02), so the extension's own
      // connect.html counts; demanding an "ordinary" tab only got one leaked per run.
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
      // (reproduced twice, scripts/crash-repro.mjs addInitScript with
      // BC_CRASH_REPRO=1; EXC_BREAKPOINT on CrBrowserMain). Mark after navigation.
      await raw.evaluate((m) => sessionStorage.setItem(m, "1"), MARKER).catch(() => {});
      if (this.mode !== "extension") {
        await raw.addInitScript({ content: `sessionStorage.setItem(${JSON.stringify(MARKER)}, "1")` }).catch(() => {});
      }
      this.rawPages.push(raw);
      // Pin the tab for the pool's lifetime: no LRU eviction, no idle reaping.
      this.context.tabGuard?.hold(raw);
      const page = controlPage(raw, this.capabilities);
      if (this.prepare) await this.prepare(page, i);
      this.pages.push(page);
      this._idle.push(page);
    }
    return this;
  }

  /** Pool-marked tabs first, then any usable http(s) tab: reuse is safe, creation is not. */
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
    // Default to pool-marked tabs only: hijacking the operator's own is worse.
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

  /** Run `worker(item, page, index)`, `size` at a time; always resolves to `{ ok, value | error, ms, tab }`. */
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
   * Close what we opened; tabs left behind fill the operator's browser and the
   * next run inherits them. Two rules, both learned by killing Chrome 152: close
   * SERIALLY with a settle delay (simultaneous detaches raced), and never close
   * the last ordinary tab (the browser then exits, taking the bridge with it).
   */
  async close({ closeReused = false } = {}) {
    const candidates = closeReused ? [...new Set([...this.createdPages, ...this.rawPages])] : [...this.createdPages];
    let closed = 0;
    for (const page of candidates) {
      if (page.isClosed?.()) continue;
      if (wouldEmptyBrowser(this.context)) break;
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
