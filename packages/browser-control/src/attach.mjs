// Attach to the browser the operator is ACTUALLY using.
//
// Non-goal: launching a throwaway dev profile. A fresh profile has no session,
// no extensions, no real-world state — it proves nothing about the user's
// browser, and every automation tool already does it.
//
// Two transports, both against the live browser:
//
//   extension — Playwright Extension relay (chrome.debugger). Zero approval
//        dialogs when PLAYWRIGHT_MCP_EXTENSION_TOKEN is set, and no
//        --remote-debugging-port needed, so it can start unattended.
//        Measured limits: no browser-level CDP (Target.attachToBrowserTarget is
//        "Not allowed") ⇒ no Emulation.setFocusEmulationEnabled, no
//        Browser.grantPermissions; the attached tab reports
//        visibilityState=hidden while in the background (page.mjs compensates).
//        All playwright-internal coupling lives in ./extension-transport.mjs.
//
//   cdp — connectOverCDP against Chrome started with --remote-debugging-port,
//        via ./cdp-shim.mjs (Chrome 152 disables /json/* on the default
//        profile). Full CDP power, but Chrome asks the operator to approve every
//        new debugging client, so it cannot bootstrap unattended.
//
// Node only: Bun's WebSocket client cannot carry Playwright's CDP transport.
import { createRequire } from "node:module";
import { connectViaExtension, extensionSupport } from "./extension-transport.mjs";

const require = createRequire(import.meta.url);

export const DEFAULT_MODE = process.env.BC_MODE ?? "extension";
const SHIM_URL = process.env.BC_CDP_URL ?? "http://localhost:9333";

/**
 * @param {{ mode?: "extension"|"cdp", clientName?: string, shimUrl?: string }} options
 * @returns {Promise<{ browser: import("playwright-core").Browser, context: import("playwright-core").BrowserContext, mode: string, capabilities: object }>}
 */
export async function attach({ mode = DEFAULT_MODE, clientName = "browser-control", shimUrl = SHIM_URL, trace = false } = {}) {
  let browser;
  if (mode === "cdp") {
    const { chromium } = require("playwright-core");
    browser = await chromium.connectOverCDP(shimUrl, { timeout: 30_000 });
  } else {
    ({ browser } = await connectViaExtension({ clientName }));
  }
  const context = browser.contexts()[0];
  const capabilities = await probeCapabilities(context, mode);
  // Tracing works even over the extension bridge (verified: trace.trace +
  // trace.network + screencast frames), so it is offered on both transports.
  if (trace || process.env.BC_TRACE === "1") {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      capabilities.tracing = true;
    } catch (err) {
      capabilities.tracing = String(err?.message ?? err).split("\n")[0];
    }
  }
  return { browser, context, mode, capabilities, saveTrace: (file) => saveTrace(context, file) };
}

/** Flush the trace to `file` (no-op when tracing was never started). */
async function saveTrace(context, file) {
  try {
    await context.tracing.stop({ path: file });
    return { ok: true, file };
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).split("\n")[0] };
  }
}

/** What the current playwright-core build can do (for diagnostics). */
export function transportSupport() {
  return { extension: extensionSupport(), cdp: { shimUrl: SHIM_URL } };
}

/**
 * Feature-detect instead of assuming: page control degrades gracefully when a
 * transport cannot offer raw CDP or focus emulation.
 */
async function probeCapabilities(context, mode) {
  const capabilities = { mode, rawCdp: false, focusEmulation: false, browserPermissions: false };
  const page = context.pages()[0];
  if (!page) return capabilities;
  let session = null;
  try {
    session = await context.newCDPSession(page);
    capabilities.rawCdp = true;
  } catch {}
  if (session) {
    try {
      await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await session.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
      capabilities.focusEmulation = true;
    } catch {}
    await session.detach().catch(() => {});
  }
  // Probing must not leave state behind: granting a permission to detect the
  // capability would persist a site setting in the operator's profile, so it is
  // cleared again immediately.
  try {
    await context.grantPermissions(["notifications"], { origin: "https://bc-capability-probe.invalid" });
    capabilities.browserPermissions = true;
    await context.clearPermissions().catch(() => {});
  } catch {}
  return capabilities;
}
