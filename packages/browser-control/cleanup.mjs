// Leave the operator's browser as we found it.
//
// What this tool can leave behind, and what this script does about it:
//   * pool tabs — the extension transport never closes them (tab churn over
//     chrome.debugger destabilised Chrome 152), so they pile up across runs.
//     Here they are closed deliberately, one at a time with a settle delay, and
//     never the last ordinary tab.
//   * scratch tabs — about:blank / example.com pages created by tests.
//   * site settings — permissions granted for capability probing.
// It NEVER touches a tab that is not ours (anything with real content stays).
//
//   node cleanup.mjs            close our tabs + clear granted permissions
//   node cleanup.mjs --dry-run  report only
import { attach } from "./src/attach.mjs";

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
    marked = await page.evaluate(() => sessionStorage.getItem("bcPoolTab") === "1" || sessionStorage.getItem("tfTestTab") === "1");
  } catch {}
  const scratch = SCRATCH.some((re) => re.test(url));
  if (!marked && !scratch) {
    report.kept.push(url.slice(0, 70));
    continue;
  }
  // Keep at least one ordinary tab: with none left the browser exits.
  const ordinaryLeft = context.pages().filter((p) => !p.url().startsWith("chrome-extension://")).length;
  if (ordinaryLeft <= 1) {
    report.kept.push(`${url.slice(0, 60)} (last ordinary tab)`);
    continue;
  }
  if (dryRun) {
    report.closed.push(`${url.slice(0, 60)} (would close, ${marked ? "pool/test marker" : "scratch"})`);
    continue;
  }
  await page.close().catch(() => {});
  await sleep(400);
  report.closed.push(`${url.slice(0, 60)} (${marked ? "pool/test marker" : "scratch"})`);
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
