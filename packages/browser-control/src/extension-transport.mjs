// THE ONLY FILE THAT TOUCHES PLAYWRIGHT INTERNALS.
//
// playwright-core ships the extension relay (tools/mcp/{cdpRelay,extensionContextFactory}.ts)
// but omits it from the package "exports" map, so we load lib/coreBundle.js and
// call tools.resolveCLIConfigForMCP + tools.createBrowserWithInfo directly.
// Requires playwright-core >= 1.63; 1.62.1 has the code but does not export it.
// A rename in a future release breaks only THIS file: the fallback is our own
// MV3 extension embedding Playwright (playwright-crx) behind the same exports.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Read (never create) the extension token: PLAYWRIGHT_MCP_EXTENSION_TOKEN, else
 * ~/.config/browser-control/token — chmod 600 it, never echo it: it controls the whole browser.
 */
export function loadToken() {
  if (process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) return { source: "env" };
  const file = process.env.BC_TOKEN_FILE ?? path.join(os.homedir(), ".config", "browser-control", "token");
  try {
    const token = readFileSync(file, "utf8").trim();
    if (!token) return { source: "none", reason: `${file} is empty` };
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
    return { source: "file", file };
  } catch {
    return { source: "none", reason: `no env var and no ${file}` };
  }
}

/** Absolute path of the internal bundle (not resolvable via package exports). */
function bundlePath() {
  return path.join(path.dirname(require.resolve("playwright-core")), "lib", "coreBundle.js");
}

/** Which playwright-core is installed, and can it do extension mode? */
export function extensionSupport() {
  const version = require("playwright-core/package.json").version;
  let factory = false;
  try {
    factory = typeof require(bundlePath()).tools?.createBrowserWithInfo === "function";
  } catch {}
  return { version, supported: factory };
}

function channelExecutable(channel) {
  try {
    return require(bundlePath()).registry?.registry?.findExecutable(channel)?.executablePath();
  } catch {
    return undefined; // unknown channel: the caller falls back to the original error
  }
}

// playwright detects the extension by listing profile dirs under the channel's
// user-data-dir, and listProfileDirectories() swallows every readdir error
// (coreBundle.js: `catch { return []; }`). On macOS that dir is TCC-protected:
// without Full Disk Access it sees zero profiles and reports "Playwright
// Extension not found" for a working extension. Passing executablePath skips
// the scan (coreBundle.js:73249-73252) — hence the retry below.
const CONNECT_MS = Number(process.env.BC_EXTENSION_CONNECT_MS ?? 20_000);

/**
 * Connect to the operator's already-open browser through the extension.
 * @returns {Promise<{ browser: import("playwright-core").Browser, token: object }>}
 */
export async function connectViaExtension({ clientName = "browser-control", browserChannel = "chrome" } = {}) {
  const token = loadToken();
  const { version, supported } = extensionSupport();
  if (!supported) {
    throw new Error(
      `extension transport unavailable: playwright-core ${version} does not export the extension factory. ` +
        "Install >= 1.63 (e.g. playwright-core@1.63.0-alpha-2026-08-31) or use mode:'cdp'.",
    );
  }
  const { tools } = require(bundlePath());
  // executablePath travels in the CLI options, not the config: createBrowserWithInfo reads its third argument.
  const open = async (executablePath) => {
    const config = await tools.resolveCLIConfigForMCP({ extension: true, browser: browserChannel }, process.env);
    const { browser } = await tools.createBrowserWithInfo(config, { clientName }, { browser: browserChannel, executablePath });
    return { browser, token };
  };
  try {
    return await open(undefined);
  } catch (err) {
    if (!/Playwright Extension not found/.test(String(err?.message ?? err))) throw err;
    const executablePath = channelExecutable(browserChannel);
    if (!executablePath) throw err;
    // Bound the wait: with no extension answering, the relay hangs forever.
    return await Promise.race([
      open(executablePath),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `the Playwright Extension did not connect within ${CONNECT_MS}ms. Either it is not installed in the ${browserChannel} profile ` +
                  "(install it from https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm), " +
                  "or this terminal cannot read the Chrome profile directory — grant it Full Disk Access, or raise BC_EXTENSION_CONNECT_MS.",
              ),
            ),
          CONNECT_MS,
        ).unref(),
      ),
    ]);
  }
}
