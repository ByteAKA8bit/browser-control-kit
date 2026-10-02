// Attach to the browser the operator is ACTUALLY using, over one of two live
// transports: `extension` (Playwright Extension relay over chrome.debugger — no
// approval dialog when PLAYWRIGHT_MCP_EXTENSION_TOKEN is set, no
// --remote-debugging-port, so it starts unattended; playwright-internal coupling
// lives in ./extension-transport.mjs) and `cdp` (connectOverCDP through
// ./cdp-shim.mjs, needed because Chrome 152 disables /json/* on the default
// profile, and the only transport with full CDP power).
//
// Non-goal: launching a throwaway dev profile — no session, no extensions, no
// real-world state, and every other automation tool already does it.
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
// Same files scripts/install-shim-service.mjs points launchd at, so one log.
const SHIM_LOG_DIR = path.join(os.homedir(), ".cache", "browser-control");

/** Is a CDP shim listening on `url`? An open port counts even without an answer: the shim replies to nothing while Chrome's approval dialog is up, and a second one could only fail to bind. */
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
 * Guarantee a shim on `url`, starting a detached one if needed; BC_SHIM_AUTOSTART=0
 * (default 1) turns a missing shim into an error instead.
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
  // Detached and unref'd on purpose: Chrome asks the operator to approve every new
  // external debugging client and never remembers the answer, so the click count
  // equals the number of shim PROCESSES, not of runs. The shim must OUTLIVE this run.
  const child = spawn(process.execPath, [SHIM_SCRIPT], {
    detached: true,
    stdio: ["ignore", ...shimLogFds()],
    env: { ...process.env, SHIM_PORT: port || "9333" },
  });
  child.unref();
  // A child that is already gone is the EADDRINUSE case: it found another shim on the
  // port and stood down (see src/cdp-shim.mjs), so calling it `started` would misreport
  // who paid for the approval click. "exit" lands only on a later tick while the first
  // probe can succeed instantly, so the decision reads the synchronous
  // exitCode/signalCode; the listener stays only to record a code we may already miss.
  let gone = null;
  child.once("exit", (code, signal) => {
    gone = signal ? `was killed by ${signal}` : `exited with code ${code}`;
  });
  const whyGone = () => {
    if (gone === null && child.signalCode !== null) gone = `was killed by ${child.signalCode}`;
    else if (gone === null && child.exitCode !== null) gone = `exited with code ${child.exitCode}`;
    return gone;
  };
  const startMs = Number(process.env.BC_SHIM_START_MS ?? 15_000);
  const deadline = Date.now() + startMs;
  while (Date.now() < deadline) {
    if (await probeShim(url)) {
      const why = whyGone();
      return { url, started: why === null, pid: why === null ? (child.pid ?? null) : null };
    }
    await sleep(100);
  }
  throw new Error(
    `Started a CDP shim (pid ${child.pid}) but ${url} never accepted a connection within ${startMs}ms, and the process ${whyGone() ?? "is still running without a listening port"}. Read ${path.join(SHIM_LOG_DIR, "shim.err.log")} for its own account, raise BC_SHIM_START_MS if this machine is simply slow, or run \`npm run shim\` in a terminal to watch it start.`,
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
 * Turn a failed connectOverCDP into something the operator can act on. The two `cdp`
 * failures need opposite answers — Chrome started WITHOUT --remote-debugging-port (no
 * dialog will ever appear: relaunch it, or point CHROME_PORT_FILE at the right profile)
 * versus an unanswered "Allow remote debugging?" dialog (click it); reporting both as
 * "the port never answered" sent operators hunting for a dialog that did not exist.
 * Only /shim/status tells them apart, and it answers with no Chrome socket attached.
 */
async function whyCdpFailed(url, err) {
  const detail = String(err?.message ?? err).split("\n")[0];
  const status = await shimStatus(url);
  if (!status) {
    return `The CDP shim on ${url} stopped answering, so this run has no browser to drive (${detail}). Read ${path.join(SHIM_LOG_DIR, "shim.err.log")}, run \`npm run shim\` in a terminal to watch it live, or set BC_CDP_URL to a shim you start yourself.`;
  }
  if (!status.attached) {
    const reason = status.reason ?? `it has not reached Chrome on ${status.chrome} yet, reading the port from ${status.portFile}`;
    return `The CDP shim on ${url} is listening but has no approved Chrome connection: ${reason}. Settle that and run again — the shim stays up, so this costs no extra approval click (${detail}).`;
  }
  return `The CDP shim on ${url} is attached to Chrome, so this is not an approval problem (${detail}). Read ${path.join(SHIM_LOG_DIR, "shim.err.log")}, or set BC_CDP_URL to another shim.`;
}

/** The shim's own account of its Chrome connection, or null if it cannot say. */
async function shimStatus(url, timeoutMs = Number(process.env.BC_SHIM_PROBE_MS ?? 1_000)) {
  try {
    const res = await fetch(new URL("/shim/status", url), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null; // nothing there to ask, which the caller reports as its own case
  }
}

/**
 * Attach over `extension` (the attached tab reports visibilityState=hidden while in the background; page.mjs compensates) or `cdp`.
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
    try {
      browser = await chromium.connectOverCDP(shimUrl, { timeout: 30_000 });
    } catch (err) {
      throw new Error(await whyCdpFailed(shimUrl, err));
    }
  } else {
    ({ browser } = await connectViaExtension({ clientName }));
  }
  const context = browser.contexts()[0];
  const capabilities = await probeCapabilities(context, mode);
  // `pid` is null for a reused shim: we know the port answered, not who owns it.
  if (shim) capabilities.shim = shim;
  // Verified over the extension bridge too (trace.trace + trace.network + screencast).
  if (trace || process.env.BC_TRACE === "1") {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      capabilities.tracing = true;
    } catch (err) {
      capabilities.tracing = String(err?.message ?? err).split("\n")[0];
    }
  }
  // Agents open tabs they never close, so governance is on; BC_TAB_GUARD=0 (or guard:false) opts out.
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

/** Feature-detect: the extension relay refuses browser-level CDP (Target.attachToBrowserTarget is "Not allowed"), hence no focus emulation and no Browser.grantPermissions there. */
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
  // Granting would persist a site setting in the operator's profile, so it is cleared at once.
  try {
    await context.grantPermissions(["notifications"], { origin: "https://bc-capability-probe.invalid" });
    capabilities.browserPermissions = true;
    await context.clearPermissions().catch(() => {});
  } catch {}
  return capabilities;
}
