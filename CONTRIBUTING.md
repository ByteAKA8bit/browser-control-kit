# Contributing

## Setup

```bash
npm i && node scripts/install-hooks.mjs   # sets git config core.hooksPath .githooks
```

Node >= 22 (the global `WebSocket` is load-bearing in `src/cdp-shim.mjs`). **Bun is unsupported**: its WebSocket client cannot carry Playwright's CDP transport, and `connectOverCDP` hangs at `<ws connecting>`.

Everything is ESM `.mjs` with no build step. Do not add `.js`, `.ts`, a bundler, or a transpiler. Formatting is `.editorconfig` only: UTF-8, LF, 2-space indent, trimmed trailing whitespace, final newline.

## Never add a dependency

`playwright-core` (exact pin) is the only third-party package in the repo, and it stays that way. ZIP writing, CRC32, PNG bytes, the CSV BOM, the RFC 6455 server in `src/ws-server.mjs`, the semaphore and `sleep` are all hand-rolled on purpose. If you need something, write it — a pull request that adds a dependency will be declined. (The duplicated one-line `sleep` helpers are deliberate too; do not factor them into a shared util module.)

## The two test tiers

```bash
npm run test:offline   # 69 cases, no browser needed (tab guard, ws codec, shim autostart + policy, MCP protocol)
npm run test:unit      # dom-input, 16 cases   (needs Chrome + the Playwright Extension + a token)
npm run test:pool      # pool, 8 cases         (needs Chrome + the Playwright Extension + a token)
npm test               # every suite, --test-concurrency=1
npm run check          # the whole local CI: offline tier + browser suites
node scripts/check.mjs --offline   # exactly what pre-commit runs
```

`--test-concurrency=1` is mandatory: the Playwright Extension accepts exactly one client, so two suite processes mean one cannot connect and the other is interrupted. One `attach()` per process.

The browser tier needs a machine that is actually set up: Chrome running, the Playwright Extension installed in the profile, a token. When a prerequisite is missing the suites report `# SKIP <reason>` (see `test/attached.mjs`) and `scripts/check.mjs` skips its browser step with a notice — exit 0 either way, so a missing local prerequisite never blocks a commit, and the tier never runs in GitHub Actions. Run `npm run cleanup` after a browser run.

Framework is built-in `node:test` + `node:assert/strict`. No mocks, snapshots, coverage tooling or reporters.

## Adding a test file

There is no discovery — a new suite must be registered in **three** places or it silently never runs:

1. `scripts.test` in the root `package.json`
2. `scripts.test` in `packages/browser-control/package.json`
3. the suite array in `scripts/check.mjs` (a browserless suite goes in the offline tier loop, so it runs on every commit)

Open the file with a `//` header saying why it exists and the exact command that runs it, import from `../src/<module>.mjs` directly rather than through `index.mjs`, and build page state with inline template-literal HTML plus `page.setContent(...)`.

## Crash-guard string audit

Chrome was crashed 11 times while this was built; the guards that came out of it are checked by string in `scripts/check.mjs`. These literals must stay in the source:

- `BC_ALLOW_TAB_CREATE`, `MAX_TABS_EXTENSION`, `only ONE pool per connection` — `packages/browser-control/src/pool.mjs`
- `serialiseNavigation`, `BC_ALLOW_INIT_SCRIPT` — `packages/browser-control/src/page.mjs`

Renaming one without updating `scripts/check.mjs` breaks pre-commit. The invariants behind them (never `addInitScript` on the extension transport, navigation serialised process-wide, never close the last ordinary tab, one pool per connection, the `TabGuard` budget) are not negotiable; see the guards table in [README.md](README.md) and the architecture notes in [AGENTS.md](AGENTS.md).

## Style

- One-line `/** */` JSDoc on exports; a `//` file header stating the goal and the non-goal
- Config read inline at call time: `process.env.BC_X ?? default`, booleans as `=== "1"`, each flag documented next to it
- Errors are full sentences naming the escape hatch and why it exists; expected failures use a terse `catch {}` with a comment saying why
- Degraded operations return `{ skipped: true, reason }` instead of throwing
- Playwright internals stay quarantined in `src/extension-transport.mjs`

## Pull requests

Run `node scripts/check.mjs --offline` (pre-commit does it for you) and, if you have Chrome and a token, `npm run check`. Keep the commit focused, and update `README.md` / `README.zh-CN.md` together when behaviour changes.
