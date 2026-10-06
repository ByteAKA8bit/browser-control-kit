[English](README.md) · **简体中文**

# browser-control-kit

驱动**你自己正在用的那个浏览器**——正常双击打开的 Chrome，带全部登录态和扩展。

- **不加启动参数**、**不挂 user-data-dir**、**不起新实例**、**不用点"允许"**
- 后台标签也能操作（不抢焦点、不打断你）
- 只放工具代码；被测业务的用例不进这个仓库

> 起一个空白 dev profile 的方案本仓库**明确不做**：没有真实会话、没有扩展、没有真实状态，证明不了任何东西，而且这种方案满地都是。

## 结构

```
packages/browser-control/   怎么控制浏览器（与应用无关）
  src/extension-transport.mjs  唯一接触 playwright 内部 API 的文件（升级只坏这里）
  src/attach.mjs               两种通道 + 能力探测 + trace
  src/page.mjs                 能力自适应输入、导航串行化、puppeteer 风味 API
  src/dom-input.mjs            DOM 输入原语：actionability + hit test + shadow/frame 到达
  src/transfer.mjs             上传 / 拖放 / 拖拽（不需要 CDP）
  src/fixtures.mjs             零依赖 xlsx / csv / png 生成
  src/pool.mjs                 并行：多标签任务池（含扩展通道的安全约束）
  src/tab-guard.mjs            TabGuard:具名页面、先复用、量出来的闲置窗口、回收
  src/cdp-shim.mjs             /json/* 重建 + 单连接 CDP 代理（仅 cdp 通道）
  src/ws-server.mjs            给 shim 用的手写 RFC 6455 服务端
  test/                        node:test:无浏览器套件 + 真实浏览器套件
  cleanup.mjs                  收尾清理（只动本工具留下的标签，绝不碰你的页面）
packages/mcp-server/        MCP stdio 服务端（bin: browser-control-mcp）——agent 连的就是它
packages/antd-kit/          怎么操作 Ant Design v6（与业务无关）
  index.mjs                 Modal 与 Drawer 两种浮层：先给「可见的那一个」打标记再操作
                            （`MODAL` / `DRAWER` + `syncScope`），表单助手都接受 `{ scope }`；
                            Select 点不到时退化为 DOM 级鼠标事件
scripts/check.mjs           本地 CI（离线检查 + 真实浏览器测试）
scripts/crash-repro.mjs     崩溃二分定位（会故意搞崩浏览器，需 BC_CRASH_REPRO=1）
.githooks/                  pre-commit = 离线检查，pre-push = + 浏览器测试
examples/                   最小示例
```

依赖方向单向：`你的用例 → antd-kit → browser-control`。

## 快速开始

```bash
npm i && node scripts/install-hooks.mjs      # Node ≥ 22；不要用 Bun（其 WS 客户端撑不起 Playwright 的 CDP 传输）

# 一次性：装 Playwright Extension，把 status 页的 token 存起来
mkdir -p ~/.config/browser-control && pbpaste > ~/.config/browser-control/token && chmod 600 $_

npm run test:offline     # 标签治理、焦点归还、WebSocket 编解码、shim、MCP 协议 167 例（不需要浏览器，pre-commit 也跑）
npm run test:unit        # DOM 输入 16 例
npm run test:pool        # 并行 8 例
npm run selftest         # 端到端自检
npm run cleanup          # 收尾：关掉本工具留下的标签、清掉探测用的站点权限
                         # （--dry-run 只报告不动手）
```

```js
import { attach, controlPage, TabPool } from "browser-control";

const { browser, context, capabilities } = await attach();       // 默认扩展通道
const page = controlPage(context.pages()[0], capabilities);
await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
await page.fill("#q", "hello");
await page.click("button[type=submit]");

const pool = await new TabPool(context, { size: 2, capabilities }).start();
const results = await pool.map(items, async (item, tab) => tab.evaluate(/* … */));
```

## 两种通道，和自动选路的 `auto`

| 通道 | 前置条件 | 要点"允许"吗 | 会抢你的屏幕吗 | 能力 |
| --- | --- | --- | --- | --- |
| `extension` | Playwright Extension + token | **不用** | 会：每次 `attach()` 约 150ms（启动 Chrome 带 relay 页，Chrome 自己提到最前） | 无浏览器级 CDP（无焦点模拟/权限预授权/下载目录）→ 由 DOM 级输入兜住;标签生命周期受限（见下） |
| `cdp` | Chrome 开着调试端口 + `npm run shim:service` | **一次**（Chrome 重启才再要一次） | **不会**：`attach()` 根本不开页面,新标签也开在后台 | 完整 CDP,含 `Target.createTarget { background: true }` |

`DEFAULT_MODE` 是 `BC_MODE ?? "auto"`,**推荐就用 `auto`**:它探一下 `BC_CDP_URL`(默认 `http://localhost:9333`),有 shim 在应答就走 `cdp`,否则走 `extension`。它**绝不会去启动 shim**——启动 shim 是唯一可能弹出 Chrome 授权框的动作,无人值守的 agent 不能等一次点击。决策和理由记在 `capabilities.chose`。

所以"不打扰"的配置就是:装一次 shim 常驻(`npm run shim:service`),Chrome 重启后点一次"允许",其余全部交给 `auto`。没装也不会坏——退回 extension 通道,无人值守,代价是每次 attach 那约 150ms 的闪。

用 `BC_MODE=extension` / `BC_MODE=cdp` 或 `attach({ mode })` 可以钉死某一条;shim 地址是 `BC_CDP_URL`。

## 不想反复点"允许"

Chrome 对默认 profile 的每一条**新的**外部 CDP 连接都弹确认框，而且不记忆（未批准时 `/json/*` 返回 404、WebSocket 握手一直挂着）。所以关键不是"怎么免掉"，而是**让连接只建立一次**。

| 做法 | 要点几次"允许" | 代价 |
| --- | --- | --- |
| `extension` 通道（默认） | **0 次**，token 代替点击 | 没有浏览器级 CDP（见上表） |
| `cdp` + 常驻 shim（`npm run shim:service`） | 每次 **Chrome 重启**一次 | 要跑一个后台进程 |
| `cdp` + 每次现起 shim（`npm run shim`） | 每次起 shim 一次 | — |
| 直接 `connectOverCDP("http://localhost:9222")` | **每次 attach 一次** | 就是这个在烦你 |
| 换 `--user-data-dir` 的干净 profile | 0 次 | 没有登录态，本项目的非目标 |
| 组策略 `RemoteDebuggingAllowed` | 不解决 | 只能整体开关，没有"自动同意" |

shim 现在是真正的**代理**：它持有唯一一条已批准的浏览器 socket，`/json/version` 与 `/json/list` 返回的 WebSocket 地址都指向 shim 自己（`ws://127.0.0.1:9333/...`），客户端再也不会直连 Chrome。页面地址 `/devtools/page/<id>` 走同一条 socket 上的 flat session，对客户端透明。

```bash
npm run shim:service                  # 装成 launchd 常驻（KeepAlive，登录自启）
node scripts/install-shim-service.mjs --uninstall
tail -f ~/.cache/browser-control/shim.log
```

实测（一次性 profile 的 Chrome + 连续三次 attach）：Chrome 侧始终只有**一条** CDP 连接，且端口不变；Playwright 的两条连接全部落在 shim 上。

```
chrome side:  Google 89970 127.0.0.1:9224->127.0.0.1:53988
              node   90275 127.0.0.1:53988->127.0.0.1:9224     ← 只有 shim
shim side:    node   90849 127.0.0.1:54006->127.0.0.1:9333     ← Playwright
              node   90849 127.0.0.1:54007->127.0.0.1:9333
```

注意：shim 进程重启 = 新连接 = 再点一次，所以才要常驻；Chrome 重启同理（shim 会自己重连，并在日志里说明这次需要再点一次）。

## 血的教训（都写进了代码里的守卫）

2026-09-05，在 Chrome 152 + Playwright Extension 上把浏览器搞崩/搞退出 **11 次**后定下的约束，`scripts/check.mjs` 会校验这些守卫还在：

| 现象 | 守卫 |
| --- | --- |
| `page.addInitScript()` 经 `chrome.debugger` 会崩掉 browser 进程（2/2 复现，`EXC_BREAKPOINT` on `CrBrowserMain`） | 扩展通道默认拒绝，需 `BC_ALLOW_INIT_SCRIPT=1` |
| 多标签**并发导航**崩浏览器 | `controlPage` 进程级导航串行化（`BC_PARALLEL_NAV=1` 可解） |
| 反复创建/关闭标签、多个池累积附着标签 → 扩展断连，浏览器可能直接退出 | 每连接**只允许一个池**；`BC_MAX_TABS_EXTENSION=3`；创建/关闭串行 + 400ms 沉降 |
| 池的标签是浏览器里唯一的标签时，桥一断 Chrome 就退出 | 启动池前要求存在至少一个普通标签 |
| 每次 `attach()` 都会在你浏览器里留下一个**标签组**（扩展行为） | 一个进程只 attach 一次；`npm run cleanup` 收尾 |
| **扩展一次只接受一个客户端**：并发跑两个测试文件时后者连不上、前者被打断 | 测试串行执行（`--test-concurrency=1`） |
| `setViewport` 会下发 `Emulation.setDeviceMetricsOverride`，把页面锁小、右侧留白 | 默认不生效，需 `BC_VIEWPORT=1` |

## 标签纪律（`TabGuard`）

Agent 的典型毛病：一步开一个新标签,从不关,半小时后 Chrome 吃掉几十个渲染进程——而那是**你自己在用的浏览器**。解法不是配额:数字定小了干不了活,定大了保护不了谁;**正确的标签数,等于此刻真正在干活的标签数**。所以 `attach()` 返回的受管 context 按"复用 + 压力"治理,而不是按数字:

```js
const { browser, context, tabs } = await attach();   // tabs = TabGuard

for (let i = 0; i < 10; i += 1) await context.newPage();  // 要了 10 次
console.log(tabs.report());                               // owned: 3, recycled: 7 —— 多数请求复用了同一个标签

await browser.close();   // 自己的标签 + relay 的桥接页,一起还回去
```

| 规则 | 行为 | 开关 |
| --- | --- | --- |
| **先复用** | 自有标签一旦"安静下来",**就是**下一个标签:清空后直接交出去。复用零成本,新开一个要花掉操作者 40–80 MB | `BC_TAB_RECYCLE_MS` 可定死窗口 |
| **窗口是量出来的,不是定出来的** | "安静"没有正确的常数——爬虫每 200ms 碰一次标签,会思考的 agent 每 30s 碰一次。守卫测量**操作之间的间隔**(EWMA,长时间停顿不计入),并把每个判断表达成"几个节拍":约 5 拍可复用、约 30 拍清空、约 120 拍关闭,各自带下限与上限 | `BC_TAB_RECYCLE_MS`、`BC_TAB_BLANK_MS`、`BC_TAB_IDLE_MS` |
| **只管自己的占用,不管机器** | 不探测系统内存:各平台的报法都不一样,别人开个大应用就把这个数搬走了。这个进程能精确知道的只有**自己哪些标签是闲的**——那就把它们交回去 | — |
| **通道上限** | 唯一一个硬数字,而且不是审美问题:扩展桥超过 3 个附着标签就断连。想自己定死用 `BC_TAB_BUDGET` | `BC_MAX_TABS_EXTENSION`、`BC_TAB_BUDGET` |
| **归属** | `attach()` 之前就存在的标签属于操作者,**永不关闭、不导航、不计数**;`window.open`/`target=_blank` 弹窗算我们的 | — |
| **占用** | `TabPool` 的标签 `hold()` 住,不会被复用、淘汰或回收 | `BC_TAB_EVICT=0` 改为只报错不淘汰 |
| **具名页面（surface）** | `guard.surface("docs")` 把一个名字绑到一个页面:同名总是返回同一个页面,绑定期间既不会被复用也不会被回收。`guard.surface()` 是**草稿页**——所有不具名的调用共用这一个页面,所以一串不具名的操作只占一个标签,而不是一步一个;它不被 hold,因此照样会被复用、淘汰、回收。`guard.release(name)` 把名字解绑、标签变回普通的自有标签;`guard.surfaces()` 列出 `{ name, url, idleMs, blanked }` | — |
| **后台开标签** | raw CDP 下新标签用 `Target.createTarget { background: true }` 打开,永远不会变成你正在看的那个标签;扩展 relay 没有这个选项(`chrome.tabs.create` 必然激活),于是退回普通前台标签并且不再重试。`report().backgroundTabs` 告诉你当前是哪一种 | — |
| **不留尾巴** | `browser.close()` 连 relay 的 `connect.html` 一起关;调用方忘了收尾,`beforeExit`/`SIGINT`/`SIGTERM` 也会还 | `BC_KEEP_BRIDGE_TAB=1`、`BC_TAB_GUARD=0`、`attach({ guard: false })` |

两个问题由两套机制分别回答,而且都成立:量出来的节拍回答"这个不具名的标签闲了吗",名字回答"这个页面还要不要"。当通道上限已满、而且**每个**标签都是绑定的具名页面时,**最久未用**的那个会被释放、它的标签被复用——不报错,而是记进 `report().surfacesEvicted` 并在工具输出里说出来:丢掉一个具名页面必须是可见的。

草稿页**故意不走节拍**:一个每 30 秒才动一次的 agent,以前每一步不具名操作都会新开一个标签、再把上一个淘汰掉——操作者看到的就是标签一个个蹦出来又消失。`report().scratch` 给出它的 URL,没有就是 `null`。

实测(真实 Chrome):连续 10 次 `newPage()` → **新建 3 个、复用 7 次、淘汰 0 个**,`close()` 后标签数回到原样;连跑三轮完整测试,标签数一个不多一个不少。一条值得记下的弯路:早期版本按"系统剩余内存"做准入,既无法跨平台测准(macOS 上 16 GB 健康机器报 1%,实际可用 24%),原理上也站不住——**拒绝一个标签省不下一个字节,只会让活干不成**。复用和回收才是真正起作用的两件事。

盲区：扩展通道附着不了的标签（`chrome://`、Web Store、其他扩展的页面、无 file 权限的 `file://`）不会出现在 `context.pages()` 里，这个守卫看不见、也关不掉。

## 不抢屏幕

扩展通道下的 `attach()` 会让 playwright-core **启动 Chrome** 并带上 relay 的 `connect.html`,而 Chrome 会把自己提到最前面——**哪怕它本来就在运行**,这正是最烦人的那种情况。

这个"提前"挡不住。2026-10-06 对着已经在运行的 Chrome 实测了三条路:直接 spawn 浏览器二进制带 URL(playwright 的做法)、`open -g -a "Google Chrome" <url>`(`-g` 就是"别切到前台")、AppleScript `make new tab`。三条路都把 Chrome 顶到最前——外部给 URL,Chrome 自己会 activate。

所以改成"抢回来",而且要早:连接前读一次最前台的应用(`lsappinfo`),连接**过程中**每 100ms 轮询一次,一旦发现 Chrome 抢走屏幕立刻 `open -b` 抢回,结果写在 `capabilities.focus` 里:

```json
{ "restored": true, "app": "com.microsoft.VSCode", "took": "com.google.Chrome", "bounces": 1 }
```

用 50ms 采样器围着真实 `attach()` 量到的数:Chrome 占住屏幕 **约 100–150ms**,而不是整个握手的 ~600ms。而且只从 Chrome/Chromium 手里抢——你自己切到别的应用,永远不会被拽回来(报告里是 `not-the-browser (com.apple.Terminal)`)。只支持 macOS,不需要辅助功能授权;Windows 上没有不写原生 `SetForegroundWindow` 的等价做法。`BC_RESTORE_FOCUS=0` 关掉,`BC_FOCUS_WATCH_MS`(10s)给轮询封顶。

真正的解法,而且是量过的:**`auto` + 常驻 shim + 常驻 MCP server**。走 `cdp` 时这一整类打扰直接消失——`attach()` 不开页面,所以没有任何东西被提到前台;标签开在后台,所以你正在看的标签还是当前标签。2026-10-06 对着你自己登录的 Chrome、用真实 MCP server 跑 stdio 协议实测(3 次不具名导航 + 1 次具名页面,连跑两轮):

```text
mode: cdp | chose: "cdp"
guard: {"owned":2,"created":2,"evicted":0,"backgroundTabs":true,"operatorTabs":4}
front before/after: com.microsoft.VSCode / com.microsoft.VSCode
operator tab https://www.zhihu.com/ visibility before/after: visible / visible
```

走 `extension` 时剩下的打扰是:每次 `attach()` 约 150ms 的闪,外加每开一个新标签会切走当前标签。所以草稿页在那条路上才重要——"又一个标签跳到我面前"的解法是少开标签,而不是跟浏览器抢焦点。

## MCP server

Agent 总爱把这个仓库现场包成 MCP,然后连接断断续续、标签越开越多。所以 MCP 服务端直接内置:无 SDK、零依赖、stdio 上的 JSON-RPC。

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "node",
      "args": ["/绝对路径/browser-control-kit/packages/mcp-server/bin/browser-control-mcp.mjs"],
      "env": { "BC_MODE": "cdp" }
    }
  }
}
```

| 特性 | 怎么保证的 |
| --- | --- |
| **开不出新标签** | Agent 的词汇里根本没有"标签"。它说的是**具名页面**——`browser_navigate {url, as: "docs"}` 留住一个,`{on: "docs"}` 回到它,两个都不给就用草稿页——生命周期归服务端管。没有任何工具能开或关一个标签,所以 agent 漏不了标签 |
| **连接稳定** | 每进程一次 `attach()`,懒创建、断了自动重建,并发首调共享同一次 attach;只有 stdin EOF 才退出 |
| **stdout 干净** | 只跑 JSON-RPC,日志全走 stderr,写入遵守背压——这正是"MCP 老断"的常见原因 |
| **轻** | `browser-control` 与 playwright 都是首次用到才懒加载:实测空载 RSS 40 MB,比裸 Node 只多约 3 MB |
| **失败是结果不是崩溃** | 工具失败返回 `isError: true` + 文本,不抛 JSON-RPC 错误、不退出 |

任何需要 agent 配合的规则都是一个失效点,所以我们不是去管住标签,而是把标签从它的词汇里拿掉——和 shim(一条被批准的连接,所有客户端都从它代理)、以及"先复用"(是否开标签不再由调用方决定)是同一个动作。剩下的只有意图:一个名字。到了通道上限、每个标签都是具名页面时,最久未用的那个被释放、标签被复用,工具会说出丢掉的是哪个名字——是报告,不是拒绝。

10 个工具,每个一句话描述:`browser_status`、`browser_navigate`(`{url, as?, waitUntil?}`)、`browser_click`、`browser_type`、`browser_fill`、`browser_text`、`browser_evaluate`、`browser_screenshot`、`browser_wait_for`(都可带可选的 `on`),以及 `browser_surfaces`——列出当前的具名页面,人和 agent 都看得懂。`on` 指向不存在的名字时返回工具错误,并列出存在的名字。详见 [`packages/mcp-server/README.md`](packages/mcp-server/README.md)。

```bash
npm run mcp            # 手动跑
node --test packages/mcp-server/test/protocol.test.mjs   # 28 个协议用例,不需要浏览器
```

## 它在你机器上留下的东西

装了不能满地撒文件。除了 launchd 强制要求的 plist,它只写**一个目录**:

| 路径 | 是什么 | `--uninstall` 会删吗 |
| --- | --- | --- |
| `~/Library/LaunchAgents/com.browser-control.shim.plist` | launchd 服务定义——只有你装了常驻服务才有 | 会 |
| `~/.cache/browser-control/shim.log`、`shim.err.log` | shim 自己的输出,**每次启动超过 256 KiB 就截断**,所以跑几个月也就是两个小文件 | 会 |
| `~/.cache/browser-control/` | 这个工具唯一会写的目录 | 空了就删 |
| `~/.config/browser-control/token` | **你自己**贴进去的扩展 token:只读,从不写、从不回显 | **不删**——删掉你贴的密钥不叫清理 |
| `<node 前缀>/bin/browser-control-mcp` 等两个符号链接 | 只有你在 `packages/mcp-server` 里跑过 `npm link` 才有 | **不删**——归 npm:`npm rm -g browser-control-mcp` |

除此之外什么都没有:没有状态文件、没有数据库、仓库外没有 node_modules,Chrome profile 里也不留东西(能力探测授予的权限立刻清掉,`setViewport` 默认无效,attach 之前就存在的标签永不触碰)。`BC_SHIM_LOG_DIR` 换目录,`BC_SHIM_LOG_MAX` 改上限。

```bash
node scripts/install-shim-service.mjs --status      # 每个路径、当前大小、哪些是我们的
node scripts/install-shim-service.mjs --uninstall   # 停服务并删掉全部
```

`--status` 会把上表连同实时大小打出来,每行标注是不是 `rm`;两条命令读的是 `scripts/install-shim-service.mjs` 里**同一份清单**,所以"装了什么"和"删什么"不可能走偏(由 `shim-service.test.mjs` 钉住)。

## 本地 CI（git hook + GitHub Actions 的 offline 层）

```bash
node scripts/install-hooks.mjs
```
- `pre-commit` → `scripts/check.mjs --offline`：全量语法检查、遗留调试语句、**崩溃守卫是否还在**、license 元数据
- `pre-push` → 同上 + 真实浏览器测试；Chrome 没开或没 token 时**跳过并提示**，不阻塞推送

`.github/workflows/ci.yml` 在 **macOS 与 Windows** 上用 Node 22 跑 offline 层 —— 这个工具驱动的是操作员自己登录着的桌面 Chrome，所以只支持这两个平台。Linux 不是目标平台，它在 CI 里只是不阻塞的参考信号。浏览器层在 CI 里根本跑不了：它需要操作员的 Chrome 和扩展 token。

## 许可

MIT
