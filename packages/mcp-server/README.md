# browser-control-mcp

An MCP stdio server that lets an agent drive **the Chrome the operator is already using** — and that cannot grow it.

- **No tool opens a tab.** `browser_navigate` reuses the active tab; the only tab API is list / select / close.
- **Discipline without a quota.** `browser-control`'s `TabGuard` hands back a tab this session has stopped using instead of opening another, admits a new one only while the machine has memory headroom, blanks idle tabs before it closes them, and never counts or closes a tab that was open before the session started. The transport's own ceiling (3 on the extension bridge) is the only hard number; `BC_TAB_BUDGET` pins your own. `browser_status` prints the guard's report back, so the agent can see what it is costing.
- **Idle cost is a bare Node process** (~40 MB RSS measured): `browser-control` — and through it `playwright-core` — is imported lazily inside the first tool call that needs a browser. No timers, no caches.
- **Zero dependencies of its own.** The JSON-RPC framing, the protocol loop and the tool table are three small modules, no SDK.

## Run

```bash
npm run mcp                      # from the repo root
BC_MODE=cdp npm run mcp          # CDP transport via the shim instead of the extension
```

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

The extension transport needs the token (see [`browser-control`](../browser-control/README.md#where-the-token-lives-no-environment-variable-needed)); `BC_MODE=cdp` needs the shim, which `attach()` starts for you.

## Tools

| Tool | Does |
| --- | --- |
| `browser_status` | Report transport, capabilities and tab budget usage. |
| `browser_navigate` | Navigate the active tab to a URL. |
| `browser_click` | Click the first element matching a selector. |
| `browser_type` | Append text to a field. |
| `browser_fill` | Replace a field's value. |
| `browser_text` | Read visible text of the page or one element. |
| `browser_evaluate` | Evaluate a JavaScript expression in the active tab. |
| `browser_screenshot` | Capture a PNG of the viewport or one element. |
| `browser_tabs` | List open tabs with their index. |
| `browser_tab_select` | Make an existing tab the active one. |
| `browser_tab_close` | Close a tab by index. |
| `browser_wait_for` | Wait for a selector to reach a state. |

A tool that fails — no browser, no such selector, a page that threw — answers with `isError: true` and a sentence saying why. Only a protocol mistake (unknown tool, missing or mistyped argument) is a JSON-RPC error.

`browser_tab_close` refuses to close a tab that predates the session (it is the operator's) and refuses to close the last ordinary tab (Chrome would exit and take the connection with it).

## Protocol

Newline-delimited JSON-RPC 2.0 on stdin/stdout; **stdout carries protocol bytes and nothing else** — logs go to stderr, and any other writer's stdout is rerouted there too. `initialize` echoes the client's `protocolVersion` when it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, and offers `2025-06-18` otherwise. `tools/list`, `tools/call` and `ping` are the whole surface: no resources, prompts or sampling. Closing stdin shuts the server down.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BC_TAB_RECYCLE_MS` | measured | Pin the quiet period after which a tab is reused rather than a new one opened |
| `BC_TAB_BLANK_MS` | measured | Pin the idle period after which a tab is parked on `about:blank` |
| `BC_TAB_BUDGET` | transport ceiling | Pin an explicit tab limit |
| `BC_MCP_ATTACH_TIMEOUT_MS` | `60000` | Give up waiting for a browser |
| `BC_MCP_TEXT_LIMIT` | `20000` | Characters `browser_text` returns |
| `BC_MCP_WAIT_MS` | `20000` | Default `browser_wait_for` timeout |
| `BC_MCP_QUIET` | — | `1` silences stderr diagnostics |

Everything `browser-control` reads (`BC_MODE`, `BC_CDP_URL`, `BC_TAB_IDLE_MS`, …) applies unchanged.

## Test

```bash
node --test packages/mcp-server/test/protocol.test.mjs   # 12 cases, no browser needed
```

The suite speaks real stdio to the real binary: version negotiation, notifications answered with silence, two messages in one chunk, one message split across two, `-32601`/`-32700`/`-32602`, a browser tool degrading to `isError`, and every stdout line parsing as JSON.

MIT — see [LICENSE](../../LICENSE).
