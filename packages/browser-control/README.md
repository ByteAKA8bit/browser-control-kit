**English** · [简体中文](../../README.zh-CN.md)

# browser-control

Drives **the Chrome the operator is already using** — the one opened by double-clicking it, with every login and extension intact.

- No launch flags, no `--user-data-dir`, no second instance, no "Allow" click on the default transport
- Works on a background tab: it does not steal focus or interrupt the operator
- Fully decoupled from the application under test: this package only knows how to drive a browser

> Spinning up a blank dev profile is an explicit **non-goal**: no session, no extensions, no real state — it proves nothing, and that approach already exists everywhere.

## Install

```bash
npm i          # playwright-core is the only dependency
```

Node >= 22 (`cdp-shim.mjs` relies on the global `WebSocket`). **Do not use Bun**: its WebSocket client cannot carry Playwright's CDP transport, so `connectOverCDP` hangs at `<ws connecting>` until it times out.

## Use

```js
import { attach, controlPage, blockUrls } from "browser-control";

const { browser, context, mode, capabilities } = await attach();   // extension transport by default
const page = controlPage(context.pages()[0] ?? (await context.newPage()), capabilities);

await blockUrls(page, /translate(-pa)?\.google(apis)?\.com/);      // keep translation from rewriting the UI
await page.goto("https://example.com/#/login", { waitUntil: "domcontentloaded" });
await page.fill("#user", "alice");
await page.click("button[type=submit]");
console.log(page.inputMode());                                     // "dom-input" | "real-input"
await browser.close();                                             // disconnects; your browser stays open
```

## Where the token lives (no environment variable needed)

The token is control over the whole browser — keep it out of shell history and CI logs. When `PLAYWRIGHT_MCP_EXTENSION_TOKEN` is unset, it is read **read-only** from `~/.config/browser-control/token` (this package never creates or writes that file; `BC_TOKEN_FILE` overrides the path):

```bash
mkdir -p ~/.config/browser-control
pbpaste > ~/.config/browser-control/token   # copied from the extension's status page
chmod 600 ~/.config/browser-control/token
```

## Trace (works on the extension transport too, measured)

`BC_TRACE=1` or `attach({ trace: true })` → the return value carries `saveTrace(file)`:

```bash
BC_TRACE=1 node runner.mjs            # → saveTrace("results/traces/08-upload.zip")
npx playwright show-trace results/traces/08-upload.zip
```

Measured output: 287 entries / 263 screencast frames / includes `trace.network`, about 7 MB for one suite — hence off by default.

## The two transports

| Transport | Prerequisites | Approval clicks | Capabilities | Use when |
| --- | --- | --- | --- | --- |
| `extension` (default) | [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) + `PLAYWRIGHT_MCP_EXTENSION_TOKEN` (shown on its status page) | **none** (the token replaces the dialog) | No raw CDP (measured: `Target.attachToBrowserTarget: Not allowed`), no `Browser.grantPermissions`, no focus emulation → DOM-level input covers it | **Default / unattended**: Chrome only has to be running |
| `cdp` | Chrome with `--remote-debugging-port=9222` + `node src/cdp-shim.mjs` | **one per shim lifetime** (the shim proxies all clients) | Full CDP: focus emulation, pre-granted permissions, download directory, URL interception | You need a CDP-level switch |

Switch with `BC_MODE=cdp` (or `attach({ mode: "cdp" })`); the shim address is `BC_CDP_URL`.

`cdp-shim.mjs` exists for two reasons, most painful first:

1. **The approval dialog.** Chrome asks the operator to approve every new external CDP connection to the default profile and never remembers; until approved, `/json/*` returns 404 and the WebSocket handshake hangs. The shim holds the single approved browser socket and **proxies** every client over it — `/json/version` and `/json/list` hand out shim addresses (`ws://127.0.0.1:9333/devtools/{browser,page}/...`), so clients never reach Chrome directly. `/devtools/page/<id>` opens a flat session on that same socket, with `sessionId` added inbound and stripped outbound.
2. **The discovery endpoints.** On that same Chrome, `/json/*` is all 404s, while puppeteer-flavoured clients handshake through `/json/version` — so those endpoints are rebuilt on top of `Target.*` (tolerating Playwright's trailing slash on `/json/version/`).

Make it resident: `node ../../scripts/install-shim-service.mjs` (launchd, KeepAlive + login autostart), log at `~/.cache/browser-control/shim.log`. Only a shim restart or a Chrome restart costs another click.

## Core design: capability-adaptive input

Playwright's `click`/`fill` run actionability checks (visible / enabled / stable) and dispatch real input events. A tab attached over the extension transport reports `document.visibilityState === "hidden"` and `hasFocus() === false` while in the background, so those checks are guaranteed to time out.

So `controlPage()` routes by the probed capabilities:

- `capabilities.focusEmulation === true` (cdp transport) → real input (`page.click` / `pressSequentially` / `keyboard`)
- otherwise → **DOM-level input**:
  - click: `scrollIntoView` plus the full `pointerdown → mousedown → focus → pointerup → mouseup → click` sequence (with correct clientX/Y)
  - text: the native `HTMLInputElement.prototype.value` setter plus `input`/`change` events (React / Ant Design controlled components accept nothing else)
  - keys: `keydown`/`keyup`, and `Enter` additionally triggers `form.requestSubmit()`

`attach()` returns `capabilities`: `{ mode, rawCdp, focusEmulation, browserPermissions }` — probed, not assumed.

## Upload / drag (supported on the DOM path too)

`setInputFiles` normally relies on `DOM.setFileInputFiles` (CDP) and `dragAndDrop` on a real mouse — a background tab has neither. Both are rebuilt out of plain Web APIs:

| API | Implementation | Notes |
| --- | --- | --- |
| `page.setInputFiles(sel, files)` | `File` → `DataTransfer` → `input.files` + `input`/`change` | Accepts a path / `Buffer` / `{name,buffer,type}`; **validates `accept` and `multiple`** and fails loudly otherwise (`rejected-by-accept:.xlsx,.xls` / `input-not-multiple`), so you never upload what the UI would refuse |
| `page.dropFiles(sel, files)` | `dragenter`→`dragover`→`drop` carrying a DataTransfer | For drop zones such as antd `Upload.Dragger` |
| `page.dragAndDrop(from, to)` | Pointer sequence (`pointerdown`→N×`pointermove`→`pointerup`, interpolated coordinates, dispatched at `elementFromPoint` each step) **plus** HTML5 `dragstart/dragover/drop/dragend` when the source is `draggable` | Covers both pointer-only implementations (dnd-kit, react-dnd, sortable.js) and native HTML5 drag |

With real input available (the `cdp` transport) the native Playwright APIs are used instead; the returned `via` field says which path ran.

## Fixture generation (`browser-control/fixtures`)

Upload tests need bytes, and asking the operator for sample files blocks the work — so real formats are generated in-process:

```js
import { makeXlsx, makeCsv, makePng, asUpload } from "browser-control/fixtures";
const xlsx = makeXlsx([["分類","分野","名称"], ["クラウド","IaaS","AWS"]]);  // real OOXML, zero dependencies
```

`makeXlsx` is a 50-line STORED-only ZIP writer plus the OOXML parts (with correct CRC32); the output is **verified readable by openpyxl**, Japanese text included. `makeCsv` carries a UTF-8 BOM, `makePng` is a 1×1 transparent image.

## API

| Export | Description |
| --- | --- |
| `attach({ mode, clientName, shimUrl, trace, guard })` | Connect to the running browser → `{ browser, context, mode, capabilities, tabs, saveTrace }`; `context` is under the tab budget by default, `tabs` is the `TabGuard`, and `browser.close()` hands our tabs back first |
| `controlPage(page, capabilities)` | A puppeteer-flavoured page: multi-arg `evaluate`/`$eval`/`$$eval`, `waitForSelector({visible})`, `setViewport`, `evaluateOnNewDocument`, `createCDPSession` (a no-op shim when CDP is absent), `inputMode()`, `capabilities()`; everything else passes through to the native Playwright `Page` |
| `blockUrls(page, pattern)` | `page.route` interception (translation services, analytics beacons…) |
| `page.setInputFiles / dropFiles / dragAndDrop` | See above; available on the DOM path too |
| `page.deepCount(selector)` | Match count across shadow roots and frames (diagnostics) |
| `page.viewportInfo()` | Read-only window size; `setViewport` is inert by default (your window is not ours to resize) |
| `TabGuard` / `guardContext(context, guard)` / `guardBrowser(browser, guard)` | The tab budget: `newPage()` evicts the LRU tab when over budget, adopts `window.open` popups, reaps idle tabs, `hold()` protects tabs in use, `report()` explains itself. `attach()` already wires this up; these exports are for manual use |
| `defaultBudget(mode)` | Budget default: `BC_TAB_BUDGET` wins, otherwise 3 on extension / 4 on cdp |
| `TabPool` / `parallelMap` (`browser-control/pool`) | Run work across several tabs; `map()` never rejects — failures come back as `{ ok: false, error, ms, tab }` |

`controlPage` mirrors puppeteer semantics for a practical reason: Playwright's `evaluate` takes exactly **one** argument, and a string argument is evaluated as an expression (so the function is never called) — measured across arrow / function / async string forms, all returning `undefined`. Multi-arg calls are rebuilt in-page with `new Function`.

## Tests

```bash
npm run test:offline   # tab-guard 42 + ws-server 17 + shim-autostart 11 + shim-policy 6 + shim-recovery 19 + shim-service 8 + shim-session 12 = 115 cases, no browser needed
npm test               # the same plus dom-input 16 and pool 8, --test-concurrency=1
npm run selftest       # end-to-end smoke, writes ./selftest.png
npm run cleanup        # closes only the tabs this tool left behind (--dry-run reports only)
```

`dom-input.test.mjs` covers refusal of obscured elements (`obscured-by:DIV`), disabled, zero-size, `pointer-events:none`, shadow piercing, iframe reach, `accept`/`multiple` validation, drop zones, pointer + HTML5 drag, and readonly. The browser suites need a running Chrome and an extension token; without them they are skipped, never failed.

## Licence

MIT — see [LICENSE](../../LICENSE).
