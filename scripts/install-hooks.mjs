// Point git at .githooks (versioned) instead of .git/hooks (not versioned).
// Run once per clone:  node scripts/install-hooks.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "inherit" });
console.log("git hooks enabled: .githooks (pre-commit = offline checks, pre-push = + browser tests)");
