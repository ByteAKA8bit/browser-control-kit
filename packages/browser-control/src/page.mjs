// Page control that survives a BACKGROUND tab.
// Non-goal: a general puppeteer polyfill — only the surface below is emulated
// (multi-arg evaluate, waitForSelector({visible}), setViewport, evaluateOnNewDocument).
// Invariant: the input path comes from capabilities, never from guessing.
//
// The extension transport can neither foreground a tab nor enable
// Emulation.setFocusEmulationEnabled, so visibilityState=hidden and real input times out:
//
//   focusEmulation available (cdp) → real Playwright input
//   otherwise                      → DOM input from ./dom-input.mjs (actionability,
//                                    hit testing, open shadow roots), retried in
//                                    every frame so iframes work too
import { DEEP_QUERY_ALL, DOM_CLICK, DOM_COUNT, DOM_KEY, DOM_READ_VALUE, DOM_SET_VALUE } from "./dom-input.mjs";
import { DOM_DRAG, DOM_DROP_FILES, DOM_MAKE_TRANSFER, DOM_SET_FILES } from "./transfer.mjs";
import { asUpload } from "./fixtures.mjs";

const DEEP_SRC = DEEP_QUERY_ALL.toString();

// ── Navigation lock ────────────────────────────────────────────────────────
// 2026-09-05: concurrent page.goto() across tabs over the EXTENSION transport crashes
// the Chrome browser process (EXC_BREAKPOINT on CrBrowserMain; repro BC_CRASH_REPRO=1
// scripts/crash-repro.mjs, or pool.test "navigates several tabs in parallel") → only
// navigation is serialised, process-wide; everything else parallelises fine.
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

  /**
   * Run a DOM primitive in the main frame, then child frames, until one hits.
   * Stringified primitives cannot import: helper sources are appended POSITIONALLY, deepSrc then transferSrc (DOM_SET_FILES/DOM_DROP_FILES), so their parameter lists and this order move together.
   */
  const inAnyFrame = (fn, args) => {
    const needsTransfer = fn === DOM_SET_FILES || fn === DOM_DROP_FILES;
    return inAnyFrameRaw(fn, needsTransfer ? [...args, DEEP_SRC, DOM_MAKE_TRANSFER.toString()] : [...args, DEEP_SRC]);
  };

  /**
   * The frame a selector actually lives in — main frame first, then the others,
   * polled until `timeoutMs`. Playwright's page.click only ever searches the
   * main frame, so on the real-input path a form inside an iframe (every online
   * spreadsheet, every payment widget) was unreachable while the DOM path
   * found it. 2026-10-06: measured against a srcdoc iframe, page.click timed
   * out at 15 s where frame.click worked.
   */
  const frameFor = async (selector, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const frame of [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())]) {
        try {
          if (await frame.$(selector)) return frame;
        } catch {} // a frame can navigate out from under the query: try the next one
      }
      if (Date.now() >= deadline) return page.mainFrame(); // let the caller's own wait raise the error
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  /** Every frame's answer, not the first hit: counting must not stop at zero. */
  const inAnyFrameAll = async (fn, args) => {
    const payload = { src: fn.toString(), args: [...args, DEEP_SRC] };
    const out = [];
    for (const frame of [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())]) {
      out.push(await frame.evaluate(applyInPage, payload).catch(() => null)); // a frame may be gone or cross-origin-detached
    }
    return out;
  };

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
      // "not-found" means "try the next frame"; anything else is a real failure.
      if (res && res.reason !== "not-found") last = res;
      else if (last.reason === "no-frames") last = res;
    }
    return last;
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
    // Reads scope to the frame that has the element too: an agent that can click
    // a cell inside an iframe but cannot read it back is half a tool.
    $eval: async (selector, fn, ...args) => {
      const scope = await frameFor(selector, 5_000);
      return args.length <= 1 ? scope.$eval(selector, fn, args[0]) : scope.$eval(selector, applyInPageEl, { src: fn.toString(), args });
    },
    $$eval: async (selector, fn, ...args) => {
      const scope = await frameFor(selector, 5_000);
      return args.length <= 1 ? scope.$$eval(selector, fn, args[0]) : scope.$$eval(selector, applyInPageAll, { src: fn.toString(), args });
    },

    /**
     * 2026-10-06, measured: a field that re-renders its list on blur (an ordinary
     * pattern) replaces the node between mousedown and mouseup, so the `click`
     * lands on an ancestor, the app's handler never runs, and Playwright reports
     * success — 0/8 landed. So the target is instrumented and the answer is
     * honest: `verified` says whether the element itself saw the click.
     * A second real click is NEVER dispatched on a guess — on a ticket or a
     * payment that buys two — so only the unambiguous case (element still there,
     * no pointer event at all) is retried, through the DOM primitive.
     * @returns {Promise<{ ok: boolean, via: string, verified: boolean, reason?: string }>}
     */
    async click(selector, options = {}) {
      if (realInput()) {
        const scope = await frameFor(selector, options.timeout ?? 15_000);
        const handle = await scope.$(selector);
        await handle?.evaluate((el) => {
          el.__bcSaw = { down: false, click: false };
          el.addEventListener("pointerdown", () => {
            el.__bcSaw.down = true;
          }, { capture: true, once: true });
          el.addEventListener("click", () => {
            el.__bcSaw.click = true;
          }, { capture: true, once: true });
        });
        await scope.click(selector, { timeout: 15_000, ...options });
        // A handle that throws is an element the click itself removed: a hit.
        const saw = await handle
          ?.evaluate((el) => {
            const seen = { ...el.__bcSaw, connected: el.isConnected };
            delete el.__bcSaw; // leave no trace of ours in the operator's page
            return seen;
          })
          .catch(() => ({ down: true, click: true, connected: false }));
        if (saw?.click !== false) return { ok: true, via: "playwright", verified: true };
        if (saw.down || saw.connected === false) {
          const reason = saw.down ? "the element saw the press but the click landed elsewhere" : "the element was replaced while being clicked";
          return { ok: true, via: "playwright", verified: false, reason }; // acting again could act twice
        }
        const res = await inAnyFrame(DOM_CLICK, [selector, options.nth ?? 0]);
        if (!res?.ok) throw new Error(`click(${selector}): the element received no pointer event at all, and the DOM fallback failed: ${res?.reason ?? "unknown"}`);
        return { ok: true, via: "dom-fallback", verified: true };
      }
      const clicks = options.clickCount ?? 1;
      for (let i = 0; i < clicks; i += 1) {
        const res = await inAnyFrame(DOM_CLICK, [selector, options.nth ?? 0]);
        if (!res?.ok) throw new Error(`click(${selector}) failed: ${res?.reason ?? "unknown"}`);
      }
    },

    async type(selector, text, options = {}) {
      if (realInput()) {
        const scope = await frameFor(selector);
        return scope.locator(selector).first().pressSequentially(text, { delay: options.delay ?? 10, timeout: 20_000 });
      }
      const current = await inAnyFrame(DOM_READ_VALUE, [selector]);
      const res = await inAnyFrame(DOM_SET_VALUE, [selector, `${current?.value ?? ""}${text}`]);
      if (!res?.ok) throw new Error(`type(${selector}) failed: ${res?.reason ?? "unknown"}`);
    },

    /** Replace a field's value outright (React-safe). */
    async fill(selector, value) {
      if (realInput()) {
        const scope = await frameFor(selector);
        return scope.fill(selector, value, { timeout: 20_000 });
      }
      const res = await inAnyFrame(DOM_SET_VALUE, [selector, value]);
      if (!res?.ok) throw new Error(`fill(${selector}) failed: ${res?.reason ?? "unknown"}`);
    },

    /**
     * Attach files to a file input; `files` takes paths, Buffers or {name,buffer,type}.
     * Without real input the File + DataTransfer are built in-page, needing no CDP.
     */
    async setInputFiles(selector, files) {
      const list = await normaliseFiles(files);
      if (realInput()) {
        const scope = await frameFor(selector);
        await scope.setInputFiles(
          selector,
          list.map((f) => ({ name: f.name, mimeType: f.type, buffer: Buffer.from(f.base64, "base64") })),
        );
        return { ok: true, count: list.length, via: "playwright" };
      }
      const res = await inAnyFrame(DOM_SET_FILES, [selector, list.map(({ name, type, base64 }) => ({ name, type, base64 }))]);
      if (!res?.ok) throw new Error(`setInputFiles(${selector}) failed: ${res?.reason ?? "unknown"}`);
      return { ...res, via: "dom" };
    },

    /** Drop files onto a dropzone (antd Upload.Dragger and friends). */
    async dropFiles(selector, files) {
      const list = await normaliseFiles(files);
      const res = await inAnyFrame(DOM_DROP_FILES, [selector, list.map(({ name, type, base64 }) => ({ name, type, base64 }))]);
      if (!res?.ok) throw new Error(`dropFiles(${selector}) failed: ${res?.reason ?? "unknown"}`);
      return res;
    },

    /**
     * Drag one element onto another: pointer-event drag (dnd-kit, react-dnd, sortable.js)
     * plus the HTML5 sequence when the source is draggable.
     */
    async dragAndDrop(fromSelector, toSelector, { steps = 8 } = {}) {
      if (realInput()) {
        const scope = await frameFor(fromSelector);
        await scope.dragAndDrop(fromSelector, toSelector, { timeout: 20_000 });
        return { ok: true, via: "playwright" };
      }
      const res = await inAnyFrame(DOM_DRAG, [fromSelector, toSelector, steps]);
      if (!res?.ok) throw new Error(`dragAndDrop(${fromSelector} → ${toSelector}) failed: ${res?.reason ?? "unknown"}`);
      return { ...res, via: "dom" };
    },

    /** Count matches across shadow roots AND every frame — summed, because a hit
     * in the main frame used to end the search and hide the ones in iframes. */
    async deepCount(selector) {
      const counts = await inAnyFrameAll(DOM_COUNT, [selector]);
      return counts.reduce((sum, res) => sum + (res?.count ?? 0), 0);
    },

    /** Waits in whichever frame the element shows up in, not just the main one. */
    waitForSelector: async (selector, options = {}) => {
      const state = options.visible ? "visible" : options.hidden ? "hidden" : "attached";
      const timeout = options.timeout ?? 20_000;
      const scope = await frameFor(selector, timeout);
      return scope.waitForSelector(selector, { state, timeout });
    },
    /** puppeteer order (fn, options, arg); a null options used to crash inside Playwright. */
    waitForFunction: (fn, options, arg) => page.waitForFunction(fn, arg, options ?? {}),
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
     * DANGEROUS over the extension transport: Page.addScriptToEvaluateOnNewDocument routed
     * through chrome.debugger kills the Chrome browser process (repro BC_CRASH_REPRO=1
     * scripts/crash-repro.mjs addInitScript → EXC_BREAKPOINT on CrBrowserMain). Refused there
     * by default; re-run the code after each navigation, or opt in with BC_ALLOW_INIT_SCRIPT=1.
     */
    evaluateOnNewDocument: async (fn, ...args) => {
      const extension = (capabilities.mode ?? process.env.BC_MODE ?? "extension") === "extension";
      if (extension && process.env.BC_ALLOW_INIT_SCRIPT !== "1") {
        return { skipped: true, reason: "addInitScript crashes Chrome over the extension transport (see src/page.mjs)" };
      }
      return page.addInitScript({ content: `(${fn.toString()})(...${JSON.stringify(args)})` });
    },
    // Return the path when one is given (puppeteer behaviour), else the Buffer.
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
    // down/up/insertText and friends only exist on Playwright's keyboard, and a
    // game or a hotkey needs them, so only press/type are intercepted and
    // everything else falls through to the real one.
    keyboard: new Proxy(page.keyboard, {
      get(target, prop) {
        if (!realInput() && (prop === "press" || prop === "type")) {
          return prop === "press"
            ? async (key) => {
                const res = await inAnyFrame(DOM_KEY, [null, key]);
                if (!res?.ok) throw new Error(`press(${key}) failed: ${res?.reason ?? "unknown"}`);
              }
            : async (text) => {
                const id = await page.evaluate(() => document.activeElement?.id ?? null);
                if (!id) throw new Error("keyboard.type without a focused element");
                await overrides.type(`#${id}`, text);
              };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
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
