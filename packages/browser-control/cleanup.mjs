// Close the tabs this tool created and clear the permissions it granted.
// Non-goal: it NEVER touches a tab that is not ours — anything with real content
// stays, and never the last tab in the browser (that would exit Chrome).
// Pool tabs pile up by design: the extension transport never closes them (tab churn
// over chrome.debugger destabilised Chrome 152), so they are closed here one at a
// time with a settle delay. sessionStorage lives in the Chrome process, so tabs
// marked by an older build are reclaimed only when their URL matches SCRATCH below.
//
//   node cleanup.mjs            close our tabs + clear granted permissions
//   node cleanup.mjs --dry-run  report only
import { attach } from "./src/attach.mjs";
import { MARKER, wouldEmptyBrowser } from "./src/pool.mjs";

const dryRun = process.argv.includes("--dry-run");
const SCRATCH = [/^about:blank/, /^https?:\/\/example\.(com|org)\//, /^chrome:\/\/new-tab-page/];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { browser, context, mode } = await attach();
const report = { mode, dryRun, closed: [], kept: [], permissions: null };

const pages = context.pages();
for (const page of pages) {
  const url = page.url();
  if (url.startsWith("chrome-extension://")) {
    report.kept.push(`${url.slice(0, 48)}… (extension bridge)`);
    continue;
  }
  let marked = false;
  try {
    marked = await page.evaluate((m) => sessionStorage.getItem(m) === "1", MARKER);
  } catch {} // an unreadable tab (extension/devtools page, closed mid-sweep) is simply not ours
  const scratch = SCRATCH.some((re) => re.test(url));
  if (!marked && !scratch) {
    report.kept.push(url.slice(0, 70));
    continue;
  }
  // src/pool.mjs owns the rule and explains which tabs count.
  if (wouldEmptyBrowser(context)) {
    report.kept.push(`${url.slice(0, 60)} (last tab in the browser)`);
    continue;
  }
  if (dryRun) {
    report.closed.push(`${url.slice(0, 60)} (would close, ${marked ? "pool marker" : "scratch"})`);
    continue;
  }
  await page.close().catch(() => {});
  await sleep(400);
  report.closed.push(`${url.slice(0, 60)} (${marked ? "pool marker" : "scratch"})`);
}

if (!dryRun) {
  report.permissions = await context
    .clearPermissions()
    .then(() => "cleared")
    .catch((err) => `not supported: ${String(err?.message ?? err).split("\n")[0]}`);
}

await browser.close().catch(() => {});
console.log(JSON.stringify(report, null, 2));
console.log(
  "\nNote: each attach() makes the Playwright Extension create a tab group; when its tabs go away Chrome saves the group to the bookmarks bar. Remove those chips manually (right-click → delete group).",
);
