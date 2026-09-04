# browser-control

驱动**操作者自己正在用的那个 Chrome**——正常双击打开的、带全部登录态和扩展的浏览器。

- **不加启动参数**、**不挂 user-data-dir**、**不起新实例**、**不用点"允许"**
- 后台标签也能操作（不抢焦点、不打断你）
- 与被测应用完全解耦：这个包只管"怎么控制浏览器"，业务用例在别处

> 起一个空白 dev profile 的方案本包**明确不做**：没有真实会话、没有扩展、没有真实状态，证明不了任何东西，而且这种方案满地都是。

## 装

```bash
npm i          # 只有 playwright-core 一个依赖
```

Node ≥ 22（`cdp-shim.mjs` 用到默认开启的全局 `WebSocket`）。**不要用 Bun**：Bun 的 WebSocket 客户端无法承载 Playwright 的 CDP 传输，`connectOverCDP` 会卡在 `<ws connecting>` 直到超时。

## 用

```js
import { attach, controlPage, blockUrls } from "browser-control";

const { browser, context, mode, capabilities } = await attach();   // 默认 extension 通道
const page = controlPage(context.pages()[0] ?? (await context.newPage()), capabilities);

await blockUrls(page, /translate(-pa)?\.google(apis)?\.com/);      // 别让翻译改写 UI
await page.goto("https://example.com/#/login", { waitUntil: "domcontentloaded" });
await page.fill("#user", "alice");
await page.click("button[type=submit]");
console.log(page.inputMode());                                     // "dom-input" | "real-input"
await browser.close();                                             // 只断开，不关你的浏览器
```

## Token 存放（不必放环境变量）

Token 等于整个浏览器的控制权，别留在 shell history / CI 日志里。未设 `PLAYWRIGHT_MCP_EXTENSION_TOKEN` 时，会**只读**地取 `~/.config/browser-control/token`（本包从不创建/写入该文件；路径可用 `BC_TOKEN_FILE` 覆盖）：

```bash
mkdir -p ~/.config/browser-control
pbpaste > ~/.config/browser-control/token   # 扩展 status 页复制的 token
chmod 600 ~/.config/browser-control/token
```

## Trace（实测扩展通道也支持）

`BC_TRACE=1` 或 `attach({ trace: true })` → 返回值带 `saveTrace(file)`：

```bash
TF_TRACE=1 node runner.mjs 08-upload    # → results/traces/08-upload.zip
npx playwright show-trace results/traces/08-upload.zip
```

实测产物：287 个条目 / 263 帧 screencast / 含 `trace.network`，约 7 MB 一个套件 —— 所以默认关闭，按需开。

## 两种通道

| 通道 | 前置条件 | 要点"允许"吗 | 能力 | 适用 |
| --- | --- | --- | --- | --- |
| `extension`（默认） | 装 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) + `PLAYWRIGHT_MCP_EXTENSION_TOKEN`（扩展 status 页显示） | **不用**（token 免弹窗） | 无原始 CDP（实测 `Target.attachToBrowserTarget: Not allowed`）、无 `Browser.grantPermissions`、无焦点模拟 → 由 DOM 级输入兜住 | **默认/无人值守**：Chrome 正常启动即可 |
| `cdp` | Chrome 带 `--remote-debugging-port=9222` + `node src/cdp-shim.mjs` | 每个新连接要点一次 | 完整 CDP：焦点模拟、权限预授权、下载目录、URL 拦截 | 需要 CDP 级开关时 |

切换：`BC_MODE=cdp`（或 `attach({ mode: "cdp" })`）；shim 地址 `BC_CDP_URL`。

`cdp-shim.mjs` 存在的原因：Chrome 152 在默认 profile 下只保留 DevTools WebSocket，`/json/*` 全 404，而 Playwright/puppeteer 必须靠 `/json/version` 握手；shim 持有**一条**长连接把这些端点重建出来（并容忍 Playwright 请求的 `/json/version/` 尾斜杠）。

## 核心设计：能力自适应输入

Playwright 的 `click`/`fill` 会做 actionability 检查（visible / enabled / stable）并派发真实输入事件。扩展通道附着的标签在后台时 `document.visibilityState === "hidden"`、`hasFocus() === false`，这些检查必然超时。

于是 `controlPage()` 按探测到的能力选路：

- `capabilities.focusEmulation === true`（cdp 通道）→ 真实输入（`page.click` / `pressSequentially` / `keyboard`）
- 否则 → **DOM 级输入**：
  - 点击：`scrollIntoView` + 完整 `pointerdown → mousedown → focus → pointerup → mouseup → click` 序列（带正确的 clientX/Y）
  - 文本：`HTMLInputElement.prototype.value` 的原生 setter + `input`/`change` 事件（React / Ant Design 受控组件只认这一套）
  - 按键：`keydown`/`keyup`，`Enter` 额外触发 `form.requestSubmit()`

`attach()` 返回的 `capabilities`：`{ mode, rawCdp, focusEmulation, browserPermissions }`——探测得来，不靠假设。

## 上传 / 拖拽（DOM 路径也支持）

`setInputFiles` 通常靠 `DOM.setFileInputFiles`（CDP），`dragAndDrop` 靠真实鼠标——后台标签两者都没有。于是用纯 Web API 重建：

| API | 实现 | 说明 |
| --- | --- | --- |
| `page.setInputFiles(sel, files)` | `File` → `DataTransfer` → `input.files` + `input`/`change` | 接受路径 / `Buffer` / `{name,buffer,type}`；**校验 `accept` 与 `multiple`**，不合规直接失败（`rejected-by-accept:.xlsx,.xls` / `input-not-multiple`），避免上传 UI 本来不允许的东西 |
| `page.dropFiles(sel, files)` | `dragenter`→`dragover`→`drop` 带 DataTransfer | antd `Upload.Dragger` 这类拖拽区 |
| `page.dragAndDrop(from, to)` | 指针序列（`pointerdown`→N×`pointermove`→`pointerup`，坐标插值、每步对 `elementFromPoint` 派发）**＋** 源元素 `draggable` 时补发 HTML5 `dragstart/dragover/drop/dragend` | 覆盖 dnd-kit / react-dnd / sortable.js（只听指针）与 HTML5 原生拖拽两类实现 |

有真实输入能力（`cdp` 通道）时自动改用 Playwright 原生 API，返回值里的 `via` 字段标明走了哪条路。

## 测试用夹具生成（`browser-control/fixtures`）

上传测试要字节，向操作者索要样例文件会阻塞工作，所以自己生成真格式：

```js
import { makeXlsx, makeCsv, makePng, asUpload } from "browser-control/fixtures";
const xlsx = makeXlsx([["分類","分野","名称"], ["クラウド","IaaS","AWS"]]);  // 真 OOXML，零依赖
```

`makeXlsx` 是一个 50 行的 STORED-only ZIP writer + OOXML 部件（含正确 CRC32）；产物用 **openpyxl 实测可读**（含日文）。`makeCsv` 带 UTF-8 BOM，`makePng` 是 1×1 透明图。


## API

| 导出 | 说明 |
| --- | --- |
| `attach({ mode, clientName, shimUrl })` | 连上正在运行的浏览器 → `{ browser, context, mode, capabilities }` |
| `controlPage(page, capabilities)` | 包出一个 puppeteer 风味的 page：多参 `evaluate`/`$eval`/`$$eval`、`waitForSelector({visible})`、`setViewport`、`evaluateOnNewDocument`、`createCDPSession`（无 CDP 时退化为空实现）、`inputMode()`、`capabilities()`；其余属性透传原生 Playwright Page |
| `blockUrls(page, pattern)` | `page.route` 拦截（翻译服务、埋点等） |
| `page.setInputFiles / dropFiles / dragAndDrop` | 见上节；DOM 路径下同样可用 |
| `page.deepCount(selector)` | 跨 shadow root 与 frame 的匹配计数（诊断用） |
| `page.viewportInfo()` | 只读窗口尺寸；`setViewport` 默认不生效（不擅自改你的窗口） |

`controlPage` 兼容 puppeteer 语义的原因很实际：Playwright 的 `evaluate` 只接受**一个**参数，且传字符串会被当表达式求值（永远不会被调用）——实测 arrow / function / async 三种字符串写法全部返回 `undefined`。多参调用在页面内用 `new Function` 重建。

## 实测

同一套 TalentFlow e2e（`../tf-test`）在两种通道下的结果一致：

| 套件 | extension（0 次点击） | cdp（1 次点击） |
| --- | --- | --- |
| 01-auth-access（30 例：登录/路由守卫/API 授权/JWT 篡改） | 30 PASS · 98s | 30 PASS · 139s |
| 03-resume-edit（16 例：表单校验/草稿/提出/取り下げ） | 15 PASS + 1 已知缺陷 · 58s | 同上 · 51s |
| 04-approval-flow（13 例：模态框/下拉/日期/差し戻し/承认全流程） | 13 PASS · 43s | 13 PASS · 47s |
| 06-admin-masters（17 例：10 个管理模块 CRUD） | 16 PASS + 1 已知缺陷 · 145s | 同上 |
| 08-upload（6 例：xlsx 取込 / multipart テンプレート登録） | 6 PASS · 14s | — |

单元测试 `npm test`：**16/16**（遮挡拒绝 `obscured-by:DIV`、disabled、零尺寸、`pointer-events:none`、shadow 穿透、iframe 到达、`accept`/`multiple` 校验、dropzone、指针+HTML5 拖拽、readonly）。
