// Install the CDP shim as a launchd agent (macOS only).
// Non-goal: not a prerequisite — attach({ mode: "cdp" }) starts a shim on demand;
// launchd only makes it survive logout and reboot, so Chrome's "Allow external
// connection" dialog costs one click per Chrome restart instead of one per run.
// Invariant: everything above the main guard is pure string building and is tested
// off-macOS (packages/browser-control/test/shim-service.test.mjs).
// Invariant: `footprint()` lists EVERY path this kit can create, --status prints it
// and --uninstall removes all of it bar the operator's own token.
//
//   node scripts/install-shim-service.mjs             install + start
//   node scripts/install-shim-service.mjs --status     what is on this machine
//   node scripts/install-shim-service.mjs --uninstall  stop + remove everything
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LABEL = "com.browser-control.shim";
const ROOT = path.resolve(import.meta.dirname, "..");
const SHIM = path.join(ROOT, "packages/browser-control/src/cdp-shim.mjs");

// A plist is XML and a home directory may legally contain `&` or `<`; unescaped, launchctl
// refuses the file with a parse error that never mentions the path.
const xml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Every path this kit can put on a machine, in one list so "what did you
 * install?" and "remove it all" cannot drift apart. `ours` is what --uninstall
 * deletes; the token and npm's global link belong to someone else — named, so
 * they are findable, never touched.
 * @param {{ home?: string, logDir?: string, label?: string, npmPrefix?: string }} where
 */
export const footprint = ({ home = os.homedir(), logDir = process.env.BC_SHIM_LOG_DIR, label = LABEL, npmPrefix = path.resolve(path.dirname(process.execPath), "..") } = {}) => {
  const cache = logDir ?? path.join(home, ".cache", "browser-control");
  return [
    { path: path.join(home, "Library/LaunchAgents", `${label}.plist`), what: "launchd agent (macOS requires this location)", ours: true },
    { path: path.join(cache, "shim.log"), what: "shim stdout, truncated past BC_SHIM_LOG_MAX", ours: true },
    { path: path.join(cache, "shim.err.log"), what: "shim stderr, truncated past BC_SHIM_LOG_MAX", ours: true },
    { path: cache, what: "the only directory this kit writes to", ours: true, dir: true },
    { path: path.join(home, ".config", "browser-control", "token"), what: "YOUR extension token — read, never written, never removed", ours: false },
    { path: path.join(npmPrefix, "bin", "browser-control-mcp"), what: "global command, only if you ran `npm link` — `npm rm -g browser-control-mcp` removes it", ours: false },
    { path: path.join(npmPrefix, "lib", "node_modules", "browser-control-mcp"), what: "symlink to this repo, npm's to remove", ours: false, dir: true },
  ];
};

/** The environment the agent needs, because launchd agents do not inherit a shell. */
export const ENV_KEYS = ["SHIM_PORT", "CHROME_PORT", "CHROME_PORT_FILE", "CHROME_HOST", "BC_SHIM_KEEPALIVE_MS"];

/** Those of ENV_KEYS actually set now; an unset (or empty) one is left to the shim's own default. */
export const captureEnv = (source = process.env) => {
  const env = {};
  for (const key of ENV_KEYS) {
    if (source[key]) env[key] = source[key];
  }
  return env;
};

/** The agent definition launchd loads — pure, so it is testable without launchd. */
export const buildPlist = ({ label = LABEL, nodePath = process.execPath, shimPath = SHIM, logDir, env = {} }) => {
  const envEntries = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");

  // KeepAlive=true over a shim that exited whenever its first connect to Chrome failed meant
  // a relaunch every 10s (launchd's default) for as long as Chrome was closed → explicit 30s.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(nodePath)}</string>
      <string>${xml(shimPath)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Background</string>
${envEntries ? `    <key>EnvironmentVariables</key>\n    <dict>\n${envEntries}\n    </dict>\n` : ""}    <key>StandardOutPath</key>
    <string>${xml(path.join(logDir, "shim.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${xml(path.join(logDir, "shim.err.log"))}</string>
  </dict>
</plist>
`;
};

if (path.resolve(process.argv[1] ?? "") === import.meta.filename) {
  const PATHS = footprint();
  const PLIST = PATHS[0].path;
  const LOG_DIR = PATHS[3].path;
  const uninstall = process.argv.includes("--uninstall");
  const status = process.argv.includes("--status");

  // process.getuid is undefined on Windows: compute the launchctl target after this
  // guard, or a non-macOS run dies on a TypeError instead of the sentence below.
  if (os.platform() !== "darwin") {
    console.error(`launchd is macOS-only. On other systems run \`node ${path.relative(ROOT, SHIM)}\` under your own supervisor.`);
    process.exit(2);
  }

  const target = `gui/${process.getuid()}`;

  const bootout = () => {
    try {
      execFileSync("launchctl", ["bootout", `${target}/${LABEL}`], { stdio: "pipe" });
      return true;
    } catch {
      return false; // not loaded; nothing to stop
    }
  };

  if (status) {
    const loaded = (() => {
      try {
        return execFileSync("launchctl", ["list"], { stdio: "pipe" }).toString().includes(LABEL);
      } catch {
        return false;
      }
    })();
    console.log(`${LABEL}: ${loaded ? "running" : "not loaded"}`);
    for (const entry of PATHS) {
      const size = existsSync(entry.path) ? (entry.dir ? "dir" : `${statSync(entry.path).size} B`) : "absent";
      console.log(`  ${entry.ours ? "rm" : "  "}  ${entry.path.padEnd(64)} ${size.padStart(8)}  ${entry.what}`);
    }
    console.log("\n`rm` marks what --uninstall deletes. That is the whole footprint: nothing else is written anywhere.");
    process.exit(0);
  }

  if (uninstall) {
    const stopped = bootout();
    const removed = [];
    // Everything we created, including the directory once it is ours alone to drop.
    for (const entry of PATHS.filter((e) => e.ours && !e.dir)) {
      if (existsSync(entry.path)) {
        rmSync(entry.path);
        removed.push(entry.path);
      }
    }
    try {
      if (readdirSync(LOG_DIR).length === 0) {
        rmSync(LOG_DIR, { recursive: false });
        removed.push(LOG_DIR);
      }
    } catch {} // no directory, or somebody else's files in it: leave it alone
    console.log(
      [
        `${LABEL}: ${stopped ? "stopped and " : ""}removed`,
        ...removed.map((file) => `  rm ${file}`),
        `  kept ${PATHS.at(-1).path} — your token, ours to read and nothing else`,
      ].join("\n"),
    );
    process.exit(0);
  }

  if (!existsSync(SHIM)) throw new Error(`shim not found at ${SHIM}`);
  mkdirSync(path.dirname(PLIST), { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });

  const env = captureEnv();
  writeFileSync(PLIST, buildPlist({ label: LABEL, nodePath: process.execPath, shimPath: SHIM, logDir: LOG_DIR, env }));

  bootout(); // replace any previous instance
  execFileSync("launchctl", ["bootstrap", target, PLIST], { stdio: "inherit" });
  console.log(
    [
      `${LABEL}: installed and started`,
      `  plist   ${PLIST}`,
      `  logs    ${path.join(LOG_DIR, "shim.log")}`,
      `  env     ${Object.keys(env).length ? JSON.stringify(env) : "(defaults)"}`,
      "",
      "Chrome will ask to Allow once; every attach after that reuses the same approved socket.",
      "Restarting Chrome means one more click — the shim reconnects by itself.",
    ].join("\n"),
  );
}
