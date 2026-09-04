// Minimal example: screenshot several URLs in parallel, in the browser you are
// already using. Nothing here is app-specific.
//
//   node examples/parallel-screenshots.mjs https://example.com https://example.org
import { attach, controlPage, TabPool } from "../packages/browser-control/index.mjs";

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error("usage: node examples/parallel-screenshots.mjs <url> [url…]");
  process.exit(1);
}

const { browser, context, capabilities, mode } = await attach();
console.log(`attached via ${mode}; input=${controlPage(context.pages()[0], capabilities).inputMode()}`);

// The pool needs one ordinary tab to exist and reuses its own tabs across runs.
const pool = await new TabPool(context, { size: 2, capabilities }).start();
const results = await pool.map(urls, async (url, page, i) => {
  await page.goto(url, { waitUntil: "domcontentloaded" }); // serialised on the extension transport
  const file = `shot-${i}.png`;
  await page.screenshot({ path: file });
  return { title: await page.title(), file };
});

for (const r of results) console.log(r.ok ? `✓ ${r.value.title} → ${r.value.file} (${r.ms}ms, tab ${r.tab})` : `✗ ${r.error}`);
await pool.close(); // no-op on the extension transport: tabs are reused
await browser.close();
