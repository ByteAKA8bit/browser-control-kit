# browser-control-mcp

An MCP stdio server that lets an agent drive **the Chrome the operator is already using** — without ever handing it a tab.

- **Pages have names, not handles.** `browser_navigate { url, as: "docs" }` keeps that page as `docs`; every later call takes `on: "docs"` to come back to it. Omit both and you get the scratch page, which the next unnamed navigation reuses.
- **You never close anything.** There is no tool that opens or closes a tab, and no tab index anywhere in the surface. Lifetime belongs to `browser-control`'s `TabGuard`: a named page is pinned while it is named, an unnamed one is recycled, an idle one is blanked and then reclaimed, and a page the operator opened is never touched. An agent cannot leak a tab because it never holds one.
- **No quota, either.** The guard hands back a page this session has stopped using instead of opening another, and decides "stopped using" from the session's own measured rhythm rather than a constant. It does not probe system memory. The transport's ceiling (3 attached tabs on the extension bridge) is the only hard number; when it is reached and every page is named, the least-recently-used name is dropped and its page reused — reported as `surfacesEvicted` on the call that caused it, because losing a name must be visible.
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

## The model, in one paragraph

Pages are addressed by name, never by handle. Pass `as` to `browser_navigate` to keep that page under a name, and `on` to come back to it from any later call; leave both out and you get the scratch page, which the next unnamed navigation reuses. Nothing needs closing — named pages are kept while you use them, unnamed ones are recycled, idle ones are reclaimed — and `browser_surfaces` lists what is named right now. The server sends exactly this paragraph as `initialize.instructions`, which is why no tool description has to repeat it.

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
| `browser_surfaces` | — | List the named pages with their URL and idle time. |

A tool that fails — no browser, no such selector, a page that threw — answers with `isError: true` and a sentence saying why. Only a protocol mistake (unknown tool, missing or mistyped argument) is a JSON-RPC error. An `on` that names a page you never kept is a tool error listing the names that do exist:

```text
browser_text failed: no page is named "a"; these are: b, c, d
```

## Protocol

Newline-delimited JSON-RPC 2.0 on stdin/stdout; **stdout carries protocol bytes and nothing else** — logs go to stderr, and any other writer's stdout is rerouted there too. `initialize` echoes the client's `protocolVersion` when it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, offers `2025-06-18` otherwise, and carries the one-paragraph `instructions` above. `tools/list`, `tools/call` and `ping` are the whole surface: no resources, prompts or sampling. Closing stdin shuts the server down.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `BC_TAB_RECYCLE_MS` | measured | Pin the quiet period after which an unnamed page is reused rather than a new one opened |
| `BC_TAB_BLANK_MS` | measured | Pin the idle period after which an unnamed page is parked on `about:blank` |
| `BC_TAB_BUDGET` | transport ceiling | Pin an explicit page limit |
| `BC_TAB_GUARD` | `1` | `0` disables the guard — and with it named pages, which this server then refuses |
| `BC_MCP_ATTACH_TIMEOUT_MS` | `60000` | Give up waiting for a browser |
| `BC_MCP_TEXT_LIMIT` | `20000` | Characters `browser_text` returns |
| `BC_MCP_WAIT_MS` | `20000` | Default `browser_wait_for` timeout |
| `BC_MCP_QUIET` | — | `1` silences stderr diagnostics |

Everything `browser-control` reads (`BC_MODE`, `BC_CDP_URL`, `BC_TAB_IDLE_MS`, …) applies unchanged.

## Test

```bash
node --test packages/mcp-server/test/protocol.test.mjs   # 16 cases, no browser needed
```

The suite speaks real stdio to the real binary: version negotiation, non-empty `initialize.instructions`, the exact ten tools, no tool name or argument that could be a tab handle, the deleted tab tools answering "unknown tool", notifications answered with silence, two messages in one chunk, one message split across two, `-32601`/`-32700`/`-32602`, a browser tool degrading to `isError`, and every stdout line parsing as JSON.

MIT — see [LICENSE](../../LICENSE).
