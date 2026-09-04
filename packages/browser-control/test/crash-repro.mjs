// Minimal repro harness for the Chrome browser-process CHECK crash seen while
// building the tab pool (EXC_BREAKPOINT / SIGTRAP on CrBrowserMain, 5 crashes).
//
// Each pattern runs in its own attach() cycle and reports whether the browser
// survived. It stops at the first killer. Run deliberately — it may crash the
// browser it attaches to.
//
//   PLAYWRIGHT_MCP_EXTENSION_TOKEN=… node test/crash-repro.mjs [patternName]
import { execSync } from "node:child_process";
import { attach } from "../src/attach.mjs";

const alive = () => {
  try {
    execSync("pgrep -f 'MacOS/Google Chrome' >/dev/null 2>&1");
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Each pattern: async ({ browser, context, log }) => void */
const PATTERNS = {
  async churnSequential({ context }) {
    for (let round = 0; round < 3; round += 1) {
      const page = await context.newPage();
      await page.goto("about:blank");
      await page.close();
      await sleep(200);
    }
  },

  async churnConcurrent({ context }) {
    const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
    await Promise.all(pages.map((p) => p.goto("about:blank").catch(() => {})));
    await Promise.all(pages.map((p) => p.close().catch(() => {})));
  },

  async concurrentWork({ context }) {
    const pages = [];
    for (let i = 0; i < 3; i += 1) {
      pages.push(await context.newPage());
      await sleep(250);
    }
    await Promise.all(Array.from({ length: 6 }, (_, i) => pages[i % 3].evaluate(() => new Promise((r) => setTimeout(r, 600)))));
    for (const p of pages) {
      await p.close().catch(() => {});
      await sleep(250);
    }
  },

  // THE SUSPECT: the pool probed every page in the context for its marker,
  // including the extension's own connect.html — i.e. it drove chrome.debugger
  // against a chrome-extension:// page.
  async evaluateOnExtensionPage({ context, log }) {
    for (const page of context.pages()) {
      const url = page.url();
      try {
        const res = await page.evaluate(() => sessionStorage.getItem("bcPoolTab"));
        log(`evaluate ok on ${url.slice(0, 60)} → ${res}`);
      } catch (err) {
        log(`evaluate failed on ${url.slice(0, 60)} → ${String(err?.message ?? err).split("\n")[0]}`);
      }
      await sleep(300);
    }
  },

  async addInitScript({ context, log }) {
    const page = await context.newPage();
    await page.addInitScript({ content: 'sessionStorage.setItem("bcPoolTab", "1")' });
    await page.goto("about:blank#init");
    log(`marker after init script → ${await page.evaluate(() => sessionStorage.getItem("bcPoolTab"))}`);
    await page.close();
  },

  async zeroTabsThenUse({ context, log }) {
    const pages = [await context.newPage(), await context.newPage()];
    for (const p of pages) await p.goto("about:blank").catch(() => {});
    for (const p of context.pages()) await p.close().catch(() => {});
    await sleep(800);
    const res = await context
      .newPage()
      .then((p) => p.evaluate(() => 1))
      .catch((e) => `err:${String(e.message).split("\n")[0]}`);
    log(`post-teardown call → ${res}`);
  },
};

const only = process.argv[2];
for (const [name, fn] of Object.entries(PATTERNS)) {
  if (only && name !== only) continue;
  if (!alive()) {
    console.log(`SKIP ${name} — browser not running`);
    break;
  }
  process.stdout.write(`▶ ${name} … `);
  const notes = [];
  let verdict = "survived";
  try {
    const { browser, context } = await attach();
    await fn({ browser, context, log: (m) => notes.push(m) });
    await browser.close().catch(() => {});
  } catch (err) {
    verdict = `error: ${String(err?.message ?? err).split("\n")[0]}`;
  }
  await sleep(1500);
  const stillAlive = alive();
  console.log(`${verdict} | browser ${stillAlive ? "alive" : "DEAD"}`);
  for (const n of notes) console.log(`    ${n}`);
  if (!stillAlive) {
    console.log(`\n⚠ killer pattern: ${name}`);
    break;
  }
}
