// Keep the operator's screen. attach() on the extension transport makes
// playwright-core spawn Chrome with the relay's connect.html URL (coreBundle
// _openConnectPageInBrowser), and Chrome raises itself over whatever the
// operator was doing — so note who was in front and take the screen back the
// moment the browser grabs it. BC_RESTORE_FOCUS=0 opts out.
//
// 2026-10-06: measured, all three deliveries raise an ALREADY-RUNNING Chrome —
// spawning the binary, `open -g -a Chrome <url>`, and AppleScript `make new
// tab`. Chrome activates itself on an external URL, so this is damage control,
// not prevention: fewer attaches is the only real cure.
// Only ever taken back from the browser (isBrowser) — never from an operator
// who switched apps themselves. macOS only: lsappinfo/open need no
// accessibility grant, Windows has nothing short of SetForegroundWindow.
import { execFile } from "node:child_process";

const PROBE_MS = 2_000;
const SETTLE_MS = 150; // activation is asynchronous; this is how long we give it
const POLL_MS = 100;
const WATCH_MS = Number(process.env.BC_FOCUS_WATCH_MS ?? 10_000);
// Every Chrome/Chromium channel: com.google.Chrome{,.beta,.canary,.dev}, org.chromium.Chromium.
const BROWSER = /^(com\.google\.chrome|org\.chromium)/i;
// Ref'd on purpose: the poll is 100 ms and always stopped, while an unref'd one
// could let the process exit mid-restore and leave the screen with the browser.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a helper, resolving to stdout or null: window focus is never worth throwing over. */
function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: PROBE_MS, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Bundle id of the frontmost application, or null when the platform cannot say. */
export async function frontmostApp() {
  if (process.platform !== "darwin") return null;
  const asn = (await run("/usr/bin/lsappinfo", ["front"]))?.trim();
  if (!asn?.startsWith("ASN:")) return null;
  const info = await run("/usr/bin/lsappinfo", ["info", "-only", "bundleid", asn]);
  return /bundleID="([^"]+)"/.exec(info ?? "")?.[1] ?? null;
}

/** Is this the browser we just launched — the only app we may take the screen back from? */
export const isBrowser = (app) => typeof app === "string" && BROWSER.test(app);

/**
 * Put the bundle id `app` back in front if the browser took the screen meanwhile.
 * @returns {Promise<{ restored: boolean, app?: string, took?: string|null, skipped?: true, reason?: string }>}
 */
export async function restoreFrontmost(app) {
  if (!app) {
    const reason = process.platform === "darwin" ? "frontmost-app-unknown" : `focus-restore-is-macos-only (${process.platform})`;
    return { restored: false, skipped: true, reason };
  }
  const took = await frontmostApp();
  if (took === app) return { restored: false, skipped: true, reason: "nothing-took-the-focus" };
  // The operator moving to another application is not something to undo.
  if (!isBrowser(took)) return { restored: false, skipped: true, reason: `not-the-browser (${took ?? "unknown"})` };
  // Twice: Chrome finishes raising its window after we ask, and wins the first round.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ((await run("/usr/bin/open", ["-b", app])) === null) return { restored: false, app, took, reason: `open -b ${app} failed` };
    await sleep(SETTLE_MS);
    if ((await frontmostApp()) === app) return { restored: true, app, took };
  }
  return { restored: false, app, took, reason: "the browser kept the focus" };
}

/**
 * Take the screen back as soon as the browser grabs it, instead of after the
 * whole connect: the raise lands early and waiting for `attach()` to finish
 * measured 700 ms of the operator's attention. Always `stop()` it.
 * @returns {{ stop: () => Promise<object> }}
 */
export function watchFocus(app) {
  if (!app || process.platform !== "darwin") return { stop: () => restoreFrontmost(app) };
  let stopped = false;
  let bounces = 0;
  let thief = null;
  const deadline = Date.now() + WATCH_MS;
  const loop = (async () => {
    while (!stopped && Date.now() < deadline) {
      const took = await frontmostApp();
      if (took !== app && isBrowser(took)) {
        thief = took;
        bounces += 1;
        await run("/usr/bin/open", ["-b", app]);
      }
      await sleep(POLL_MS);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      const final = await restoreFrontmost(app);
      // "nothing took it" after we already bounced it back is a success, not a no-op.
      if (bounces && final.skipped && final.reason === "nothing-took-the-focus") return { restored: true, app, took: thief, bounces };
      return { ...final, bounces };
    },
  };
}
