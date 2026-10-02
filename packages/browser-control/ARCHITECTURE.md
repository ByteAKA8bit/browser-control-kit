# browser-control — architecture

Design rationale for the package. Everything here is derived from the source; the
per-file `//` headers in `src/*.mjs` are the authoritative documentation.

## 1. Thesis: the operator's real browser

`attach()` connects to the browser the operator is *already* using — real profile, real
logins, real extensions, real state. Launching a throwaway `--user-data-dir` dev profile
is an explicit **non-goal** (`src/attach.mjs` header): a fresh profile has no session, no
extensions and no real-world state, so it proves nothing about the user's browser, and
every other automation tool already does it. Consequences run through the whole design:
the operator's tabs are untouchable, tab count is budgeted, capability probing must not
persist site settings, and `cleanup.mjs` exists to leave the browser as found.

## 2. Two transports, and what each one actually cannot do

Both run against the live browser. `DEFAULT_MODE` is `BC_MODE ?? "extension"`.

**`extension`** — Playwright Extension relay over `chrome.debugger`. No approval
dialog when `PLAYWRIGHT_MCP_EXTENSION_TOKEN` is set, and no
`--remote-debugging-port`, so it can start unattended. Measured limits:

- no browser-level CDP — `Target.attachToBrowserTarget` answers *"Not allowed"*,
- therefore no `Emulation.setFocusEmulationEnabled` (no focus emulation),
- therefore no `Browser.grantPermissions`,
- the attached tab reports `visibilityState=hidden` while in the background, which
  is why Playwright's own `click`/`fill` time out there.

**`cdp`** — `chromium.connectOverCDP()` against Chrome started with
`--remote-debugging-port`, through `src/cdp-shim.mjs` (Chrome 152 also disables
`/json/*` on the default profile). Full CDP power. The cost: Chrome asks the
operator to approve every new external debugging client and never remembers the
answer.

Capabilities are **feature-detected, not assumed** (`probeCapabilities` in
`src/attach.mjs`): `{ mode, rawCdp, focusEmulation, browserPermissions }`, probed by
opening a CDP session, trying `Emulation.setFocusEmulationEnabled`, and granting a
notification permission to a `.invalid` origin — which is cleared again immediately,
because a probe must not leave a site setting behind in the operator's profile.

## 3. `src/cdp-shim.mjs` — one approved connection

The approval dialog is per *connection* and is not persisted; until it is answered
`/json/*` returns 404 and the websocket handshake hangs. So the shim holds **one**
approved browser socket and proxies every client over it: the number of clicks
equals the number of shim **processes**, not runs. Handing out Chrome's own
websocket URL (the earlier design) meant a fresh dialog per attach.

- **Server**: `src/ws-server.mjs`, a hand-rolled RFC 6455 server — Node 22 ships a
  WebSocket *client* but no server, and the package keeps exactly one dependency.
  Scope: text frames, continuation frames, ping/pong, close; no permessage-deflate,
  no subprotocol negotiation, no client role. `MAX_MESSAGE` is 256 MiB because
  screenshots are big.
- **`/json/*` rebuilt**: `/json/version` from `Browser.getVersion`,
  `/json` ⁄ `/json/list` from `Target.getTargets` (filtered to `type === "page"`),
  `/json/new`, `/json/activate/<id>`, `/json/close/<id>` from the matching `Target.*`
  commands. Trailing slashes are normalised (`connectOverCDP` asks for
  `/json/version/`). Every advertised `webSocketDebuggerUrl` points at the **shim**,
  never at Chrome — a client dialling Chrome directly would pop a new dialog.
- **Tunnel**: a client connecting to `/devtools/page/<targetId>` gets its own flat
  session (`Target.attachToTarget {flatten:true}`); `sessionId` is stripped on the
  way out and injected on the way in, so the client believes it owns the connection.
  `/devtools/browser/*` clients get the browser endpoint.
- **Id rewriting**: client command ids are replaced with shim-global ids
  (`pending: shimId -> {client, id}`) and restored on the reply. Events with no
  session go to every browser-endpoint client; events whose `sessionId` belongs to a
  page client go only to that client; a reply nobody awaits is dropped.
- **Keep-alive**: one `Browser.getVersion` every `BC_SHIM_KEEPALIVE_MS` (30 s, `0`
  disables), only ever on an already-OPEN socket — reconnecting from a timer would pop
  the dialog with nobody waiting for it.
- **Disconnect hygiene**: upgraded sockets are half-open, so `socket.on("end")` closes a
  client that exited without a close frame. When the last browser-endpoint client leaves,
  `Target.setAutoAttach` is cleared: it is per-*connection* state shared by every client,
  and leaving it on made the next run see an empty browser (measured 2026-10-02: run 1
  saw 2 pages, run 2 saw 0).

`attach({mode:"cdp"})` probes the shim URL (`BC_CDP_URL`, default
`http://localhost:9333`) and reuses a listening one; an open port counts as "present"
even without an answer, because during the approval dialog the shim replies to
nothing and starting a second one could only fail to bind. Otherwise it spawns a
**detached** shim that outlives the run (logs in `~/.cache/browser-control/`).
`BC_SHIM_AUTOSTART=0` turns a missing shim back into an error.

## 4. Capability-adaptive input

`controlPage(page, capabilities)` (`src/page.mjs`) returns a `Proxy` over the
Playwright page: an override table in front, everything else passed through bound.
The surface is puppeteer-flavoured on purpose (multi-arg `evaluate`,
`waitForSelector({visible})`, `setViewport`, `evaluateOnNewDocument`), and multi-arg
`evaluate` is emulated by stringifying the function and rebuilding the call in-page,
because Playwright accepts exactly one argument.

Input path selection: `capabilities.focusEmulation === true` → real Playwright input;
otherwise → DOM-level input. `page.inputMode()` reports which (`real-input` /
`dom-input`).

The DOM primitives in `src/dom-input.mjs` and `src/transfer.mjs` are `UPPER_SNAKE`
consts that are **stringified and evaluated inside the page**, so they must be
self-contained — no imports, no closures; `deepSrc` (then `transferSrc`) is always
the last argument. They deliberately re-implement what the browser would otherwise
do for free:

- actionability: `zero-size`, `disabled`, `pointer-events-none`, `hidden`, `readonly`;
- a real `elementsFromPoint` hit test against the **topmost** element only, reported
  as `obscured-by:<TAG>.<class>` — checking the whole stack would happily "click"
  through an overlay;
- reach: open shadow roots are pierced by `DEEP_QUERY_ALL`; cross-document frames are
  handled by the caller, which retries the same op in every frame (`inAnyFrame`).
- uploads and drag & drop, normally `DOM.setFileInputFiles` and real mouse moves, are
  rebuilt from `DataTransfer`; `DOM_SET_FILES` mirrors the input's `accept`
  (`rejected-by-accept:<accept>`) and `DOM_DRAG` fires HTML5 drag events *and* pointer
  events, because dnd-kit/react-dnd listen to pointers.

Contract: every primitive returns `{ ok: true, ... }` or `{ ok: false, reason }` with
stable reason strings. `inAnyFrame` treats `not-found` as "try the next frame" and
surfaces any other reason; the override then throws a sentence naming the selector and
the reason. Degraded operations return instead of throwing, e.g. `evaluateOnNewDocument`
answers `{ skipped: true, reason: … }` on the extension transport.

## 5. Tab lifecycle

**`TabPool`** (`src/pool.mjs`) owns N tabs and hands them out, never running two tasks
on one tab (Playwright serialises per page, so sharing would queue silently). Failures
are isolated per task unless `stopOnError`. Ceilings: `MAX_TABS` = 4 (`BC_MAX_TABS`),
`MAX_TABS_EXTENSION` = 3 (`BC_MAX_TABS_EXTENSION`) — past ~3 attached tabs the relay
tears the connection down, and a browser left with no tabs of its own simply exits.
Tabs are marked in `sessionStorage.bcPoolTab` and reused across runs so repeated runs
do not accumulate tabs; reuse prefers marked tabs, falling back to any open http(s) tab
only with `BC_REUSE_ANY=1`. On extension, `start()` additionally refuses a second pool
per connection and refuses to run with no ordinary tab present.

**`TabGuard`** (`src/tab-guard.mjs`) exists for the agent failure mode: a tab per step,
never closed, forty renderers later in the browser the operator is personally using.
`attach()` returns a guarded context (`newPage()` routed through the guard,
`context.tabGuard` exposed) and a guarded browser whose `close()` hands the tabs back
first. Rules, each opt-outable and none silent (`BC_TAB_GUARD=0` disables the lot):

| Rule | Behaviour | Why |
| --- | --- | --- |
| Recycle first | `newPage()` hands back an owned tab that has gone quiet, blanked, before it opens one | reuse is free, a renderer is 40–80 MB |
| Measured windows | the gap between operations is tracked as an EWMA (`cadence`, long pauses ignored); reuse ≈ 5 beats, blank ≈ 30, close ≈ 120, each clamped; `BC_TAB_*_MS` pins any of them | "quiet" has no correct constant |
| Admission | refused only at the transport ceiling; under memory pressure the LRU idle tab is reclaimed first and, if everything is in use, the tab is granted while the windows run 4× faster | refusing frees nothing |
| Ownership | tabs present at `attach()` are `protectedPages`: never closed, counted or marked | the browser is the operator's |
| Adoption | `window.open` / `target=_blank` popups are adopted and re-trim the ceiling | uninvited tabs still cost RAM |
| Holds | `hold(page)` pins a tab; `TabPool` holds its tabs for the run | a working tab must not be reaped |
| Reclaiming | quiet past the blank window → `about:blank`; past the idle window → closed; timer every 30 s, `unref`'d | memory comes back before the tab does |
| Last tab | `#close` refuses when ≤ 1 tab remains, counting the relay's own | Chrome exits and takes the bridge with it |
| Nothing left behind | `browser.close()` also closes the relay's `connect.html`; `beforeExit`/`SIGINT`/`SIGTERM` reclaim | sixteen runs once left sixteen tabs |
| Serialised closes | one at a time with `BC_TAB_SETTLE_MS` (400 ms) | attach/detach churn crashed Chrome |

`report()` exposes budget, owned/operator counts and per-tab origin/held/idle. Known
blind spot: a tab the extension may not attach to (`chrome://`, Web Store, other
extensions, `file://` without access) never becomes a Playwright page, so the guard
cannot see it. `cleanup.mjs` finishes the job out of band: it closes only marked/scratch
tabs, one at a time with a settle delay, never the last tab in the browser, and clears
granted permissions. `--dry-run` reports only.

## 6. Crash-derived guards (2026-09-05, Chrome 152 + Playwright Extension, 11 crashes)

Each guard is load-bearing; `EXC_BREAKPOINT` / `SIGTRAP` on `CrBrowserMain` is an
internal Chrome `CHECK`, i.e. the browser process dies with the operator's windows.

| Guard | Where | Escape hatch |
| --- | --- | --- |
| No `addInitScript` on extension (marks tabs post-navigation instead) | `src/page.mjs`, `src/pool.mjs`, `src/tab-guard.mjs` | `BC_ALLOW_INIT_SCRIPT=1` |
| Navigation serialised process-wide (`serialiseNavigation`/`navChain`) | `src/page.mjs` | `BC_PARALLEL_NAV=1` |
| Tab creation on extension gated | `src/pool.mjs` | `BC_ALLOW_TAB_CREATE=1` |
| Extension tab ceiling `MAX_TABS_EXTENSION` | `src/pool.mjs` | `BC_MAX_TABS_EXTENSION` |
| Only ONE pool per extension connection | `src/pool.mjs` | use `BC_MODE=cdp` |
| Never leave the browser with no tabs (`alive.length <= 1`, counting the relay's tab) | `src/pool.mjs`, `src/tab-guard.mjs`, `cleanup.mjs` | none |
| Operator's tabs off limits (`protectedPages`) | `src/tab-guard.mjs` | none |

Only navigation is serialised — concurrent `evaluate`, clicks, screenshots and tab
create/close parallelise fine.

`scripts/check.mjs` **greps for these literals** (`BC_ALLOW_TAB_CREATE`,
`MAX_TABS_EXTENSION`, `only ONE pool per connection`, `serialiseNavigation`,
`BC_ALLOW_INIT_SCRIPT`, `protectedPages`, `ordinary.length <= 1`) and fails the
pre-commit run if any disappears. Renaming one without updating `scripts/check.mjs`
breaks the hook — that is the point.

## 7. Layout and dependency direction

```
packages/browser-control/
  index.mjs                  barrel (see package.json "exports": ., /fixtures, /pool,
                             /tab-guard, /shim)
  src/attach.mjs             transport choice, capability probe, shim autostart, guard wiring
  src/extension-transport.mjs  THE ONLY FILE THAT TOUCHES PLAYWRIGHT INTERNALS
  src/cdp-shim.mjs           one approved Chrome socket, proxied; /json/* rebuilt
  src/ws-server.mjs          hand-rolled RFC 6455 server (no dependency)
  src/page.mjs               capability-adaptive input, puppeteer-flavoured proxy
  src/dom-input.mjs          in-page actionability + hit test + shadow piercing
  src/transfer.mjs           in-page uploads and drag & drop via DataTransfer
  src/fixtures.mjs           zero-dependency xlsx/csv/png bytes for upload paths
  src/pool.mjs               TabPool + parallelMap, tab ceilings
  src/tab-guard.mjs          budget, LRU eviction, idle reaping, holds, ownership
  cleanup.mjs                close only what we left behind (--dry-run)
  selftest.mjs               end-to-end smoke; writes selftest.png, exit 1 on failure
  test/                      tab-guard 13 · ws-server 8 · shim-autostart 8 (browserless)
                             dom-input 16 · pool 8 (need Chrome)
```

Dependency direction is one-way: `tab-guard → pool → page → {dom-input, transfer,
fixtures}`, `attach → {extension-transport, tab-guard}`, `cdp-shim → ws-server`.
Nothing points back up.

All coupling to playwright-core internals lives in `src/extension-transport.mjs`: the
extension relay factory ships inside `lib/coreBundle.js` and is not in the package's
`exports` map, so it is reached through the bundle. That needs playwright-core >= 1.63
(1.62.1 has the code but does not export it); when a release moves it, only that file
breaks, and its exported signature (`connectViaExtension`, `extensionSupport`,
`loadToken`) is all the rest of the package depends on.

Module-level state is process-wide by design, not per connection: `navChain`
(`page.mjs`), `poolsStartedOnExtension` (`pool.mjs`), `socket`/`seq`/`pending`
(`cdp-shim.mjs`).
