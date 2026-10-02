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
//        profile). Full CDP power. Chrome asks the operator to approve every new
//        external debugging client and never remembers the answer, so the shim
//        holds ONE approved socket and proxies all clients over it: the click
//        count equals the number of shim PROCESSES, not the number of runs.
//        Hence attach() reuses a listening shim and otherwise starts a DETACHED
//        one that outlives this run — one click at the first operation, then
//        silence. BC_SHIM_AUTOSTART=0 turns a missing shim back into an error.
//
// Node only: Bun's WebSocket client cannot carry Playwright's CDP transport.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { connectViaExtension, extensionSupport } from "./extension-transport.mjs";
import { TabGuard, guardBrowser, guardContext } from "./tab-guard.mjs";

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_MODE = process.env.BC_MODE ?? "extension";
const SHIM_URL = process.env.BC_CDP_URL ?? "http://localhost:9333";
const SHIM_SCRIPT = path.join(import.meta.dirname, "cdp-shim.mjs");
// Same files scripts/install-shim-service.mjs points launchd at, so `tail -f`
// shows one log whichever way the shim was started.
const SHIM_LOG_DIR = path.join(os.homedir(), ".cache", "browser-control");

/**
 * Is a CDP shim listening on `url`? An open port counts even without an answer:
 * while Chrome's "Allow remote debugging?" dialog is up the shim replies to
 * nothing, and mistaking that for "no shim" would start a second one that can
 * only fail to bind.
 */
export async function probeShim(url = SHIM_URL, timeoutMs = Number(process.env.BC_SHIM_PROBE_MS ?? 1_000)) {
  try {
    const res = await fetch(new URL("/json/version", url), { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer().catch(() => {}); // drain, so the socket closes now rather than at GC
    return true;
  } catch {} // not answering yet — fall through to the cheaper question
  const { hostname, port } = new URL(url);
  return await portOpen(hostname, Number(port) || 80, timeoutMs);
}

/** Does anything accept a TCP connection there? Resolves, never rejects. */
function portOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false)); // ECONNREFUSED: nothing is listening
  });
}

/**
 * Guarantee a shim on `url`, starting a detached one if needed.
 * @returns {Promise<{ url: string, started: boolean, pid: number|null }>}
 */
export async function ensureShim(url = SHIM_URL) {
  if (await probeShim(url)) return { url, started: false, pid: null };
  if ((process.env.BC_SHIM_AUTOSTART ?? "1") !== "1") {
    throw new Error(
      `No CDP shim is listening on ${url} and BC_SHIM_AUTOSTART=0 forbids starting one. Run \`npm run shim\` in another terminal, or \`npm run shim:service\` to keep it running across logins.`,
    );
  }
  const { hostname, port } = new URL(url);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
    throw new Error(
      `BC_CDP_URL points at ${hostname}, which is not this machine, so no shim can be started for you. Run \`npm run shim\` on that host, or set BC_SHIM_AUTOSTART=0 to make this an error instead of a surprise.`,
    );
  }
  // Detached and unref'd on purpose: the shim must OUTLIVE this run, otherwise
  // the next attach() starts a fresh one and costs another approval click.
  const child = spawn(process.execPath, [SHIM_SCRIPT], {
    detached: true,
    stdio: ["ignore", ...shimLogFds()],
    env: { ...process.env, SHIM_PORT: port || "9333" },
  });
  child.unref();
  const deadline = Date.now() + Number(process.env.BC_SHIM_START_MS ?? 15_000);
  while (Date.now() < deadline) {
    if (await probeShim(url)) return { url, started: true, pid: child.pid ?? null };
    await sleep(100);
  }
  throw new Error(
    `Started a CDP shim (pid ${child.pid}) but ${url} never accepted a connection; see ${path.join(SHIM_LOG_DIR, "shim.err.log")}. Run \`npm run shim\` in a terminal to see why, or \`npm run shim:service\` to supervise it.`,
  );
}

/** stdout/stderr targets for the detached shim; falls back to /dev/null-ish "ignore". */
function shimLogFds() {
  try {
    mkdirSync(SHIM_LOG_DIR, { recursive: true });
    return [openSync(path.join(SHIM_LOG_DIR, "shim.log"), "a"), openSync(path.join(SHIM_LOG_DIR, "shim.err.log"), "a")];
  } catch {
    return ["ignore", "ignore"]; // unwritable cache dir must not stop the attach
  }
}

/**
 * @param {{ mode?: "extension"|"cdp", clientName?: string, shimUrl?: string, trace?: boolean,
 *          guard?: boolean | { budget?: number, idleMs?: number, evict?: boolean } }} options
 * @returns {Promise<{ browser: import("playwright-core").Browser, context: import("playwright-core").BrowserContext, mode: string, capabilities: object, tabs: TabGuard | null, saveTrace: (file: string) => Promise<object> }>}
 */
export async function attach({ mode = DEFAULT_MODE, clientName = "browser-control", shimUrl = SHIM_URL, trace = false, guard = true } = {}) {
  let browser;
  let shim = null;
  if (mode === "cdp") {
    shim = await ensureShim(shimUrl);
    const { chromium } = require("playwright-core");
    browser = await chromium.connectOverCDP(shimUrl, { timeout: 30_000 });
  } else {
    ({ browser } = await connectViaExtension({ clientName }));
  }
  const context = browser.contexts()[0];
  const capabilities = await probeCapabilities(context, mode);
  // Which shim this run is riding on, and whether it had to be started (i.e.
  // whether the operator saw a dialog). `pid` is null for a reused one — we
  // know the port answered, not who owns it, and guessing would be a lie.
  if (shim) capabilities.shim = shim;
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
  // Tab governance is on by default: the caller is usually an agent, and agents
  // open tabs they never close. BC_TAB_GUARD=0 (or guard:false) opts out.
  if (guard === false || process.env.BC_TAB_GUARD === "0") {
    return { browser, context, mode, capabilities, tabs: null, saveTrace: (file) => saveTrace(context, file) };
  }
  const tabs = new TabGuard(context, { mode, ...(guard === true ? {} : guard) });
  const guarded = guardContext(context, tabs);
  return {
    browser: guardBrowser(browser, tabs),
    context: guarded,
    mode,
    capabilities,
    tabs,
    saveTrace: (file) => saveTrace(context, file),
  };
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
  return { extension: extensionSupport(), cdp: { shimUrl: SHIM_URL, autostart: (process.env.BC_SHIM_AUTOSTART ?? "1") === "1" } };
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
