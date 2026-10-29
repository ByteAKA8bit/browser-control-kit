# browser-control-mcp

An MCP stdio server that lets an agent drive **the Chrome the operator is already using** — without ever handing it a tab.

- **Pages have names, not handles.** `browser_navigate { url, as: "docs" }` keeps that page as `docs`; every later call takes `on: "docs"` to come back to it. Omit both and you get the scratch page — **one** page, shared by every unnamed call, so a stretch of unnamed work costs one tab rather than one per step.
- **You never manage tabs.** There is no tool that opens, closes or selects a tab, and no tab index anywhere in the surface. Tab lifetime belongs to `browser-control`'s `TabGuard`: a named page is pinned while it is named, the scratch page is reused, an idle one is blanked and then reclaimed, and a page the operator opened is never touched. An agent cannot leak a tab because it never holds one.
- **No quota, either.** The guard hands back a page this session has stopped using instead of opening another, and decides "stopped using" from the session's own measured rhythm rather than a constant. It does not probe system memory. The transport's ceiling (3 attached tabs on the extension bridge) is the only hard number; when it is reached and every page is named, the least-recently-used name is dropped and its page reused — reported as `surfacesEvicted` on the call that caused it, because losing a name must be visible.
- **Bounded memory, measured not asserted.** Idle, before any browser work, it is a bare Node process (~40 MB RSS): `browser-control` — and through it `playwright-core` — is imported lazily inside the first tool call that needs a browser. Attached and working it settles around 100 MB. A 600-call soak on 2026-10-06 (150 of them screenshots) measured RSS 133 → 150 → 149 → 103 → 114 MB and 97 MB after 20 s idle — a sawtooth, not a climb — while the shim went 70 → 64 MB and open file descriptors fell 25 → 22 (server) and 23 → 19 (shim). The guard held **one** tab for all 600 calls. Page wrappers live in a `WeakMap` keyed by the page, so a closed tab takes its proxy with it; no timers, no caches, no per-call state.
- **Zero dependencies of its own.** The JSON-RPC framing, the protocol loop and the tool table are three small modules, no SDK.
- **The agent owns the lifetime; the server does not guess.** MCP stdio hands this server a private stdin/stdout pair, so the pipes *are* its lifetime: when the client exits — including when it is killed outright, because the kernel closes its end — stdin ends, the browser session is handed back and the process leaves. A client can also outlive the work, so the agent decides: `browser_release` hands back the browser, its tabs and the relay page while keeping `state` and the job table; the next call attaches again. A long task may keep the browser attached indefinitely — there is no default idle timeout. An operator who wants a backstop can set `BC_MCP_IDLE_MS`; only then is a quiet browser released. No parent-process watching, and no process exit on idle — that would be a guess about the session, not about the browser. Spawn it with pipes, never `stdio: "inherit"` — a stdin shared with something else is never closed — and a server handed a terminal refuses to start and says why.

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

### Many agents, many projects

One MCP server per agent is the normal shape, so give each one a name: the extension titles
its Chrome tab group with `BC_CLIENT_NAME`, and the default is the directory the server was
started in. Two projects then read as `Playwright · shop` and `Playwright · docs` instead of
two identical `Playwright · browser-control-mcp` groups:

```json
{
  "mcpServers": {
    "browser-control-shop": {
      "command": "node",
      "args": ["/absolute/path/to/browser-control-kit/packages/mcp-server/bin/browser-control-mcp.mjs"],
      "env": { "BC_CLIENT_NAME": "shop", "BC_MODE": "cdp" }
    }
  }
}
```

For several agents at once, prefer the resident shim (`BC_MODE=cdp`, or leave `auto` with the
shim installed): every client is multiplexed over one approved connection, `attach()` opens
no page at all, and a new tab is created in the background instead of becoming the operator's
active tab. The extension transport still works concurrently — each connection gets its own
tab group — but it necessarily opens one `connect.html` page per attached agent; that page is
the anchor for the connection, so it cannot be closed while the agent is live. Each agent hands
its own back by calling `browser_release` when its work is done, and the next call opens a fresh
connection. An operator who wants a backstop can set `BC_MCP_IDLE_MS`; it is off by default, so a
long task is never cut short by a guess.

## The model, in one paragraph

Pages are addressed by name, never by handle. Pass `as` to `browser_navigate` to keep that page under a name, and `on` to come back to it from any later call; leave both out and you get the scratch page, the single page every unnamed call shares. Tabs need no closing — named pages are kept while you use them, the scratch page is reused, unnamed ones are reclaimed after a quiet spell — and `browser_surfaces` lists what is named right now. The browser itself stays attached until you call `browser_release`, so a long task can keep it as long as it needs; the next call after a release attaches again. A **task** has a durable home on disk: `browser_task` records the intent, the next step, a journal and `state`, and every named page keeps its last URL, so a server restart or a Chrome restart costs a reread and a navigation rather than a re-walk. The first `initialize` carries a compact resume note — intent, next step, saved pages, interrupted jobs — so a new agent is told where the work stopped before its first tool call. Jobs are the exception to resuming: one that was running when the process ended is reported interrupted, never restarted. The server sends this model, plus the `handBack()` shortcut for scripts, as `initialize.instructions`, which is why no tool description has to repeat it.

## Tools

Seventeen, and that is the whole surface.

An element is named three ways: a `ref` from `browser_snapshot` (`f0:3`), a CSS selector, or `text=Save`. A ref belongs to the frame it came from, is acted on by DOM dispatch (so the event is not trusted), and expires at the next snapshot or navigation. `text=` follows Playwright's rules: unquoted is a case-insensitive substring, `text="Save"` is exact.

| Tool | Arguments | Does |
| --- | --- | --- |
| `browser_status` | — | Report the transport, its capabilities, what the page guard is holding, the task, and recent console/uncaught page errors. When attach fails it adds `needs` (`approval`, `extension`, `install` or `unknown`) and a one-line hint for the operator. |
| `browser_task` | `intent?`, `next?`, `status?`, `note?`, `state?`, `journal?`, `reset?` | Read or update the durable task. With no arguments it reports the intent, the next step, `state`, the saved pages, the last-known jobs and the journal tail. |
| `browser_navigate` | `url`, `as?`, `on?`, `waitUntil?`, `dialog?` | Navigate; `as` keeps the page under a name, `on` reuses a named one. |
| `browser_snapshot` | `max?`, `on?` | List every visible actionable element with a ref, role, name, value, state, and an `href` for links. |
| `browser_click` | `selector` \| `ref`, `on?`, `dialog?` | Click an element by ref, CSS, or `text=…`. |
| `browser_type` | `selector` \| `ref`, `text`, `on?`, `dialog?` | Append text to a field. |
| `browser_fill` | `selector` \| `ref`, `value`, `on?`, `dialog?` | Replace a field's value; a `<select>` picks the option whose value or visible label matches. |
| `browser_upload` | `selector` \| `ref`, `files`, `on?`, `dialog?` | Attach files to a file input: paths this server can read, or inline `{name, text}` / `{name, base64}` when the bytes came from elsewhere. |
| `browser_download` | `url`, `path?`, `timeoutMs?`, `on?` | Fetch a URL with the page's cookies — the `href` a snapshot shows — and save the bytes (default `~/.cache/browser-control/downloads`); returns the path. Chrome's own download event is not exposed on the extension transport, so this is a fetch, not a click. |
| `browser_press` | `key`, `selector?` \| `ref?`, `on?`, `dialog?` | Press Enter/Escape/Tab/… on a target, or on the focused element. |
| `browser_text` | `selector?` \| `ref?`, `on?` | Read visible text of the page or one element. |
| `browser_evaluate` | `expression`, `on?`, `dialog?` | Evaluate a JavaScript expression in a page. |
| `browser_screenshot` | `selector?`, `on?` | Capture a PNG of the viewport or one element. |
| `browser_wait_for` | `selector`, `state?`, `timeoutMs?`, `on?` | Wait for a selector to reach a state. |
| `browser_surfaces` | — | List the named pages with their URL and idle time, the saved names this task can reopen, and the scratch page's URL. |
| `browser_release` | — | Hand the whole browser back when your work is done: this session's tabs and the relay page go, `state` and jobs stay, and the next call attaches again. Refused while a named job is running. |
| `browser_script` | `code`, `on?`, `as?`, `timeoutMs?` | **Run a whole flow in one call.** Async function body against this session: `page`, `surface(name)`, `release(name)`, `surfaces`, `handBack()`, `state`, `jobs`, `signal`, `log`, `guard`, `context`, `browser`, `capabilities`, `fixtures`, `controlPage`, `require`, `sleep`. Return JSON, or a Buffer for a PNG. |

A tool that fails — no browser, no such selector, a page that threw — answers with `isError: true` and a sentence saying why. Only a protocol mistake (unknown tool, missing or mistyped argument, or `as` and `on` in the same call, which would name two different pages) is a JSON-RPC error. An `on` that names a page this task has never seen is a tool error listing the names that do exist; a name that is only *saved* (not currently bound) is reopened at its last URL instead:

```text
browser_text failed: no page is named "a"; these are: b, c, d
```

A browser dialog is answered, never silently swallowed: the default is **dismiss** — a confirm that would delete or pay is not accepted on the agent's behalf — and the answer is appended to that call's result. When the action *should* proceed, the same acting call passes `dialog: "accept"`: `browser_click { selector: "#delete", dialog: "accept" }`. The listener exists only for that call.

## What it leaves on your machine

The task record is what this server writes on its own: `~/.cache/browser-control/tasks/<client>/task.json` plus `journal.ndjson` (a reset keeps the old one as `journal-<time>.ndjson`). It holds the intent, the next step, `state`, the saved page URLs and the last-known jobs, and nothing is read from the Chrome profile. `BC_TASK_DIR` moves it, `BC_TASK_ID` separates two agents that share a working directory, and `BC_MCP_TASK=0` turns it off — `state` then lives only as long as the process. `browser_download` saves into `~/.cache/browser-control/downloads` unless the call names a path; `BC_DOWNLOAD_DIR` moves that too.

If you installed the resident shim, its plist and two truncated logs live alongside. `node scripts/install-shim-service.mjs --status` lists the whole footprint with sizes and `--uninstall` removes the shim and its logs; the task directory, saved downloads and your `~/.config/browser-control/token` are named there but never deleted, because they are your work rather than an install artifact.

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

**A call that is over stops waiting.** The cap, and the client disconnecting, both abort the body's `signal` and make its `sleep()` throw — measured 2026-10-09, before that a body sleeping 3 s ran to completion 2.7 s after its 300 ms timeout had already answered the client, and kept the server process alive doing it. Check `signal.aborted` in your own loops; nothing can preempt a `while (true) {}` that ignores it, which is why shutdown also exits the process after `BC_MCP_EXIT_GRACE_MS`. Work that **must** outlive the call is a named job instead — `jobs.start('poll', async ({ signal, sleep, log }) => …)` returns at once and a later call reads `jobs.status('poll')` / `jobs.list()` / `jobs.wait('poll', 5000)` / `jobs.cancel('poll')`; jobs carry their own signal, and only the client leaving cancels them.

## Protocol

Newline-delimited JSON-RPC 2.0 on stdin/stdout; **stdout carries protocol bytes and nothing else** — logs go to stderr, and any other writer's stdout is rerouted there too. `initialize` echoes the client's `protocolVersion` when it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, offers `2025-06-18` otherwise, and carries the one-paragraph `instructions` above. `tools/list`, `tools/call` and `ping` are the whole surface: no resources, prompts or sampling. Closing stdin shuts the server down.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BC_CLIENT_NAME` | working directory | Name of this agent's Chrome tab group, so many projects stay distinguishable |
| `BC_MCP_IDLE_MS` | `0` (off) | Opt-in backstop: give the browser back after this long with no tool call and no running job. Off by default so a long task is never cut short; `browser_release` is the normal path |
| `BC_TAB_RECYCLE_MS` | measured | Pin the quiet period after which an unnamed page is reused rather than a new one opened |
| `BC_TAB_BLANK_MS` | measured | Pin the idle period after which an unnamed page is parked on `about:blank` |
| `BC_TAB_BUDGET` | transport ceiling | Pin an explicit page limit |
| `BC_TAB_GUARD` | `1` | `0` disables the guard — and with it named pages, which this server then refuses |
| `BC_RESTORE_FOCUS` | `1` | `0` leaves Chrome in front after attaching instead of giving the screen back (macOS) |
| `BC_SHIM_LOG_DIR` | `~/.cache/browser-control` | The one directory this kit writes to (logs only, truncated past `BC_SHIM_LOG_MAX`) |
| `BC_MCP_ATTACH_TIMEOUT_MS` | `60000` | Give up waiting for a browser |
| `BC_MCP_TEXT_LIMIT` | `20000` | Characters `browser_text` returns |
| `BC_MCP_WAIT_MS` | `20000` | Default `browser_wait_for` timeout |
| `BC_MCP_SCRIPT_MS` | `120000` | Default ceiling for a `browser_script` body; the cap aborts the body's `signal` |
| `BC_MCP_JOB_LOG` | `200` | Log lines a named job keeps |
| `BC_TASK_DIR` | `~/.cache/browser-control/tasks` | Where the durable task files live (under `BC_SHIM_LOG_DIR` when that is set) |
| `BC_TASK_ID` | the client name | Gives a task its own directory when two agents share a working directory |
| `BC_DOWNLOAD_DIR` | `~/.cache/browser-control/downloads` | Where `browser_download` saves a file when the call names no path |
| `BC_MCP_DOWNLOAD_MAX` | `67108864` | Largest response `browser_download` will carry into memory; bigger fails with the limit named |
| `BC_MCP_TASK` | `1` | `0` disables persistence: no task file, `state` lives only in memory, `browser_task` reports the switch |
| `BC_MCP_TASK_STATE_MAX` | `262144` | Largest `state` (bytes) that is written; a bigger one keeps the previous copy and says so |
| `BC_MCP_TASK_JOURNAL` | `500` | Journal lines kept; the oldest are dropped past this |
| `BC_MCP_EXIT_GRACE_MS` | `250` | After the client goes: exit even if a script body left a timer behind (`0` waits for it) |
| `BC_MCP_QUIET` | — | `1` silences stderr diagnostics |

Everything `browser-control` reads (`BC_MODE`, `BC_CDP_URL`, `BC_TAB_IDLE_MS`, …) applies unchanged.

## Test

```bash
node --test packages/mcp-server/test/task.test.mjs packages/mcp-server/test/protocol.test.mjs   # 71 cases, no browser needed
```

The suite speaks real stdio to the real binary: version negotiation, the version a client is told matching the manifest, the exact seventeen tools, no tool name or argument that could be a tab handle, the deleted tab tools answering "unknown tool", notifications answered with silence, two messages in one chunk, one message split across two, `-32601`/`-32700`/`-32602` (including `as` with `on`, an inherited property name, and a fractional integer), a browser tool degrading to `isError`, `browser_release` answering without attaching, stdout handed back when the transport stops, and every stdout line parsing as JSON. Three cases call `callTool` directly, where a page's own `{content:[…]}` must come back as data and an eviction notice must survive every tool. Two pin ordering: two calls on one page run in the order they arrived, while a call on another page does not wait behind them. Two pin dialogs: an unhandled confirm is dismissed and reported on that call's result, and `dialog:"accept"` installs the listener only for that call. Three cover the file tools: upload entries become `{name, buffer}` (paths, inline text and base64), a fetched attachment lands at the path the call named with its size and `Content-Disposition` filename, and a call without a URL is refused. Five pin script lifetime: a timed-out body and a disconnected one both stop sleeping instead of running on, a named job survives the call that started it and dies with the session, a body can hand the browser back at the end of its flow, and a server whose client is gone exits even while a timer the body created is still ticking. Eight pin the browser lifecycle: a default-off server never hands a quiet browser back, `browser_release` keeps `state` and reattaches, a running call and a running job both refuse it, and the opt-in timer never takes a browser out from under either.

Fourteen more pin the task file — state and journal across a restart, reset clearing the object a script holds, an interrupted job never restarting, an oversized or unreadable record keeping the last copy, saved pages surviving their tabs, and `BC_MCP_TASK=0` writing nothing — and the protocol suite adds the tool's round trip, a saved name reopening at its URL, a failed reopen leaving the name free for a retry, `browser_status` naming what the operator must do, and the resume note in `initialize`.

MIT — see [LICENSE](../../LICENSE).
