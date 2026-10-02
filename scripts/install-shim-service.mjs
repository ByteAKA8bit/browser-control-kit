// Keep the approved CDP connection alive across runs.
//
// Chrome asks the operator to approve every new external CDP connection and
// never remembers the answer. The shim turns "one dialog per run" into "one
// dialog per shim process" by proxying every client over a single socket
// (src/cdp-shim.mjs) — which only pays off if the shim outlives the runs.
//
// attach({ mode: "cdp" }) already starts a detached shim on demand, so this is
// the stronger guarantee rather than a prerequisite: launchd starts it at login
// and restarts it if it dies, so the shim is up before the first run and the
// operator clicks Allow once per Chrome restart — even after a reboot.
//
//   node scripts/install-shim-service.mjs             install + start
//   node scripts/install-shim-service.mjs --uninstall  stop + remove
//
// Environment at install time is captured into the plist (SHIM_PORT,
// CHROME_PORT, CHROME_PORT_FILE, CHROME_HOST, BC_SHIM_KEEPALIVE_MS), because
// launchd agents do not inherit a shell.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const LABEL = "com.browser-control.shim";
const ROOT = path.resolve(import.meta.dirname, "..");
const SHIM = path.join(ROOT, "packages/browser-control/src/cdp-shim.mjs");
const PLIST = path.join(os.homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = path.join(os.homedir(), ".cache/browser-control");
const uninstall = process.argv.includes("--uninstall");
const target = `gui/${process.getuid()}`;

if (os.platform() !== "darwin") {
  console.error(`launchd is macOS-only. On other systems run \`node ${path.relative(ROOT, SHIM)}\` under your own supervisor.`);
  process.exit(2);
}

const bootout = () => {
  try {
    execFileSync("launchctl", ["bootout", `${target}/${LABEL}`], { stdio: "pipe" });
    return true;
  } catch {
    return false; // not loaded; nothing to stop
  }
};

if (uninstall) {
  const stopped = bootout();
  if (existsSync(PLIST)) rmSync(PLIST);
  console.log(`${LABEL}: ${stopped ? "stopped and " : ""}removed`);
  process.exit(0);
}

if (!existsSync(SHIM)) throw new Error(`shim not found at ${SHIM}`);
mkdirSync(path.dirname(PLIST), { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const env = {};
for (const key of ["SHIM_PORT", "CHROME_PORT", "CHROME_PORT_FILE", "CHROME_HOST", "BC_SHIM_KEEPALIVE_MS"]) {
  if (process.env[key]) env[key] = process.env[key];
}
const envEntries = Object.entries(env)
  .map(([k, v]) => `      <key>${k}</key>\n      <string>${v}</string>`)
  .join("\n");

writeFileSync(
  PLIST,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${process.execPath}</string>
      <string>${SHIM}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
${envEntries ? `    <key>EnvironmentVariables</key>\n    <dict>\n${envEntries}\n    </dict>\n` : ""}    <key>StandardOutPath</key>
    <string>${path.join(LOG_DIR, "shim.log")}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(LOG_DIR, "shim.err.log")}</string>
  </dict>
</plist>
`,
);

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
