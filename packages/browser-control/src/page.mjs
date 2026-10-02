// Page control that survives a BACKGROUND tab.
//
// Playwright's click/fill run actionability checks and dispatch real input
// events. That works when the tab is foreground, or when the transport can turn
// on Emulation.setFocusEmulationEnabled. The Playwright Extension transport can
// do neither — the attached tab reports visibilityState=hidden and page.click
// times out. So input is capability-aware:
//
//   focusEmulation available (cdp) → real Playwright input
//   otherwise                      → DOM-level input from ./dom-input.mjs, which
//                                    re-implements actionability + hit testing
//                                    and pierces open shadow roots; the op is
//                                    retried in every frame so iframes work too
//
// The exposed surface is puppeteer-flavoured on purpose: suites written against
// puppeteer keep working (multi-arg evaluate, waitForSelector({visible}),
// setViewport, evaluateOnNewDocument).
import { DEEP_QUERY_ALL, DOM_CLICK, DOM_COUNT, DOM_KEY, DOM_READ_VALUE, DOM_SET_VALUE } from "./dom-input.mjs";
import { DOM_DRAG, DOM_DROP_FILES, DOM_MAKE_TRANSFER, DOM_SET_FILES } from "./transfer.mjs";
import { asUpload } from "./fixtures.mjs";

const DEEP_SRC = DEEP_QUERY_ALL.toString();

// ── Navigation lock ────────────────────────────────────────────────────────
// 2026-09-05: concurrent page.goto() across several tabs over the EXTENSION
// transport crashes the Chrome browser process (EXC_BREAKPOINT on CrBrowserMain,
// reproduced with test/crash-repro.mjs / pool.test "navigates several tabs in
// parallel"). Everything else parallelises fine — concurrent evaluate, clicks,
// screenshots, tab create/close — so only navigation is serialised, process-wide.
// Escape hatch: BC_PARALLEL_NAV=1.
let navChain = Promise.resolve();
export const serialiseNavigation = (fn) => {
  const run = navChain.then(fn, fn);
  navChain = run.then(
    () => {},
    () => {},
  );
  return run;
};

// Playwright's evaluate takes ONE argument, and a string body is evaluated as an
// expression (never invoked), so multi-arg calls are rebuilt in-page.
const applyInPage = ({ src, args }) => new Function(`return (${src})`)()(...args);
const applyInPageEl = (el, { src, args }) => new Function(`return (${src})`)()(el, ...args);
const applyInPageAll = (els, { src, args }) => new Function(`return (${src})`)()(els, ...args);

/** Accept paths / Buffers / {name,buffer} and normalise to {name,type,base64}. */
async function normaliseFiles(files) {
  const list = Array.isArray(files) ? files : [files];
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const out = [];
  for (const f of list) {
    if (typeof f === "string") {
      out.push(asUpload(path.basename(f), await readFile(f)));
    } else if (Buffer.isBuffer(f)) {
      out.push(asUpload("upload.bin", f));
    } else if (f?.buffer) {
      out.push(asUpload(f.name ?? "upload.bin", f.buffer, f.type));
    } else if (f?.base64) {
      out.push(f);
    } else {
      throw new Error(`unsupported file argument: ${JSON.stringify(f)?.slice(0, 80)}`);
    }
  }
  return out;
}

export function controlPage(page, capabilities = {}) {
  const realInput = () => capabilities.focusEmulation === true;
  const mode = capabilities.mode ?? process.env.BC_MODE ?? "extension";
  const lockNavigation = mode === "extension" && process.env.BC_PARALLEL_NAV !== "1";
  const navigate = (fn) => (lockNavigation ? serialiseNavigation(fn) : fn());

  /** Run a DOM primitive in the main frame, then in child frames, until one hits. */
  const inAnyFrame = (fn, args) => inAnyFrameRaw(fn, [...args, DEEP_SRC]);

  const inAnyFrameRaw = async (fn, fullArgs) => {
    const payload = { src: fn.toString(), args: fullArgs };
    const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
    let last = { ok: false, reason: "no-frames" };
    for (const frame of frames) {
      let res;
      try {
        res = await frame.evaluate(applyInPage, payload);
      } catch (err) {
        res = { ok: false, reason: `frame-error:${String(err?.message ?? err).split("\n")[0]}` };
      }
      if (res?.ok) return { ...res, frame: frame === page.mainFrame() ? "main" : frame.url() };
      // "not-found" just means "try the next frame"; anything else is a real
      // actionability failure worth surfacing.
      if (res && res.reason !== "not-found") last = res;
      else if (last.reason === "no-frames") last = res;
    }
    return last;
  };

  /**
   * Same as inAnyFrame, but also injects the DataTransfer builder source that
   * the upload/drop primitives need (DOM_DRAG only needs the deep query).
   */
  const inAnyFrame2 = (fn, args) => {
    const needsTransfer = fn === DOM_SET_FILES || fn === DOM_DROP_FILES;
    return inAnyFrameRaw(fn, needsTransfer ? [...args, DEEP_SRC, DOM_MAKE_TRANSFER.toString()] : [...args, DEEP_SRC]);
  };

  const overrides = {
    goto: (url, options = {}) => navigate(() => page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000, ...options })),
    reload: (options = {}) => navigate(() => page.reload({ waitUntil: "domcontentloaded", timeout: 45_000, ...options })),
    /** True when this page serialises navigation (extension transport). */
    navigationSerialised: () => lockNavigation,
    evaluate: (fn, ...args) => {
      if (typeof fn === "string") return page.evaluate(fn);
      if (args.length <= 1) return page.evaluate(fn, args[0]);
      return page.evaluate(applyInPage, { src: fn.toString(), args });
    },
    $eval: (selector, fn, ...args) =>
      args.length <= 1 ? page.$eval(selector, fn, args[0]) : page.$eval(selector, applyInPageEl, { src: fn.toString(), args }),
    $$eval: (selector, fn, ...args) =>
      args.length <= 1 ? page.$$eval(selector, fn, args[0]) : page.$$eval(selector, applyInPageAll, { src: fn.toString(), args }),

    async click(selector, options = {}) {
      if (realInput()) return page.click(selector, { timeout: 15_000, ...options });
      const clicks = options.clickCount ?? 1;
      for (let i = 0; i < clicks; i += 1) {
        const res = await inAnyFrame(DOM_CLICK, [selector, options.nth ?? 0]);
        if (!res?.ok) throw new Error(`click(${selector}) failed: ${res?.reason ?? "unknown"}`);
      }
    },

    async type(selector, text, options = {}) {
      if (realInput()) return page.locator(selector).first().pressSequentially(text, { delay: options.delay ?? 10, timeout: 20_000 });
      const current = await inAnyFrame(DOM_READ_VALUE, [selector]);
      const res = await inAnyFrame(DOM_SET_VALUE, [selector, `${current?.value ?? ""}${text}`]);
      if (!res?.ok) throw new Error(`type(${selector}) failed: ${res?.reason ?? "unknown"}`);
    },

    /** Replace a field's value outright (React-safe). */
    async fill(selector, value) {
      if (realInput()) return page.fill(selector, value, { timeout: 20_000 });
      const res = await inAnyFrame(DOM_SET_VALUE, [selector, value]);
      if (!res?.ok) throw new Error(`fill(${selector}) failed: ${res?.reason ?? "unknown"}`);
    },

    /**
     * Attach files to a file input.
     * `files` accepts Playwright-style paths, Buffers, or {name,buffer,type}.
     * Real-input transports use Playwright's setInputFiles; otherwise the files
     * are built in-page (File + DataTransfer), which needs no CDP at all.
     */
    async setInputFiles(selector, files) {
      const list = await normaliseFiles(files);
      if (realInput()) {
        await page.setInputFiles(
          selector,
          list.map((f) => ({ name: f.name, mimeType: f.type, buffer: Buffer.from(f.base64, "base64") })),
        );
        return { ok: true, count: list.length, via: "playwright" };
      }
      const res = await inAnyFrame2(DOM_SET_FILES, [selector, list.map(({ name, type, base64 }) => ({ name, type, base64 }))]);
      if (!res?.ok) throw new Error(`setInputFiles(${selector}) failed: ${res?.reason ?? "unknown"}`);
      return { ...res, via: "dom" };
    },

    /** Drop files onto a dropzone (antd Upload.Dragger and friends). */
    async dropFiles(selector, files) {
      const list = await normaliseFiles(files);
      const res = await inAnyFrame2(DOM_DROP_FILES, [selector, list.map(({ name, type, base64 }) => ({ name, type, base64 }))]);
      if (!res?.ok) throw new Error(`dropFiles(${selector}) failed: ${res?.reason ?? "unknown"}`);
      return res;
    },

    /**
     * Drag one element onto another. Emits BOTH a pointer-event drag (dnd-kit,
     * react-dnd, sortable.js) and, when the source is draggable, the HTML5 drag
     * sequence — real-input transports use Playwright's native dragAndDrop.
     */
    async dragAndDrop(fromSelector, toSelector, { steps = 8 } = {}) {
      if (realInput()) {
        await page.dragAndDrop(fromSelector, toSelector, { timeout: 20_000 });
        return { ok: true, via: "playwright" };
      }
      const res = await inAnyFrame2(DOM_DRAG, [fromSelector, toSelector, steps], { extraFirst: false });
      if (!res?.ok) throw new Error(`dragAndDrop(${fromSelector} → ${toSelector}) failed: ${res?.reason ?? "unknown"}`);
      return { ...res, via: "dom" };
    },

    /** Count matches including shadow roots and frames (diagnostics/tests). */
    async deepCount(selector) {
      const res = await inAnyFrame(DOM_COUNT, [selector]);
      return res?.count ?? 0;
    },

    waitForSelector: (selector, options = {}) => {
      const state = options.visible ? "visible" : options.hidden ? "hidden" : "attached";
      return page.waitForSelector(selector, { state, timeout: options.timeout ?? 20_000 });
    },
    waitForFunction: (fn, options = {}) => page.waitForFunction(fn, undefined, options),
    // NEVER resize by default: on an attached real browser this becomes
    // Emulation.setDeviceMetricsOverride, which pins the viewport and leaves a
    // blank strip beside the operator's actual window. Opt in with BC_VIEWPORT=1.
    setViewport: async ({ width, height }) => {
      if (process.env.BC_VIEWPORT !== "1") return { skipped: true, reason: "attached-browser-keeps-its-own-size" };
      return page.setViewportSize({ width, height });
    },
    viewportInfo: () =>
      page.evaluate(() => ({ inner: [window.innerWidth, window.innerHeight], outer: [window.outerWidth, window.outerHeight], dpr: window.devicePixelRatio })),
    /**
     * DANGEROUS over the extension transport: Page.addScriptToEvaluateOnNew-
     * Document routed through chrome.debugger kills the Chrome browser process
     * (reproduced: test/crash-repro.mjs addInitScript → EXC_BREAKPOINT on
     * CrBrowserMain). Refuse by default there; re-run the code after each
     * navigation instead, or opt in with BC_ALLOW_INIT_SCRIPT=1.
     */
    evaluateOnNewDocument: async (fn, ...args) => {
      const extension = (capabilities.mode ?? process.env.BC_MODE ?? "extension") === "extension";
      if (extension && process.env.BC_ALLOW_INIT_SCRIPT !== "1") {
        return { skipped: true, reason: "addInitScript crashes Chrome over the extension transport (see src/page.mjs)" };
      }
      return page.addInitScript({ content: `(${fn.toString()})(...${JSON.stringify(args)})` });
    },
    // Playwright returns the Buffer; when a path is given, hand back the path so
    // callers can record it (puppeteer behaviour).
    screenshot: async (options = {}) => {
      const buffer = await page.screenshot({ scale: "css", type: "png", ...options });
      return options.path ?? buffer;
    },
    createCDPSession: async () => {
      try {
        return await page.context().newCDPSession(page);
      } catch {
        return { send: async () => ({}), detach: async () => {} };
      }
    },
    keyboard: {
      press: async (key) => {
        if (realInput()) return page.keyboard.press(key);
        const res = await inAnyFrame(DOM_KEY, [null, key]);
        if (!res?.ok) throw new Error(`press(${key}) failed: ${res?.reason ?? "unknown"}`);
      },
      type: async (text) => {
        if (realInput()) return page.keyboard.type(text);
        const id = await page.evaluate(() => document.activeElement?.id ?? null);
        if (!id) throw new Error("keyboard.type without a focused element");
        await overrides.type(`#${id}`, text);
      },
    },
    /** Which input path is active — worth printing in test reports. */
    inputMode: () => (realInput() ? "real-input" : "dom-input"),
    capabilities: () => capabilities,
  };

  return new Proxy(page, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Block a URL pattern (e.g. keep Google Translate from rewriting the UI). */
export async function blockUrls(page, pattern) {
  await page.route(pattern, (route) => route.abort()).catch(() => {});
}
