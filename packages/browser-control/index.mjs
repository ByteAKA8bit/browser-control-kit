// browser-control — drive the browser the operator is actually using.
export { attach, transportSupport, DEFAULT_MODE } from "./src/attach.mjs";
export { controlPage, blockUrls } from "./src/page.mjs";
export { TabPool, parallelMap, MAX_TABS, MAX_TABS_EXTENSION } from "./src/pool.mjs";
export { TabGuard, guardContext, guardBrowser, tabCeiling } from "./src/tab-guard.mjs";
export { makeXlsx, makeCsv, makePng, asUpload } from "./src/fixtures.mjs";
export { extensionSupport, loadToken } from "./src/extension-transport.mjs";
