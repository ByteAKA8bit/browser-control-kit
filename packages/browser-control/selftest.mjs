// Self-test: drives the operator's real browser with no launch flags, no profile
// mount and no approval click. It NEVER touches a tab that is not ours.
//
//   PLAYWRIGHT_MCP_EXTENSION_TOKEN=… node selftest.mjs
//   BC_MODE=cdp node selftest.mjs        (needs the shim + a debugging port)
import { attach, controlPage, blockUrls } from "./index.mjs";
import { MARKER } from "./src/pool.mjs";

const started = Date.now();
const { browser, context, mode, capabilities } = await attach();
const report = { mode, capabilities, steps: [] };
const step = (name, ok, detail) => report.steps.push({ name, ok, detail });

// Reuse a tab only when it is demonstrably ours (pool marker or empty scratch page):
// in cdp mode every other tab is the operator's and the navigation below would
// destroy its content. Extension/devtools pages cannot be evaluated at all.
const SCRATCH = [/^about:blank/, /^chrome:\/\/new-tab-page/];
const usableTab = async () => {
  for (const p of context.pages()) {
    try {
      const marked = await p.evaluate((m) => sessionStorage.getItem(m) === "1", MARKER);
      if (marked || SCRATCH.some((re) => re.test(p.url()))) return p;
    } catch {
      // extension/devtools page — never touch it
    }
  }
  return context.newPage();
};

const page = controlPage(await usableTab(), capabilities);
try {
  step("attach", true, `${mode} · inputMode=${page.inputMode()}`);

  await blockUrls(page, /translate(-pa)?\.google(apis)?\.com/);
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
  step("navigate", page.url().includes("example.com"), page.url());

  const visibility = await page.evaluate(() => ({ state: document.visibilityState, focus: document.hasFocus() }));
  step("tab-state", true, JSON.stringify(visibility));

  // Multi-argument evaluate (puppeteer semantics that plain Playwright rejects).
  const sum = await page.evaluate((a, b, c) => a + b + c, 1, 2, 3);
  step("multi-arg-evaluate", sum === 6, `sum=${sum}`);

  // Input on a page that may well be in the background.
  await page.evaluate(() => {
    document.body.innerHTML =
      '<form id="f"><input id="t" /><button id="b" type="button">go</button></form><div id="out"></div>';
    document.getElementById("b").addEventListener("click", () => {
      document.getElementById("out").textContent = `clicked:${document.getElementById("t").value}`;
    });
  });
  await page.fill("#t", "hello-real-browser");
  await page.click("#b");
  const out = await page.evaluate(() => document.getElementById("out").textContent);
  step("fill+click", out === "clicked:hello-real-browser", out);

  const shot = await page.screenshot({ path: "selftest.png" });
  step("screenshot", !!shot, String(shot));
} catch (err) {
  // Contract is "exit 1 on failure", not "die silently": a throw still reports.
  step("unexpected-error", false, err?.stack ?? String(err));
} finally {
  await browser.close().catch(() => {});
  report.ms = Date.now() - started;
  report.ok = report.steps.every((s) => s.ok);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
