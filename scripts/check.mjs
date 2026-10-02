// Local CI, run by the git hooks; GitHub Actions runs the offline tier too.
//
// Two tiers, because half of this repo can only be verified against a real
// browser:
//   offline  — syntax check every source file + repo hygiene (fast, always runs)
//   browser  — the node:test suites, which need the operator's Chrome and the
//              Playwright Extension. Skipped with a clear notice when the
//              browser or token is missing, so a commit is never blocked by a
//              closed browser.
//
//   node scripts/check.mjs            offline checks + browser tests if possible
//   node scripts/check.mjs --offline  offline checks only
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const offlineOnly = process.argv.includes("--offline");
const failures = [];
const notes = [];

const step = (name, fn) => {
  try {
    const detail = fn();
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name} — ${String(err?.message ?? err).split("\n")[0]}`);
    if (err?.diagnostics) console.log(err.diagnostics.replace(/^(?=.)/gm, "    "));
  }
};

// A red suite used to reach CI as nothing but "Command failed: node --test …",
// because the child's TAP body — the assertion diff and the stack — stayed in
// the pipe. So echo it, capped: a suite that fails wholesale prints thousands
// of lines, and a drowned log hides the cause just as well as silence did.
const DIAGNOSTIC_CASES = 3;
const DIAGNOSTIC_BYTES = 6000;
const DIAGNOSTIC_ASIDE_BYTES = 1500;

// execSync hands back stdout/stderr as Buffers on a non-zero exit.
const suiteOutput = (err) => `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
const clamp = (text, limit, notes, what) => {
  const bytes = Buffer.byteLength(text);
  if (bytes <= limit) return text;
  notes.push(`${bytes - limit} more bytes of ${what} truncated`);
  return Buffer.from(text).subarray(0, limit).toString();
};

// The runner indents subtest diagnostics, so a failing case runs from its
// "not ok" line until the next result or comment line at any depth.
function failingCases(out) {
  const cases = [];
  let current = null;
  for (const line of out.split("\n")) {
    if (/^\s*not ok \d/.test(line)) cases.push((current = [line]));
    else if (!current) continue;
    else if (/^\s*(ok \d|# )/.test(line)) current = null;
    else current.push(line);
  }
  return cases.map((lines) => lines.join("\n").replace(/\s+$/, ""));
}

// A suite that dies on import reports only "test failed" in TAP; the real
// stack arrives as "#" comments (plus whatever reached stderr), so keep those
// on a smaller budget of their own rather than losing them to the case cap.
const SUMMARY_COMMENT = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms|Subtest:) /;
const childAside = (out, stderr) =>
  [...out.split("\n").filter((line) => line.startsWith("# ") && !SUMMARY_COMMENT.test(line)), String(stderr)]
    .join("\n")
    .trim();

function suiteFailure(stdout, stderr = "") {
  const out = String(stdout);
  const cases = failingCases(out);
  const count = /# fail (\d+)/.exec(out)?.[1];
  const err = new Error(count && count !== "0" ? `${count} failing tests` : "suite did not run");
  const notes = [];
  // With no "not ok" at all the suite never reported, and then the raw output
  // is the only evidence there is.
  const shown = cases.length ? cases.slice(0, DIAGNOSTIC_CASES).join("\n") : out.trimEnd();
  let body = clamp(shown, DIAGNOSTIC_BYTES, notes, "output");
  if (cases.length > DIAGNOSTIC_CASES) notes.push(`${cases.length - DIAGNOSTIC_CASES} further failing cases not shown`);
  const aside = cases.length ? childAside(out, stderr) : String(stderr).trim();
  if (aside) body += `\n--- child output ---\n${clamp(aside, DIAGNOSTIC_ASIDE_BYTES, notes, "child output")}`;
  err.diagnostics = `${body}${notes.length ? `\n… ${notes.join(", ")}.` : ""}`;
  return err;
}

async function sourceFiles() {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".mjs")) out.push(full);
    }
  };
  await walk(ROOT);
  return out;
}

console.log("offline checks");
const files = await sourceFiles();
step("syntax", () => {
  for (const f of files) execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  return `${files.length} files`;
});
step("no stray debugging left behind", () => {
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (/^\s*(console\.debug|debugger;)/m.test(src)) offenders.push(path.relative(ROOT, f));
  }
  if (offenders.length) throw new Error(offenders.join(", "));
  return "clean";
});
step("crash guards still in place", () => {
  // These guards exist because the extension bridge really did take Chrome down.
  const pool = readFileSync(path.join(ROOT, "packages/browser-control/src/pool.mjs"), "utf8");
  const page = readFileSync(path.join(ROOT, "packages/browser-control/src/page.mjs"), "utf8");
  const guard = readFileSync(path.join(ROOT, "packages/browser-control/src/tab-guard.mjs"), "utf8");
  const required = [
    [pool, "BC_ALLOW_TAB_CREATE", "tab-creation gate"],
    [pool, "MAX_TABS_EXTENSION", "extension tab ceiling"],
    [pool, "only ONE pool per connection", "single-pool guard"],
    [page, "serialiseNavigation", "navigation lock"],
    [page, "BC_ALLOW_INIT_SCRIPT", "addInitScript gate"],
    [guard, "protectedPages", "operator's tabs are off limits"],
    [pool, "function wouldEmptyBrowser", "never leave the browser with no tabs"],
    [guard, "wouldEmptyBrowser(", "tab guard goes through that same rule"],
  ];
  for (const [src, needle, label] of required) if (!src.includes(needle)) throw new Error(`${label} missing (${needle})`);
  return `${required.length} guards`;
});
step("license + package metadata", () => {
  if (!existsSync(path.join(ROOT, "LICENSE"))) throw new Error("LICENSE missing");
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "packages/browser-control/package.json"), "utf8"));
  if (pkg.license !== "MIT") throw new Error(`browser-control license is ${pkg.license}`);
  return "MIT";
});
// Suites that need no browser: they cover the tab, transport, shim and MCP
// logic that runs before or around Chrome, so they must pass on every commit
// rather than only when Chrome happens to be running.
const OFFLINE_SUITES = [
  ["packages/browser-control", "test/tab-guard.test.mjs"],
  ["packages/browser-control", "test/ws-server.test.mjs"],
  ["packages/browser-control", "test/shim-autostart.test.mjs"],
  ["packages/browser-control", "test/shim-policy.test.mjs"],
  ["packages/browser-control", "test/shim-recovery.test.mjs"],
  ["packages/browser-control", "test/shim-service.test.mjs"],
  ["packages/browser-control", "test/shim-session.test.mjs"],
  ["packages/mcp-server", "test/protocol.test.mjs"],
];
for (const [pkg, suite] of OFFLINE_SUITES) {
  step(`${pkg.replace("packages/", "")}/${suite}`, () => {
    let out;
    try {
      out = execSync(`node --test ${suite}`, { cwd: path.join(ROOT, pkg), stdio: "pipe" }).toString();
    } catch (err) {
      throw suiteFailure(err?.stdout ?? "", err?.stderr ?? "");
    }
    const fail = /# fail (\d+)/.exec(out)?.[1] ?? "?";
    if (fail !== "0") throw suiteFailure(out);
    return `${/# pass (\d+)/.exec(out)?.[1] ?? "?"} passed`;
  });
}

if (!offlineOnly) {
  console.log("browser checks");
  // Portable "is Chrome up?": this repo is used on more than one operating
  // system, and a macOS-only pgrep pattern would silently skip the tier.
  const chromeUp = (() => {
    const probe =
      process.platform === "win32"
        ? 'tasklist /FI "IMAGENAME eq chrome.exe" | findstr /I chrome.exe'
        : "pgrep -fi 'google chrome|chromium|chrome\\.exe' >/dev/null 2>&1";
    try {
      execSync(probe, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const tokenAvailable =
    !!process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN ||
    existsSync(process.env.BC_TOKEN_FILE ?? path.join(os.homedir(), ".config", "browser-control", "token"));

  if (!chromeUp || !tokenAvailable) {
    notes.push(`skipped browser tests (${!chromeUp ? "Chrome not running" : "no extension token"})`);
    console.log(`  – skipped: ${notes[notes.length - 1]}`);
  } else {
    // A missing local prerequisite must never block a commit — same policy as a
    // closed Chrome. The extension can be absent from the profile (or the
    // profile unreadable, which playwright reports as the same error), and that
    // says nothing about the code under review.
    for (const suite of ["test/dom-input.test.mjs", "test/pool.test.mjs"]) {
      step(suite, () => {
        let out;
        try {
          out = execSync(`node --test ${suite}`, {
            cwd: path.join(ROOT, "packages/browser-control"),
            env: { ...process.env, BC_ALLOW_TAB_CREATE: "1" },
            stdio: "pipe",
          }).toString();
        } catch (err) {
          out = suiteOutput(err);
          if (out.includes("Playwright Extension not found")) {
            notes.push("skipped browser tests (Playwright Extension not installed in this profile)");
            return "skipped: extension not installed";
          }
          throw suiteFailure(err?.stdout ?? "", err?.stderr ?? "");
        }
        const fail = /# fail (\d+)/.exec(out)?.[1] ?? "?";
        if (fail !== "0") throw suiteFailure(out);
        return `${/# pass (\d+)/.exec(out)?.[1] ?? "?"} passed`;
      });
    }
  }
}

console.log("");
if (failures.length) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`OK${notes.length ? ` (${notes.join("; ")})` : ""}`);
