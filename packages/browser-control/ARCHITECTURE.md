# 分层

```
browser-control/     怎么控制浏览器（与应用无关）
  src/extension-transport.mjs   ← 唯一接触 playwright 内部 API 的文件（升级只坏这里）
  src/attach.mjs                两种通道 + 能力探测
  src/page.mjs                  能力自适应输入 + puppeteer 风味 API
  src/dom-input.mjs             DOM 输入原语：actionability + hit test + shadow/frame 到达
  src/cdp-shim.mjs              仅 cdp 通道需要
  test/dom-input.test.mjs       11 个单测（遮挡/disabled/零尺寸/pointer-events/shadow/iframe/readonly）
antd-kit/            怎么操作 Ant Design v6（与业务无关）
  index.mjs                     modal 可见性追踪、按钮精确匹配、select/date、popconfirm、toast、tab
tf-test/             TalentFlow 测的是什么
  lib/driver.mjs                账号、登录、API、经历书提出/取り下げ、步骤记录器
  suites/*.mjs                  141 个用例
  report.mjs                    REPORT.md + results/junit.xml
```

依赖方向单向：`tf-test → antd-kit → browser-control`。反向零依赖。
