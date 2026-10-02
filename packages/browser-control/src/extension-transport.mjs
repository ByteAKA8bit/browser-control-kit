// THE ONLY FILE THAT TOUCHES PLAYWRIGHT INTERNALS.
//
// playwright-core ships the Playwright-Extension relay itself
// (packages/playwright-core/src/tools/mcp/{cdpRelay,extensionContextFactory}.ts):
// it starts a local WS relay, opens chrome-extension://<id>/connect.html with
// ?mcpRelayUrl=…&token=…, and hands the result to chromium.connectOverCDP().
// That factory is NOT part of the package's public "exports" map, so we reach it
// through the bundle. Consequences, deliberately quarantined here:
//
//   * needs playwright-core >= 1.63 (1.62.1 has the code but does not export it)
//   * a future release may rename/move it → only THIS file breaks
//
// Replacement path when that happens: publish our own MV3 extension embedding
// Playwright (the playwright-crx approach) and swap this module's body. The
// exported signature is all the rest of the package depends on.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * The extension token grants control over the whole browser, so it should not
 * live in shell history or CI logs. If PLAYWRIGHT_MCP_EXTENSION_TOKEN is unset
 * we READ (never create) ~/.config/browser-control/token — chmod 600 it yourself:
 *   mkdir -p ~/.config/browser-control && pbpaste > ~/.config/browser-control/token && chmod 600 $_
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

/** Where the channel's Chrome lives, asked of playwright's own registry. */
function channelExecutable(channel) {
  try {
    return require(bundlePath()).registry?.registry?.findExecutable(channel)?.executablePath();
  } catch {
    return undefined; // unknown channel: the caller falls back to the original error
  }
}

// playwright decides whether the extension is installed by listing the profile
// directories under the channel's user-data-dir — and listProfileDirectories()
// swallows EVERY readdir error (coreBundle.js: `catch { return []; }`). On macOS
// that directory is TCC-protected, so a terminal without Full Disk Access gets
// EPERM, sees zero profiles, and reports "Playwright Extension not found" for an
// extension that is installed and working. Passing an executablePath skips the
// scan entirely (coreBundle.js:73249-73252), which is why the retry below exists.
const CONNECT_MS = Number(process.env.BC_EXTENSION_CONNECT_MS ?? 20_000);

/**
 * Connect to the browser the operator already has open, through the extension.
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
  // executablePath rides in the CLI options, not the config: createBrowserWithInfo
  // reads it from its third argument via resolveExtensionOptions().
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
    // The scan is unreliable, the extension may well be there: ask the browser
    // instead of the filesystem, but bound the wait — with no extension to
    // answer, the relay would otherwise hang forever.
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
