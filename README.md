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
  src/cdp-shim.mjs             仅 cdp 通道需要的 /json/* 发现端点补丁
  test/                        24 个 node:test 用例（跑在真实浏览器上）
  cleanup.mjs                  收尾清理（只动本工具留下的标签，绝不碰你的页面）
packages/antd-kit/          怎么操作 Ant Design v6（与业务无关）
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

## 两种通道

| 通道 | 前置条件 | 要点"允许"吗 | 能力 |
| --- | --- | --- | --- |
| `extension`（默认） | Playwright Extension + token | **不用** | 无浏览器级 CDP（无焦点模拟/权限预授权/下载目录）→ 由 DOM 级输入兜住；标签生命周期受限（见下） |
| `cdp` | Chrome 带 `--remote-debugging-port` + `npm run shim` | 每个新连接一次 | 完整 CDP |

## 血的教训（都写进了代码里的守卫）

2026-09-05，在 Chrome 152 + Playwright Extension 上把浏览器搞崩/搞退出 **11 次**后定下的约束，`scripts/check.mjs` 会校验这些守卫还在：

| 现象 | 守卫 |
| --- | --- |
| `page.addInitScript()` 经 `chrome.debugger` 会崩掉 browser 进程（2/2 复现，`EXC_BREAKPOINT` on `CrBrowserMain`） | 扩展通道默认拒绝，需 `BC_ALLOW_INIT_SCRIPT=1` |
| 多标签**并发导航**崩浏览器 | `controlPage` 进程级导航串行化（`BC_PARALLEL_NAV=1` 可解） |
| 反复创建/关闭标签、多个池累积附着标签 → 扩展断连，浏览器可能直接退出 | 每连接**只允许一个池**；扩展通道**不关闭**标签（留给下次复用）；`BC_MAX_TABS_EXTENSION=3` |
| 池的标签是浏览器里唯一的标签时，桥一断 Chrome 就退出 | 启动池前要求存在至少一个普通标签 |
| 每次 `attach()` 都会在你浏览器里留下一个**标签组**（扩展行为） | 一个进程只 attach 一次；`npm run cleanup` 收尾 |
| **扩展一次只接受一个客户端**：并发跑两个测试文件时后者连不上、前者被打断 | 测试串行执行（`--test-concurrency=1`） |
| `setViewport` 会下发 `Emulation.setDeviceMetricsOverride`，把页面锁小、右侧留白 | 默认不生效，需 `BC_VIEWPORT=1` |

## 本地 CI（git hook，不用 GitHub Actions）

```bash
node scripts/install-hooks.mjs
```
- `pre-commit` → `scripts/check.mjs --offline`：全量语法检查、遗留调试语句、**崩溃守卫是否还在**、license 元数据
- `pre-push` → 同上 + 真实浏览器测试；Chrome 没开或没 token 时**跳过并提示**，不阻塞推送

## 许可

MIT
