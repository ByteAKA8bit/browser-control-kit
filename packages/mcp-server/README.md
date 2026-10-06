# browser-control-mcp

An MCP stdio server that lets an agent drive **the Chrome the operator is already using** — without ever handing it a tab.

- **Pages have names, not handles.** `browser_navigate { url, as: "docs" }` keeps that page as `docs`; every later call takes `on: "docs"` to come back to it. Omit both and you get the scratch page — **one** page, shared by every unnamed call, so a stretch of unnamed work costs one tab rather than one per step.
- **You never close anything.** There is no tool that opens or closes a tab, and no tab index anywhere in the surface. Lifetime belongs to `browser-control`'s `TabGuard`: a named page is pinned while it is named, the scratch page is reused, an idle one is blanked and then reclaimed, and a page the operator opened is never touched. An agent cannot leak a tab because it never holds one.
- **No quota, either.** The guard hands back a page this session has stopped using instead of opening another, and decides "stopped using" from the session's own measured rhythm rather than a constant. It does not probe system memory. The transport's ceiling (3 attached tabs on the extension bridge) is the only hard number; when it is reached and every page is named, the least-recently-used name is dropped and its page reused — reported as `surfacesEvicted` on the call that caused it, because losing a name must be visible.
- **Bounded memory, measured not asserted.** Idle, before any browser work, it is a bare Node process (~40 MB RSS): `browser-control` — and through it `playwright-core` — is imported lazily inside the first tool call that needs a browser. Attached and working it settles around 100 MB. A 600-call soak on 2026-10-06 (150 of them screenshots) measured RSS 133 → 150 → 149 → 103 → 114 MB and 97 MB after 20 s idle — a sawtooth, not a climb — while the shim went 70 → 64 MB and open file descriptors fell 25 → 22 (server) and 23 → 19 (shim). The guard held **one** tab for all 600 calls. Page wrappers live in a `WeakMap` keyed by the page, so a closed tab takes its proxy with it; no timers, no caches, no per-call state.
- **Zero dependencies of its own.** The JSON-RPC framing, the protocol loop and the tool table are three small modules, no SDK.
- **The client owns the lifetime.** MCP stdio hands this server a private stdin/stdout pair, so the pipes *are* its lifetime: when the client exits — including when it is killed outright, because the kernel closes its end — stdin ends, the browser session is handed back and the process leaves. There is no idle timeout and no parent-process watching: both would be guesses, and the second one would kill sessions that are started behind a launcher. Spawn it with pipes, never `stdio: "inherit"` — a stdin shared with something else is never closed — and a server handed a terminal refuses to start and says why.

## Run

```bash
npm run mcp                      # from the repo root; transport is auto
BC_MODE=cdp npm run mcp          # pin the CDP transport

cd packages/mcp-server && npm link   # global `browser-control-mcp` command
npm rm -g browser-control-mcp         # and how to take it back
```

`npm link` is symlinks, not copies: the global command runs this repo, so a `git pull` is the upgrade. `npm i -g` cannot work here — the `browser-control` dependency is a workspace package, not a registry one. The link is scoped to the Node version that created it (nvm users: relink after switching).

Client configuration (Claude Code, Claude Desktop, any MCP host):

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["/absolute/path/to/browser-control-kit/packages/mcp-server/bin/browser-control-mcp.mjs"]
    }
  }
}
```

No `BC_MODE`: the default is `auto`, which takes the CDP transport when a shim is already
answering and the extension otherwise. Leave it that way.

### The setup that does not interrupt you

One resident MCP server plus one resident shim, and the agent never takes your screen or
your active tab:

```bash
CHROME_PORT=9222 npm run shim:service   # launchd agent; one "Allow" per Chrome restart
```

Why it matters, measured on 2026-10-06 against a logged-in Chrome over this very server
(three unnamed navigations plus one named page): `mode: cdp`, 2 tabs for 4 navigations, 0
evictions, the frontmost application unchanged, and the operator's own tab still
`visible` afterwards. On the extension transport the same run costs a ~150 ms screen
flash per `attach()` (connecting launches Chrome, which raises itself) and one tab
activation per new tab — which is why one **resident** server matters there too: the
flash is per `attach()`, and a resident server attaches once per session.

The extension transport needs the token (see [`browser-control`](../browser-control/README.md#where-the-token-lives-no-environment-variable-needed)); the CDP transport needs the shim, and `auto` will not start one for you — that is the step that can pop Chrome's approval dialog.

## The model, in one paragraph

Pages are addressed by name, never by handle. Pass `as` to `browser_navigate` to keep that page under a name, and `on` to come back to it from any later call; leave both out and you get the scratch page, the single page every unnamed call shares. Nothing needs closing — named pages are kept while you use them, the scratch page is reused, idle ones are reclaimed — and `browser_surfaces` lists what is named right now. The server sends exactly this paragraph as `initialize.instructions`, which is why no tool description has to repeat it.

## Tools

Ten, and that is the whole surface.

| Tool | Arguments | Does |
| --- | --- | --- |
| `browser_status` | — | Report the transport, its capabilities and what the page guard is holding. |
| `browser_navigate` | `url`, `as?`, `on?`, `waitUntil?` | Navigate; `as` keeps the page under a name, `on` reuses a named one. |
| `browser_click` | `selector`, `on?` | Click the first element matching a selector. |
| `browser_type` | `selector`, `text`, `on?` | Append text to a field. |
| `browser_fill` | `selector`, `value`, `on?` | Replace a field's value. |
| `browser_text` | `selector?`, `on?` | Read visible text of the page or one element. |
| `browser_evaluate` | `expression`, `on?` | Evaluate a JavaScript expression in a page. |
| `browser_screenshot` | `selector?`, `on?` | Capture a PNG of the viewport or one element. |
| `browser_wait_for` | `selector`, `state?`, `timeoutMs?`, `on?` | Wait for a selector to reach a state. |
| `browser_surfaces` | — | List the named pages with their URL and idle time, plus the scratch page's URL. |
| `browser_script` | `code`, `on?`, `as?`, `timeoutMs?` | **Run a whole flow in one call.** Async function body against this session: `page`, `surface(name)`, `release`, `surfaces`, `state`, `log`, `guard`, `context`, `browser`, `capabilities`, `fixtures`, `controlPage`, `require`, `sleep`. Return JSON, or a Buffer for a PNG. |

A tool that fails — no browser, no such selector, a page that threw — answers with `isError: true` and a sentence saying why. Only a protocol mistake (unknown tool, missing or mistyped argument, or `as` and `on` in the same call, which would name two different pages) is a JSON-RPC error. An `on` that names a page you never kept is a tool error listing the names that do exist:

```text
browser_text failed: no page is named "a"; these are: b, c, d
```

## What it leaves on your machine

This server itself writes nothing. The only files exist if you installed the resident shim: `~/Library/LaunchAgents/com.browser-control.shim.plist` and two truncated logs in `~/.cache/browser-control/`. `node scripts/install-shim-service.mjs --status` lists them with sizes, `--uninstall` removes all of them; your `~/.config/browser-control/token` is read and never touched. Nothing is written into the Chrome profile.

## Why `browser_script` exists

A tool call is cheap; an agent **turn** is not. Measured 2026-10-06: forty browser actions cost 878 ms as forty tool calls and 642 ms inside one script — 22 ms versus 16 ms per action, i.e. ~6 ms of JSON-RPC — but **41 agent turns against 1**, and the turns are the real bill (tokens, inference, latency). So the batch runs inside the attached session:

```js
// browser_script { "as": "flow", "code": "…" }
await page.goto("https://example.com/");
log("navigated to", page.url());
const rows = await page.$$eval("a", (a) => a.map((x) => x.href));
state.rows = rows;                    // survives into the next call
return { count: rows.length, rows };
```

It is deliberately **not** a sandbox: the body gets the real page, the real guard, `require` and `import()`. An agent that can call this can already run bash, so fencing it would cost upload/download/file flows and buy nothing. What it adds over a bash script is the session: no second `attach()` (~723 ms on cdp), named pages still bound, and `state` carried between calls. A returned Buffer comes back as a PNG image block; `log()` and `console.log` ride along with the result; the body is capped by `timeoutMs` (default `BC_MCP_SCRIPT_MS`, 120 s).

## Protocol

Newline-delimited JSON-RPC 2.0 on stdin/stdout; **stdout carries protocol bytes and nothing else** — logs go to stderr, and any other writer's stdout is rerouted there too. `initialize` echoes the client's `protocolVersion` when it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, offers `2025-06-18` otherwise, and carries the one-paragraph `instructions` above. `tools/list`, `tools/call` and `ping` are the whole surface: no resources, prompts or sampling. Closing stdin shuts the server down.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BC_TAB_RECYCLE_MS` | measured | Pin the quiet period after which an unnamed page is reused rather than a new one opened |
| `BC_TAB_BLANK_MS` | measured | Pin the idle period after which an unnamed page is parked on `about:blank` |
| `BC_TAB_BUDGET` | transport ceiling | Pin an explicit page limit |
| `BC_TAB_GUARD` | `1` | `0` disables the guard — and with it named pages, which this server then refuses |
| `BC_RESTORE_FOCUS` | `1` | `0` leaves Chrome in front after attaching instead of giving the screen back (macOS) |
| `BC_SHIM_LOG_DIR` | `~/.cache/browser-control` | The one directory this kit writes to (logs only, truncated past `BC_SHIM_LOG_MAX`) |
| `BC_MCP_ATTACH_TIMEOUT_MS` | `60000` | Give up waiting for a browser |
| `BC_MCP_TEXT_LIMIT` | `20000` | Characters `browser_text` returns |
| `BC_MCP_WAIT_MS` | `20000` | Default `browser_wait_for` timeout |
| `BC_MCP_QUIET` | — | `1` silences stderr diagnostics |

Everything `browser-control` reads (`BC_MODE`, `BC_CDP_URL`, `BC_TAB_IDLE_MS`, …) applies unchanged.

## Test

```bash
node --test packages/mcp-server/test/protocol.test.mjs   # 28 cases, no browser needed
```

The suite speaks real stdio to the real binary: version negotiation, the version a client is told matching the manifest, the exact eleven tools, no tool name or argument that could be a tab handle, the deleted tab tools answering "unknown tool", notifications answered with silence, two messages in one chunk, one message split across two, `-32601`/`-32700`/`-32602` (including `as` with `on`, an inherited property name, and a fractional integer), a browser tool degrading to `isError`, stdout handed back when the transport stops, and every stdout line parsing as JSON. Three cases call `callTool` directly, where a page's own `{content:[…]}` must come back as data and an eviction notice must survive every tool.

MIT — see [LICENSE](../../LICENSE).
