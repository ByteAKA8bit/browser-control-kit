// Local CI, run by the git hooks (no GitHub Actions).
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
  }
};

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
  const required = [
    [pool, "BC_ALLOW_TAB_CREATE", "tab-creation gate"],
    [pool, "MAX_TABS_EXTENSION", "extension tab ceiling"],
    [pool, "only ONE pool per connection", "single-pool guard"],
    [page, "serialiseNavigation", "navigation lock"],
    [page, "BC_ALLOW_INIT_SCRIPT", "addInitScript gate"],
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

if (!offlineOnly) {
  console.log("browser checks");
  const chromeUp = (() => {
    try {
      execSync("pgrep -f 'MacOS/Google Chrome' >/dev/null 2>&1");
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
    for (const suite of ["test/dom-input.test.mjs", "test/pool.test.mjs"]) {
      step(suite, () => {
        const out = execSync(`node --test ${suite}`, {
          cwd: path.join(ROOT, "packages/browser-control"),
          env: { ...process.env, BC_ALLOW_TAB_CREATE: "1" },
          stdio: "pipe",
        }).toString();
        const pass = /# pass (\d+)/.exec(out)?.[1] ?? "?";
        const fail = /# fail (\d+)/.exec(out)?.[1] ?? "?";
        if (fail !== "0") throw new Error(`${fail} failing tests`);
        return `${pass} passed`;
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
