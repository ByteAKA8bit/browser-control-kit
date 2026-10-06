**English** · [简体中文](README.zh-CN.md)

# browser-control-kit

Drives **the browser the operator is already using** — the Chrome that was opened by double-clicking it, with the real profile, the real logins, the real extensions.

- No launch flags, no `--user-data-dir`, no second instance, and no "Allow" click on the default transport
- Works on a **background tab**: it does not steal focus or interrupt what you are doing
- Tooling only; the suites for whatever app you are testing do not live in this repo

> Spinning up a blank dev profile is an explicit **non-goal**. No session, no extensions, no real state — it proves nothing, and there are a hundred projects that already do it.

## Layout

```
packages/browser-control/   how to control the browser (app-agnostic)
  src/extension-transport.mjs  the only file touching playwright internals (upgrades break here, nowhere else)
  src/attach.mjs               transport choice + capability probe + trace
  src/page.mjs                 capability-adaptive input, serialised navigation, puppeteer-flavoured API
  src/dom-input.mjs            DOM input primitives: actionability + hit test + shadow/frame reach
  src/transfer.mjs             upload / drop / drag (no CDP required)
  src/fixtures.mjs             zero-dependency xlsx / csv / png generation
  src/pool.mjs                 TabPool: parallel work across tabs, with the extension-transport limits
  src/tab-guard.mjs            TabGuard: named surfaces, recycle-first, measured idle windows, reaping
  src/cdp-shim.mjs             /json/* rebuild + single-socket CDP proxy (cdp transport only)
  src/ws-server.mjs            hand-rolled RFC 6455 server used by the shim
  test/                        node:test suites — browserless + real-browser
  cleanup.mjs                  closes only the tabs this tool left behind
packages/mcp-server/        MCP stdio server (bin: browser-control-mcp) — agents talk to this
packages/antd-kit/          how to drive Ant Design v6 (business-agnostic)
scripts/check.mjs           local CI (offline checks + real-browser suites)
scripts/crash-repro.mjs     crash bisection (deliberately kills Chrome; needs BC_CRASH_REPRO=1)
.githooks/                  pre-commit = offline checks, pre-push = + browser suites
examples/                   minimal runnable sample
```

Dependency direction is one-way: `your suites → antd-kit → browser-control → playwright-core`. `playwright-core` (exact pin) is the only third-party dependency in the repo; everything else is hand-rolled on purpose.

## The two transports, and the `auto` that picks between them

| Transport | Prerequisites | Approval clicks | Takes your screen? | Capabilities |
| --- | --- | --- | --- | --- |
| `extension` | [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) + its token | **none** — the token replaces the dialog | yes, ~150 ms per `attach()` (Chrome is launched with the relay's connect page, and raises itself) | No browser-level CDP (`Target.attachToBrowserTarget: Not allowed`), no `Browser.grantPermissions`, no focus emulation → input falls back to DOM primitives. Tab lifecycle is restricted (see the guards table) |
| `cdp` | a Chrome with a debugging port + `npm run shim:service` | **one**, per Chrome restart | **no** — `attach()` opens no page at all, and new tabs are created in the background | Full CDP: focus emulation, pre-granted permissions, download directory, URL interception, `Target.createTarget { background: true }` |

`DEFAULT_MODE` is `BC_MODE ?? "auto"`, and **`auto` is the recommended setting**: it probes `BC_CDP_URL` (default `http://localhost:9333`) and takes `cdp` when a shim is already answering, `extension` otherwise. It deliberately **never starts a shim** — starting one is the single step that can pop Chrome's approval dialog, and an unattended agent must not wait on a click. `capabilities.chose` records the decision and the reason.

So the undisturbing setup is: install the shim once (`npm run shim:service`), click Allow once per Chrome restart, and leave everything on `auto`. Without the shim nothing breaks — you get the extension transport, unattended, at the cost of that ~150 ms screen flash per attach.

Honest trade-off: `extension` costs you raw CDP and makes tab creation/navigation deliberately conservative, but it needs nothing beyond a running Chrome. `cdp` gives you everything CDP can do, at the price of a background process and one approval dialog whenever Chrome or the shim restarts.

Pin either with `BC_MODE=extension` / `BC_MODE=cdp` or `attach({ mode })`; the shim address is `BC_CDP_URL`.

## Quick start

```bash
npm i && node scripts/install-hooks.mjs   # Node >= 22. Not Bun: its WebSocket client
                                          # cannot carry Playwright's CDP transport
                                          # (connectOverCDP hangs at <ws connecting>)

# one-time: install the Playwright Extension, store the token from its status page
mkdir -p ~/.config/browser-control && pbpaste > ~/.config/browser-control/token && chmod 600 $_

npm run test:offline   # tab governance, focus, websocket codec, shim, MCP protocol — 167 cases, no browser needed
npm run test:unit      # DOM input, 19 cases   (needs Chrome + token)
npm run test:pool      # parallel pool, 8 cases (needs Chrome + token)
npm test               # all ten suites, --test-concurrency=1
npm run selftest       # end-to-end smoke; writes ./selftest.png
npm run cleanup        # closes the tabs this tool left behind (--dry-run reports only)
npm run shim           # /json/* rebuild + CDP proxy; only for BC_MODE=cdp
```

The token is read-only (`BC_TOKEN_FILE` overrides the path); this repo never writes or echoes it.

```js
import { attach, controlPage, TabPool } from "browser-control";

const { browser, context, capabilities } = await attach();   // extension transport by default
const page = controlPage(context.pages()[0], capabilities);
await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
await page.fill("#q", "hello");
await page.click("button[type=submit]");

const pool = await new TabPool(context, { size: 2, capabilities }).start();
const results = await pool.map(items, async (item, tab) => tab.evaluate(/* … */));

await browser.close();   // disconnects; it does not close your browser
```

## About that "Allow remote debugging?" dialog

Chrome prompts the operator for **every new external CDP connection** to the default profile and never remembers the answer (until approved, `/json/*` returns 404 and the WebSocket handshake just hangs). So the goal is not to dodge the dialog — it is to make the connection happen **once**.

| Approach | Clicks | Cost |
| --- | --- | --- |
| `extension` transport (default) | **0** — the token stands in for the click | No browser-level CDP (see above) |
| `cdp` + resident shim (`npm run shim:service`) | one per **Chrome restart** | A background process |
| `cdp` + ad-hoc shim (`npm run shim`) | one per shim start | — |
| `connectOverCDP("http://localhost:9222")` directly | one per `attach()` | This is the thing that annoys you |
| A clean `--user-data-dir` profile | 0 | No logins, no real state — explicit non-goal here |
| `RemoteDebuggingAllowed` policy | does not help | It is an on/off switch, there is no "always allow" |

The shim is a real **proxy**, not a convenience: it holds the single approved browser socket and multiplexes every automation client over it. `/json/version` and `/json/list` hand out WebSocket URLs that point at the shim itself (`ws://127.0.0.1:9333/...`), so clients never connect to Chrome directly. `/devtools/page/<targetId>` gets a flat `Target.attachToTarget` session on that same socket, with `sessionId` injected inbound and stripped outbound — transparent to the client.

```bash
npm run shim:service                              # launchd agent, KeepAlive + login autostart
node scripts/install-shim-service.mjs --uninstall
tail -f ~/.cache/browser-control/shim.log
```

Measured (throwaway-profile Chrome, three consecutive `attach()` calls): Chrome sees exactly **one** CDP connection on a stable port, and both Playwright connections land on the shim.

```
chrome side:  Google 89970 127.0.0.1:9224->127.0.0.1:53988
              node   90275 127.0.0.1:53988->127.0.0.1:9224     ← the shim, and nothing else
shim side:    node   90849 127.0.0.1:54006->127.0.0.1:9333     ← Playwright
              node   90849 127.0.0.1:54007->127.0.0.1:9333
```

Restarting the shim means a new connection, hence another click — which is exactly why it is meant to be resident. A Chrome restart is the same story: the shim reconnects by itself and says in its log that this one needs a click.

## Tab discipline (`TabGuard`)

The classic agent failure mode: open a tab per step, never close one, and half an hour later Chrome is carrying dozens of renderer processes — in **the browser you are personally using**. The answer is not a quota. A number is either too small for real work or too large to protect anything; the right number of tabs is however many are doing work *right now*. So `attach()` returns a guarded context that governs by reuse and pressure:

```js
const { browser, context, tabs } = await attach();   // tabs = TabGuard

for (let i = 0; i < 10; i += 1) await context.newPage();  // ten requested
console.log(tabs.report());                               // owned: 3, recycled: 7 — most requests reused a tab

await browser.close();   // hands back our tabs and the relay's, then disconnects
```

| Rule | Behaviour | Switch |
| --- | --- | --- |
| **Recycle first** | A tab we own that has gone quiet *is* the next tab: it gets blanked and handed back. Reuse is free; a new renderer costs the operator 40–80 MB | `BC_TAB_RECYCLE_MS` pins the window |
| **Windows are measured, not declared** | "Quiet" has no correct constant — a crawler touches a tab every 200 ms, a thinking agent every 30 s. The guard tracks the gap between operations (an EWMA that ignores long pauses) and states every decision in those beats: reusable after ~5, blanked after ~30, closed after ~120, each clamped to a sane floor and cap | `BC_TAB_RECYCLE_MS`, `BC_TAB_BLANK_MS`, `BC_TAB_IDLE_MS` |
| **It governs its own footprint, nothing else** | No system-memory probing: every platform reports free memory differently and other applications move the number under you. What this process knows exactly is which of *its* tabs are idle — and it hands those back | — |
| **Transport ceiling** | The one hard number, and not a style choice: the extension bridge drops the connection past 3 attached tabs. Pin your own with `BC_TAB_BUDGET` | `BC_MAX_TABS_EXTENSION`, `BC_TAB_BUDGET` |
| **Ownership** | Tabs that existed before `attach()` belong to the operator and are **never closed, navigated or counted**; `window.open` / `target=_blank` popups are adopted as ours | — |
| **Holds** | `TabPool` tabs call `hold()` and are immune to recycling, eviction and reaping | `BC_TAB_EVICT=0` to error instead of evicting |
| **Named surfaces** | `guard.surface("docs")` binds a name to a page: the same name always returns the same page, and a bound surface is never recycled or reaped. `guard.surface()` is the **scratch page** — one page shared by every unnamed call, so a run of unnamed work costs one tab, not one tab per step; it stays unheld, so it is still recycled, evicted and reaped like any unnamed tab. `guard.release(name)` turns a name back into an ordinary owned tab; `guard.surfaces()` lists `{ name, url, idleMs, blanked }` | — |
| **Background tabs** | On raw CDP a new tab is opened with `Target.createTarget { background: true }`, so it never becomes the tab you are looking at. The extension relay has no such option (`chrome.tabs.create` always activates), so there it degrades to an ordinary foreground tab and stops asking. `report().backgroundTabs` says which you are getting | — |
| **Nothing is left behind** | `browser.close()` returns our tabs *and* the relay's `connect.html`; a process that forgets reclaims on `beforeExit`/`SIGINT`/`SIGTERM` | `BC_KEEP_BRIDGE_TAB=1`, `BC_TAB_GUARD=0`, `attach({ guard: false })` |

The two questions are answered by different mechanisms and both stay true: the measured
cadence answers *"is this unnamed tab idle?"*, and a name answers *"is this page still
wanted?"*. When the transport ceiling is reached and **every** tab is a bound surface,
the least-recently-used surface is released and its tab reused — never an error, and
`report().surfacesEvicted` plus the tool output say so, because losing a named page has
to be visible.

The scratch page is deliberately *not* on the cadence: an agent that pauses to think for
30 s used to make every unnamed step open a fresh tab and evict the previous one, so the
operator watched tabs blink in and out. `report().scratch` is its URL, or `null` when
none is open.

Measured against the real browser: ten `newPage()` calls in a row produced **3 tabs created, 7 recycled, 0 evicted**, and the browser was back to its original tab count after `close()`; three consecutive full test runs leave the tab count exactly where it started. A dead end worth recording: an earlier version gated admission on free system memory, which is unmeasurable portably (macOS reported 1% free on a healthy 16 GB machine against 24% actually available) and wrong in principle — refusing a tab frees nothing, it only breaks the caller. Reuse and reclaiming do the work instead.

Two measured facts about the extension transport that shape all of this (2026-10-02): `context.pages()` lists **only the relay's own tab plus tabs opened during this connection** — the operator's existing tabs are not enumerable, so they are safe but also invisible to `cleanup.mjs`; and the relay opens a `connect.html` tab per `attach()` that nothing used to close. Tabs the extension cannot attach to at all (`chrome://`, the Web Store, other extensions' pages, `file://` without access) never appear either.

## Not taking the screen

`attach()` on the extension transport makes playwright-core **launch Chrome** with the
relay's `connect.html` URL, and Chrome raises itself over whatever the operator is doing
— even when it was already running, which is the annoying case.

That raise cannot be prevented, measured three ways on 2026-10-06 against an
already-running Chrome: spawning the binary with the URL (what playwright does),
`open -g -a "Google Chrome" <url>` (`-g` = do not foreground), and AppleScript
`make new tab`. All three put Chrome in front — it activates itself on an external URL.

So the screen is taken back instead, and early: the frontmost application is read before
connecting (`lsappinfo`), a watcher polls every 100 ms **during** the connect and
reactivates it (`open -b`) the moment Chrome grabs the screen, and `capabilities.focus`
reports what happened:

```json
{ "restored": true, "app": "com.microsoft.VSCode", "took": "com.google.Chrome", "bounces": 1 }
```

Measured with a 50 ms sampler around a real `attach()`: Chrome holds the screen for
**~100–150 ms**, not the ~600 ms the handshake takes. The screen is only ever taken back
from Chrome/Chromium — an operator who switches to another application themselves is
never yanked back (`not-the-browser (com.apple.Terminal)` in the report). macOS only; no
accessibility grant needed, and Windows has no equivalent short of a native
`SetForegroundWindow`. `BC_RESTORE_FOCUS=0` turns it off, `BC_FOCUS_WATCH_MS` (10 s)
bounds the watcher.

The cure, and it is measured: **`auto` + a resident shim + a resident MCP server**. On
`cdp` the whole class of interruption disappears — `attach()` opens no page, so nothing is
raised, and tabs are created in the background, so the tab you are reading stays the
active one. Verified end to end on 2026-10-06 against the operator's own logged-in
Chrome, driving the real MCP server over stdio (three unnamed navigations plus one named
page, twice in a row):

```text
mode: cdp | chose: "cdp"
guard: {"owned":2,"created":2,"evicted":0,"backgroundTabs":true,"operatorTabs":4}
front before/after: com.microsoft.VSCode / com.microsoft.VSCode
operator tab https://www.zhihu.com/ visibility before/after: visible / visible
```

On `extension` the residue is one ~150 ms flash per `attach()` plus a tab activation per
new tab (`chrome.tabs.create` has no background option), which is why the scratch page
matters there: the cure for "a tab appeared in front of me again" is opening fewer tabs,
not fighting the browser for them.

## MCP server

Agents keep wrapping this repo in ad-hoc MCP servers that drop connections and open tabs forever, so the server ships here instead. No SDK, no dependencies, ~350 lines of JSON-RPC over stdio.

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["/absolute/path/to/browser-control-kit/packages/mcp-server/bin/browser-control-mcp.mjs"],
      "env": { "BC_MODE": "cdp" }
    }
  }
}
```

| Property | How it is enforced |
| --- | --- |
| **No tab sprawl** | The agent has no word for "tab". It names a *surface* — `browser_navigate {url, as: "docs"}` keeps one, `{on: "docs"}` returns to it, omitting both uses the scratch surface — and the server owns the lifetime. There is no tool that opens or closes a tab, so an agent cannot leak one |
| **Stable connection** | One `attach()` per process, created lazily and re-created if the browser goes away; concurrent first calls share one in-flight attach; stdin EOF is the only shutdown path |
| **Clean stdout** | JSON-RPC only, logs go to stderr, writes respect backpressure — the usual cause of "the MCP server keeps disconnecting" |
| **Light** | `browser-control` and playwright are imported lazily on the first browser call: idle RSS measured at 40 MB, ~3 MB over a bare Node process |
| **Failures are results** | A failing tool returns `isError: true` with text, never a JSON-RPC error and never a crash |

Every rule that needs the agent's cooperation is a failure point, so the tab is removed
from its vocabulary instead of policed — the same move as the shim (one approved
connection, every client proxied over it) and recycle-first (the caller no longer
decides whether a tab is opened). What is left is intent: a name. At the transport
ceiling, when every tab is a bound surface, the least-recently-used one is released and
its tab reused, and the tool says which name was lost — reported, not refused.

Ten tools, one terse line each: `browser_status`, `browser_navigate` (`{url, as?, waitUntil?}`), `browser_click`, `browser_type`, `browser_fill`, `browser_text`, `browser_evaluate`, `browser_screenshot`, `browser_wait_for` (each taking an optional `on`), and `browser_surfaces` — which lists the named surfaces for humans and agents alike. An `on` naming a surface that does not exist is a tool error listing the names that do. See [`packages/mcp-server/README.md`](packages/mcp-server/README.md).

```bash
npm run mcp            # run it by hand
node --test packages/mcp-server/test/protocol.test.mjs   # 25 protocol cases, no browser needed
```

## Guards derived from crashes

On 2026-09-05, Chrome 152 + the Playwright Extension were crashed or made to quit **11 times**. Every constraint below is load-bearing, and `scripts/check.mjs` fails the commit if the guard disappears from the source.

| Symptom | Guard |
| --- | --- |
| `page.addInitScript()` over `chrome.debugger` kills the browser process (2/2 reproduced, `EXC_BREAKPOINT` on `CrBrowserMain`) | Refused on the extension transport; `BC_ALLOW_INIT_SCRIPT=1` to override. Pool tabs are marked after navigation with `evaluate` instead |
| **Concurrent navigation** across tabs crashes the browser | `controlPage` serialises navigation process-wide (`BC_PARALLEL_NAV=1` to opt out) |
| Churning tabs, or several pools accumulating attached tabs → the extension disconnects and Chrome may quit | **One pool per connection**; size ≤ `BC_MAX_TABS_EXTENSION` (3); create/close is serial with a 400 ms settle |
| Leaving the browser with no tabs takes the bridge down and Chrome exits | Closing stops while only one tab is left — counting **every** tab we can see, the relay's own included |
| Every `attach()` leaves the relay's `connect.html` tab behind (sixteen runs left sixteen tabs) | `browser.close()` closes it too, and the guard reclaims on `beforeExit`/`SIGINT`/`SIGTERM`; `BC_KEEP_BRIDGE_TAB=1` to keep it |
| **The extension accepts one client at a time**: two test files in parallel means one cannot connect and the other is interrupted | Suites run serially (`--test-concurrency=1`) |
| `setViewport` issues `Emulation.setDeviceMetricsOverride` and shrinks the operator's page | No-op unless `BC_VIEWPORT=1` |

## Footprint on your machine

Installing this must not scatter files around. It writes to **one directory**, plus the
plist launchd insists on owning:

| Path | What | Removed by `--uninstall` |
| --- | --- | --- |
| `~/Library/LaunchAgents/com.browser-control.shim.plist` | the launchd agent — only if you installed the service | yes |
| `~/.cache/browser-control/shim.log`, `shim.err.log` | the shim's own output, **truncated at 256 KiB** on every start, so a service running for months stays two small files | yes |
| `~/.cache/browser-control/` | the only directory this kit writes to | yes, when empty |
| `~/.config/browser-control/token` | **your** extension token, pasted by you: read, never written, never echoed | **no** — deleting a secret you pasted is not cleanup |
| `<node prefix>/bin/browser-control-mcp` + `lib/node_modules/browser-control-mcp` | symlinks, only if you ran `npm link` in `packages/mcp-server` | **no** — npm's: `npm rm -g browser-control-mcp` |

Nothing else: no state file, no database, no node_modules outside the repo, nothing in
the Chrome profile (permission probes are cleared immediately, `setViewport` is inert,
and tabs that existed before `attach()` are never touched). `BC_SHIM_LOG_DIR` moves the
directory, `BC_SHIM_LOG_MAX` the cap.

Measured on 2026-10-06, a whole agent session (attach → open a tab → navigate →
evaluate → close) against a timestamp and a sweep of `~/.cache`, `~/.config`, `~/.local`,
`~/Library/LaunchAgents`, `/tmp` and `/var/folders`: **51 bytes**, all of them appended to
`shim.log`. No temp directory, no profile copy, no browser download — `playwright-core`
is the only dependency and this kit never installs a browser.

```bash
node scripts/install-shim-service.mjs --status      # every path, its size, and what is ours
node scripts/install-shim-service.mjs --uninstall    # stop the agent and delete all of it
```

`--status` prints the list above with live sizes and marks each line `rm` or not; the two
commands read the same list in `scripts/install-shim-service.mjs`, so "what did you
install" and "remove it" cannot drift apart (pinned by `shim-service.test.mjs`).

## Local CI (git hooks, now plus GitHub Actions)

```bash
node scripts/install-hooks.mjs   # git config core.hooksPath .githooks
```

- `pre-commit` → `node scripts/check.mjs --offline`: `node --check` on every `.mjs`, no stray `console.debug` / `debugger;`, **the crash guards are still in the source**, licence metadata, and the 140 browserless cases
- `pre-push` → the same plus the real-browser suites; when Chrome is closed or the token is missing they are **skipped with a notice**, never blocking the push

`.github/workflows/ci.yml` runs the offline tier on Node 22 across **macOS and Windows** — the two platforms this kit supports, because it drives the desktop Chrome the operator is logged into. Linux is not a target; it runs there as a non-blocking reference signal only. The browser tier cannot run in CI at all — it needs the operator's Chrome and an extension token.

See [CONTRIBUTING.md](CONTRIBUTING.md) before sending a patch, and [AGENTS.md](AGENTS.md) for the full architecture notes.

## Licence

MIT — see [LICENSE](LICENSE).
