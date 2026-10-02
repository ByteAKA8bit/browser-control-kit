// Unit tests for the DOM-input primitives — the part most likely to silently
// rot, because a bug here makes tests PASS where a human cannot click.
//
// They run against the operator's real browser (that is the whole point of this
// package) on an about:blank fixture, so nothing external is touched.
//
//   PLAYWRIGHT_MCP_EXTENSION_TOKEN=… node --test test/
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { attachOrSkip } from "./attached.mjs";
import { controlPage } from "../src/page.mjs";
import { makeCsv, makeXlsx } from "../src/fixtures.mjs";

const FIXTURE = `
  <style>
    /* keep the overlay pair well away from the in-flow fixture elements */
    #covered { position: absolute; top: 400px; left: 0; width: 80px; height: 30px; }
    /* the mask must cover ONLY #covered, otherwise the whole fixture is unclickable */
    #mask { position: absolute; top: 400px; left: 0; width: 80px; height: 30px; background: rgba(0,0,0,.3); }
    #zero { width: 0; height: 0; padding: 0; border: 0; }
    #noptr { pointer-events: none; width: 60px; height: 20px; }
  </style>
  <button id="plain">plain</button>
  <button id="disabled" disabled>disabled</button>
  <button id="zero">zero</button>
  <button id="noptr">noptr</button>
  <input id="text" />
  <input id="ro" readonly />
  <div id="log"></div>
  <div id="host"></div>
  <iframe id="frame" srcdoc="<button id='inframe'>f</button><input id='framefield' />"></iframe>
  <button id="covered">covered</button><div id="mask"></div>
  <script>
    for (const id of ['plain','disabled','zero','noptr','covered'])
      document.getElementById(id).addEventListener('click', () => { document.getElementById('log').textContent += id + ';'; });
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = "<button id='shadowbtn'>s</button><input id='shadowfield' />";
    root.getElementById('shadowbtn').addEventListener('click', () => { document.getElementById('log').textContent += 'shadow;'; });
  </script>
`;

// Attached once, up front: a machine without the extension installed has nothing
// to say about these primitives, so every describe below is skipped with that
// reason instead of reporting 16 cancelled tests.
const { attached, skip } = await attachOrSkip();
const browser = attached?.browser;
let page;

before(async () => {
  if (!attached) return;
  const raw = attached.context.pages()[0] ?? (await attached.context.newPage());
  page = controlPage(raw, { ...attached.capabilities, focusEmulation: false }); // force the DOM path
  await raw.goto("about:blank");
  await raw.setContent(`<body>${FIXTURE}</body>`);
});

after(async () => {
  await browser?.close();
});

const log = () => page.evaluate(() => document.getElementById("log").textContent ?? "");

describe("DOM click actionability", { skip }, () => {
  it("clicks a plain button", async () => {
    await page.click("#plain");
    assert.match(await log(), /plain;/);
  });

  it("refuses a disabled button", async () => {
    await assert.rejects(() => page.click("#disabled"), /disabled/);
  });

  it("refuses a zero-size button", async () => {
    await assert.rejects(() => page.click("#zero"), /zero-size/);
  });

  it("refuses pointer-events:none", async () => {
    await assert.rejects(() => page.click("#noptr"), /pointer-events-none/);
  });

  it("refuses an element covered by an overlay and names the blocker", async () => {
    await assert.rejects(() => page.click("#covered"), /obscured-by:DIV/);
  });

  it("reports a missing selector", async () => {
    await assert.rejects(() => page.click("#nope"), /not-found/);
  });
});

describe("reach", { skip }, () => {
  it("pierces an open shadow root", async () => {
    await page.click("#shadowbtn");
    assert.match(await log(), /shadow;/);
  });

  it("counts across shadow roots", async () => {
    assert.equal(await page.deepCount("#shadowbtn"), 1);
  });

  it("reaches into an iframe", async () => {
    await page.click("#inframe");
    await page.fill("#framefield", "in-frame");
    const value = await page.mainFrame().childFrames()[0].evaluate(() => document.getElementById("framefield").value);
    assert.equal(value, "in-frame");
  });
});

describe("DOM text input", { skip }, () => {
  it("fills and replaces a value with input/change events", async () => {
    const seen = [];
    await page.evaluate(() => {
      window.__events = [];
      const el = document.getElementById("text");
      for (const type of ["input", "change"]) el.addEventListener(type, () => window.__events.push(type));
    });
    await page.fill("#text", "hello");
    await page.type("#text", "-world");
    assert.equal(await page.$eval("#text", (el) => el.value), "hello-world");
    seen.push(...(await page.evaluate(() => window.__events)));
    assert.ok(seen.includes("input") && seen.includes("change"), `events=${seen}`);
  });

  it("refuses a readonly field", async () => {
    await assert.rejects(() => page.fill("#ro", "x"), /readonly/);
  });
});

// ---------------------------------------------------------------------------
// Upload & drag: the two operations that normally need CDP or a real mouse.
// ---------------------------------------------------------------------------
const UPLOAD_FIXTURE = `
  <input id="file" type="file" />
  <input id="filexlsx" type="file" accept=".xlsx" />
  <input id="multi" type="file" multiple />
  <div id="zone" style="width:200px;height:60px;background:#eee">drop here</div>
  <ul id="list" style="width:200px">
    <li id="i1" draggable="true" style="height:30px;background:#cfc">one</li>
    <li id="i2" draggable="true" style="height:30px;background:#ccf">two</li>
  </ul>
  <div id="ulog"></div>
  <script>
    const log = (s) => { document.getElementById('ulog').textContent += s + ';'; };
    document.getElementById('file').addEventListener('change', (e) => log('change:' + [...e.target.files].map(f => f.name + ':' + f.size).join('|')));
    document.getElementById('multi').addEventListener('change', (e) => log('multi:' + e.target.files.length));
    document.getElementById('zone').addEventListener('dragover', (e) => e.preventDefault());
    document.getElementById('zone').addEventListener('drop', (e) => { e.preventDefault(); log('drop:' + [...e.dataTransfer.files].map(f => f.name).join('|')); });
    const i1 = document.getElementById('i1');
    i1.addEventListener('pointerdown', () => log('pd'));
    document.getElementById('i2').addEventListener('pointermove', () => { if (!window.__moved) { window.__moved = 1; log('pm-over-i2'); } });
    document.getElementById('i2').addEventListener('drop', () => log('html5drop'));
    document.getElementById('i2').addEventListener('dragover', (e) => e.preventDefault());
  </script>
`;

describe("upload & drag", { skip }, () => {
  before(async () => {
    await page.setContent(`<body>${UPLOAD_FIXTURE}</body>`);
  });

  const ulog = () => page.evaluate(() => document.getElementById("ulog").textContent ?? "");

  it("attaches a generated xlsx to a file input", async () => {
    const xlsx = makeXlsx([["分類", "分野"], ["クラウド", "IaaS"]]);
    const res = await page.setInputFiles("#file", { name: "master.xlsx", buffer: xlsx });
    assert.equal(res.count, 1);
    assert.match(await ulog(), new RegExp(`change:master\\.xlsx:${xlsx.length}`));
  });

  it("honours the input's accept filter", async () => {
    await assert.rejects(() => page.setInputFiles("#filexlsx", { name: "notes.txt", buffer: Buffer.from("x") }), /rejected-by-accept/);
    const ok = await page.setInputFiles("#filexlsx", { name: "ok.xlsx", buffer: makeXlsx([["a"]]) });
    assert.equal(ok.ok, true);
  });

  it("refuses multiple files on a single-file input", async () => {
    await assert.rejects(
      () => page.setInputFiles("#file", [{ name: "a.csv", buffer: makeCsv([["a"]]) }, { name: "b.csv", buffer: makeCsv([["b"]]) }]),
      /input-not-multiple/,
    );
    const many = await page.setInputFiles("#multi", [{ name: "a.csv", buffer: makeCsv([["a"]]) }, { name: "b.csv", buffer: makeCsv([["b"]]) }]);
    assert.equal(many.count, 2);
  });

  it("drops files onto a dropzone", async () => {
    await page.dropFiles("#zone", { name: "dropped.csv", buffer: makeCsv([["x"]]) });
    assert.match(await ulog(), /drop:dropped\.csv/);
  });

  it("drags with pointer events and the HTML5 API", async () => {
    const res = await page.dragAndDrop("#i1", "#i2");
    assert.equal(res.ok, true);
    assert.equal(res.html5, true);
    const text = await ulog();
    assert.match(text, /pd;/); // pointer drag started
    assert.match(text, /pm-over-i2/); // moved across the target
    assert.match(text, /html5drop/); // and the HTML5 drop landed
  });
});
