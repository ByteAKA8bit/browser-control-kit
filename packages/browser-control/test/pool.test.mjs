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
// itself (see src/pool.mjs SAFETY GATE) before attaching. It must leave the
// browser exactly as it found it — the suite used to open an "anchor" tab and
// leak it on every run, which is how the operator ended up with a pile of
// about:blank tabs. A machine without the extension skips with that reason.
process.env.BC_ALLOW_TAB_CREATE = "1";
const { attached, skip } = await attachOrSkip();
const browser = attached?.browser;
const context = attached?.context;
const capabilities = attached?.capabilities ?? {};
const extension = (capabilities.mode ?? "extension") === "extension";
let pool;
let baseline = 0;

before(async () => {
  if (!attached) return;
  baseline = context.pages().filter((p) => !p.isClosed()).length;
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
    // Measure the invariant, not a stopwatch. Wall-clock speed-up is a bad
    // instrument here: every pool tab is a BACKGROUND tab, and Chrome throttles
    // background timers, so an in-page sleep(1000) measured 1570ms and the
    // "serial vs parallel" bound drifted with the browser's mood (2026-10-02).
    // Concurrency itself is crisp: two tasks on two tabs must OVERLAP in time.
    const spans = [];
    const results = await pool.map([...Array(4).keys()], async (i, page) => {
      const start = Date.now();
      await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), 500);
      const value = await page.evaluate((n) => {
        window.__slot = n;
        return n;
      }, i);
      spans.push({ tab: pool.pages.indexOf(page), start, end: Date.now() });
      return value;
    });

    assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
    assert.deepEqual(results.map((r) => r.value).sort(), [0, 1, 2, 3]);
    assert.equal(new Set(results.map((r) => r.tab)).size, 2, "work spread over both tabs");
    const overlapping = spans.some((a) =>
      spans.some((b) => a !== b && a.tab !== b.tab && a.start < b.end && b.start < a.end),
    );
    assert.ok(overlapping, `work on different tabs never overlapped: ${JSON.stringify(spans)}`);
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

  it("closes the tabs it opened and leaves the browser exactly as it was", async () => {
    const before = context.pages().filter((p) => !p.isClosed()).length;
    const res = await pool.close();
    assert.ok(res.closed >= 1, `expected the pool to close its tabs, got ${JSON.stringify(res)}`);
    const after = context.pages().filter((p) => !p.isClosed()).length;
    assert.equal(after, before - res.closed, "tab count must drop by exactly what we closed");
    assert.equal(after, baseline, `the suite must leave no tab behind: started at ${baseline}, ended at ${after}`);
    assert.ok(after >= 1, "never leave the browser with no tabs");
  });
});
