// Parallel capability, shaped by what the transports actually tolerate.
//
// Hard-won constraints (2026-09-05, Chrome 152 + Playwright Extension):
//   * ONE pool per connection. Repeated pools accumulate attached tabs until
//     the extension bridge drops the connection.
//   * Never close tabs over the extension bridge — reuse them next run.
//   * Navigation is serialised by controlPage on that transport.
//   * The browser must own at least one ordinary tab, otherwise it exits when
//     the bridge closes.
// The pool enforces all four; these tests assert the enforcement and the actual
// parallel speed-up.
//
//   PLAYWRIGHT_MCP_EXTENSION_TOKEN=… node --test test/pool.test.mjs
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachOrSkip } from "./attached.mjs";
import { MAX_TABS_EXTENSION, TabPool } from "../src/pool.mjs";

// This suite exercises tab creation on purpose, so it opts through the gate
// itself (see src/pool.mjs SAFETY GATE) before attaching. Everything it creates
// is left open for reuse; `npm run cleanup` removes them. A machine without the
// extension installed skips the suite with that reason rather than failing it.
process.env.BC_ALLOW_TAB_CREATE = "1";
const { attached, skip } = await attachOrSkip();
const browser = attached?.browser;
const context = attached?.context;
const capabilities = attached?.capabilities ?? {};
const extension = (capabilities.mode ?? "extension") === "extension";
let pool;

before(async () => {
  if (!attached) return;
  // Anchor tab: without an ordinary tab of its own the browser exits when the
  // bridge closes. Also gives the pool something to reuse.
  const anchor = context.pages().find((p) => !p.url().startsWith("chrome-extension://")) ?? (await context.newPage());
  await anchor.goto("https://example.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
  pool = await new TabPool(context, { size: 2, capabilities }).start();
});

after(async () => {
  await pool?.close();
  await browser?.close().catch(() => {});
});

describe("TabPool guard rails", { skip }, () => {
  it("refuses impossible sizes", () => {
    assert.throws(() => new TabPool(context, { size: 0 }), /size must be >= 1/);
    assert.throws(() => new TabPool(context, { size: 99 }), /exceeds BC_MAX_TABS/);
  });

  it("refuses a second pool on the extension transport", async () => {
    if (!extension) return;
    await assert.rejects(() => new TabPool(context, { size: 1, capabilities }).start(), /only ONE pool per connection/);
  });

  it("caps the extension pool below the bridge's limit", () => {
    assert.ok(MAX_TABS_EXTENSION <= 3, `extension ceiling should stay small, is ${MAX_TABS_EXTENSION}`);
    assert.throws(() => new TabPool(context, { size: MAX_TABS_EXTENSION + 1, capabilities, mode: "extension" }), /BC_MAX_TABS_EXTENSION/);
  });

  it("serialises navigation on the extension transport", () => {
    assert.equal(pool.pages[0].navigationSerialised(), extension);
  });
});

describe("TabPool parallelism", { skip }, () => {
  it("runs page work on separate tabs concurrently", async () => {
    // Warm every tab first: the first evaluate on a freshly attached tab pays
    // for the chrome.debugger attach, which has nothing to do with parallelism
    // and was enough to push a cold run over the bound.
    await pool.map([...Array(pool.size).keys()], (_, page) => page.evaluate(() => 1));
    const started = Date.now();
    // 4 tasks × 600ms over 2 tabs: serial ≈ 2.4s, parallel ≈ 1.2s.
    const results = await pool.map([...Array(4).keys()], async (i, page) => {
      await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
      return page.evaluate((n) => {
        window.__slot = n;
        return n;
      }, i);
    });
    const ms = Date.now() - started;
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
    assert.deepEqual(results.map((r) => r.value).sort(), [0, 1, 2, 3]);
    assert.equal(new Set(results.map((r) => r.tab)).size, 2, "work spread over both tabs");
    assert.ok(ms < 2000, `expected parallel speed-up, took ${ms}ms`);
  });

  it("keeps per-tab state separate", async () => {
    const results = await pool.map(["alpha", "beta", "gamma", "delta"], async (tag, page) => {
      await page.evaluate((t) => {
        window.__tag = t;
      }, tag);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 120)));
      return page.evaluate(() => window.__tag);
    });
    assert.ok(results.every((r) => r.ok));
    // Each task must read back its own tag: proof no cross-talk between tabs.
    assert.deepEqual(
      results.map((r) => r.value),
      ["alpha", "beta", "gamma", "delta"],
    );
  });

  it("isolates a failing task and keeps the batch running", async () => {
    const results = await pool.map(["ok", "boom", "ok"], async (item, page) => {
      if (item === "boom") throw new Error("task blew up");
      return page.evaluate(() => 1 + 1);
    });
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, false, true],
    );
    assert.match(results[1].error, /task blew up/);
  });

  it("closes the tabs it opened and leaves the browser as it was", async () => {
    const ordinaryBefore = context.pages().filter((p) => !p.url().startsWith("chrome-extension://")).length;
    const res = await pool.close();
    assert.ok(res.closed >= 1, `expected the pool to close its tabs, got ${JSON.stringify(res)}`);
    const ordinaryAfter = context.pages().filter((p) => !p.isClosed() && !p.url().startsWith("chrome-extension://")).length;
    assert.equal(ordinaryAfter, ordinaryBefore - res.closed, "tab count must drop by exactly what we closed");
    assert.ok(ordinaryAfter >= 1, "never close the last ordinary tab");
  });
});
