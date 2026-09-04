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

/**
 * Connect to the browser the operator already has open, through the extension.
 * @returns {Promise<{ browser: import("playwright-core").Browser }>}
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
  const config = await tools.resolveCLIConfigForMCP({ extension: true, browser: browserChannel }, process.env);
  const { browser } = await tools.createBrowserWithInfo(config, { clientName }, { browser: browserChannel });
  return { browser, token };
}
