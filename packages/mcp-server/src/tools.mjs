// The agent-facing surface: one browser session, pages addressed by NAME, and
// twelve tools.
//
// Non-goal: tab handles. Agents leak handles, and the earlier version spent
// three tool descriptions policing them; instead `as` names a page, `on`
// returns to a named page, and omitting both lands on the scratch page, the
// one page every unnamed call shares. Tab lifetime belongs to browser-control's
// TabGuard — named pinned, unnamed recycled, idle reclaimed — so no tool here
// opens or closes an individual tab. The browser itself is the agent's call:
// `browser_release` hands it back, and no timer guesses on the agent's behalf.
// browser-control (and playwright-core) is imported lazily in #connect(), so
// merely listing tools costs nothing but a process.
import path from "node:path";
import { Jobs } from "./jobs.mjs";
import { SCRIPT_DESCRIPTION, runScript } from "./script.mjs";

const ATTACH_TIMEOUT_MS = () => Number(process.env.BC_MCP_ATTACH_TIMEOUT_MS ?? 60_000);
const TEXT_LIMIT = () => Number(process.env.BC_MCP_TEXT_LIMIT ?? 20_000);
const WAIT_TIMEOUT_MS = () => Number(process.env.BC_MCP_WAIT_MS ?? 20_000);
// Off by default: only the agent knows whether a long task still needs the browser.
// BC_MCP_IDLE_MS is an operator's opt-in backstop, never a default guess.
const IDLE_MS = () => Number(process.env.BC_MCP_IDLE_MS ?? 0);
// Nothing to tune here on purpose: TabGuard already sizes its own windows.

/**
 * The tab group's name: `BC_CLIENT_NAME`, else the directory this server was
 * started in. Chrome shows it on the group, so many agents map to projects.
 */
export function clientName() {
  const explicit = process.env.BC_CLIENT_NAME?.trim();
  if (explicit) return explicit;
  return path.basename(process.cwd() || "") || "browser-control-mcp";
}

/** Shown by a client before the first tool call (MCP `initialize.instructions`). */
export const INSTRUCTIONS =
  "Pages are addressed by name, never by handle. Pass `as` to browser_navigate to keep that page under a name, and `on` to come back to it from any later call; leave both out and you get the scratch page, the single page every unnamed call shares. Tabs need no closing, and the browser is not closed for being quiet — a long task may still need it. You decide: call browser_release when your browser work is done (or `handBack()` at the end of a browser_script); it hands back this session's tabs and the extension relay page, keeps `state` and jobs, and the next call attaches again. browser_surfaces lists what is named right now. For anything longer than one step, prefer browser_script: it runs a whole flow in one call against this same session, and `state` inside it survives between calls.";

/** Reject instead of hanging forever when the operator never approves a connection. */
function withTimeout(promise, ms, what) {
  if (!(ms > 0)) return promise;
  let timer;
  const alarm = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms (raise BC_MCP_ATTACH_TIMEOUT_MS, or check Chrome and the extension token)`)), ms);
  });
  return Promise.race([promise, alarm]).finally(() => clearTimeout(timer));
}

const flatten = (err) => String(err?.message ?? err).split("\n")[0];

/**
 * One attached browser per server process, created on the first tool call and
 * re-created if the browser goes away. It keeps no page state of its own:
 * every call resolves through the guard's name table, so a page that closed
 * underneath us comes back as a fresh one under the same name.
 */
export class Session {
  #live = null;
  #connecting = null;
  #controlPage = null;
  #wrapped = new WeakMap(); // raw page → controlPage proxy, so a call does not rebuild one
  #evicted = 0; // last seen guard.stats.surfacesEvicted, to report only what is new
  #busy = 0; // tool calls in flight
  #idleMs; // 0 (the default) means the agent decides when to hand back
  #idleTimer = null;
  #releasing = null; // a reattach must wait until the old browser has finished closing
  #connectImpl; // tests can attach a fake instead of a browser
  /** Script state outlives a release; only the client ending clears it. */
  scriptState = {};
  /** Named background work started by browser_script; see src/jobs.mjs. */
  jobs = new Jobs();
  // Aborted once, when the client is gone: an in-flight script stops waiting
  // instead of driving a browser nobody is listening to.
  #shutdown = new AbortController();

  constructor({ idleMs = IDLE_MS(), connect } = {}) {
    this.#idleMs = idleMs;
    this.#connectImpl = connect;
  }

  /** Ends with the client: `browser_script` hands this to every body it runs. */
  get signal() {
    return this.#shutdown.signal;
  }

  /** The attach() result, connecting at most once at a time. */
  async browser() {
    if (this.#live?.browser.isConnected()) return this.#live;
    if (this.#releasing) await this.#releasing; // never create tabs while the old connection is still closing
    this.#live = null;
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #connect() {
    const name = clientName();
    // Lazy on purpose: this is the line that pulls in playwright-core.
    const live = await withTimeout(
      this.#connectImpl
        ? this.#connectImpl(name)
        : import("browser-control").then(({ attach }) => attach({ clientName: name })),
      ATTACH_TIMEOUT_MS(),
      "attach()",
    );
    const { controlPage } = await import("browser-control");
    this.#controlPage = controlPage;
    this.#evicted = live.tabs?.stats?.surfacesEvicted ?? 0;
    live.scriptState = this.scriptState;
    live.jobs = this.jobs;
    this.#live = live;
    return live;
  }

  /** The attached session itself, for a script that wants more than one page. */
  async live() {
    const live = await this.browser();
    this.#guard(live); // named pages are the whole model; without a guard there is none
    live.scriptState ??= this.scriptState;
    live.jobs ??= this.jobs; // one job table per session: a reattach must not orphan a running loop
    return live;
  }

  /** Tool calls in flight, including the one asking: a release must not race a live call. */
  get busy() {
    return this.#busy;
  }

  /** Mark a tool call in flight; the returned function ends it and re-arms the idle release. */
  activity() {
    this.#busy += 1;
    this.#disarmIdle();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#busy = Math.max(0, this.#busy - 1);
      if (this.#busy === 0) this.#armIdle();
    };
  }

  /**
   * Give the browser back without ending the session: tabs and the relay's page
   * go, `state` and jobs stay, and the next tool call attaches again. Callers
   * check first that no call or named job still needs it (handBack, idle timer).
   */
  async release() {
    this.#disarmIdle();
    const live = this.#live;
    if (!live) return false;
    this.#live = null;
    if (live.scriptState) this.scriptState = live.scriptState;
    const closing = (async () => {
      try {
        await live.browser?.close?.(); // guardBrowser returns the tabs and connect.html
      } catch {} // the browser may already be gone; the next call reattaches
    })();
    this.#releasing = closing;
    try {
      await closing;
    } finally {
      if (this.#releasing === closing) this.#releasing = null;
    }
    return true;
  }

  /**
   * The agent's explicit hand-back: refuse while another call or a named job is
   * still using the browser, otherwise release it. Returns false when nothing
   * was attached.
   */
  async handBack() {
    if (this.#busy > 1) throw new Error("another tool call is still using this browser; hand it back after that call returns");
    const running = this.jobs.list().filter((job) => job.state === "running").map((job) => job.name);
    if (running.length) {
      throw new Error(
        `named job${running.length > 1 ? "s" : ""} still running: ${running.join(", ")}; cancel with browser_script { code: "jobs.cancel('${running[0]}')" } first, or leave the browser attached`,
      );
    }
    return this.release();
  }

  #armIdle() {
    this.#disarmIdle();
    if (this.#shutdown.signal.aborted || !this.#live || !(this.#idleMs > 0)) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      // A job outlives calls on purpose; a browser with one running is not idle.
      if (this.#busy > 0 || this.jobs.hasRunning()) return this.#armIdle();
      void this.release();
    }, this.#idleMs);
    this.#idleTimer.unref?.(); // never hold the process open just to give tabs back
  }

  #disarmIdle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  /** Wrap a raw page the way every tool does, reusing the proxy a page already has. */
  wrap(raw) {
    return this.#wrap(raw, this.#live);
  }

  /**
   * The page a call should act on, wrapped by controlPage: `as` binds or
   * re-binds a name, `on` must already exist, neither means the scratch page.
   * Never opens or closes anything itself.
   */
  async target({ as, on } = {}) {
    const live = await this.browser();
    const guard = this.#guard(live);
    // Trimmed because that is what the guard keys on; a blank name is the guard's error to raise.
    const name = (as ?? on)?.trim() ?? null;
    if (name && as === undefined) this.#assertNamed(guard, name);
    const raw = await guard.surface(name ?? undefined);
    return { page: this.#wrap(raw, live), surface: name };
  }

  /** What is bound right now, and the reassurance that it needs no cleanup. */
  async surfaces() {
    const live = await this.browser();
    const guard = this.#guard(live);
    return {
      surfaces: guard.surfaces(),
      scratch: guard.report().scratch,
      note: "Tabs need no closing: named pages are held while you use them, the scratch page is reused by every unnamed call, and unnamed tabs are reclaimed after a quiet spell. The browser itself stays attached until you call browser_release or your client disconnects.",
    };
  }

  async status() {
    const { transportSupport, DEFAULT_MODE } = await import("browser-control");
    const support = { mode: DEFAULT_MODE, ...transportSupport() };
    const live = await this.browser();
    return {
      attached: true,
      client: clientName(),
      mode: live.mode,
      capabilities: live.capabilities,
      tabGuard: live.tabs?.report() ?? { enforced: false, reason: "BC_TAB_GUARD=0" },
      idle: { afterMs: this.#idleMs, enabled: this.#idleMs > 0, busy: this.#busy },
      support,
    };
  }

  /** What status() reports when there is no browser to attach to. */
  async offlineStatus(err) {
    const { transportSupport, DEFAULT_MODE } = await import("browser-control");
    return { attached: false, client: clientName(), reason: flatten(err), mode: DEFAULT_MODE, support: transportSupport() };
  }

  /** Named pages are the guard's table; without a guard there is no table. */
  #guard(live) {
    if (!live.tabs) {
      throw new Error("named pages need the tab guard, and BC_TAB_GUARD=0 turned it off: unset it and restart this server");
    }
    return live.tabs;
  }

  #assertNamed(guard, name) {
    const names = guard.surfaces().map((surface) => surface.name);
    if (names.includes(name)) return;
    throw new Error(
      names.length
        ? `no page is named "${name}"; these are: ${names.join(", ")}`
        : `no page is named "${name}"; none are named yet — navigate with as:"${name}" first`,
    );
  }

  /**
   * Evictions not yet reported. Consumed once per tool call by callTool, never
   * by target(): losing a named surface MUST stay visible, and a run() that
   * forgot to pass `evicted` through used to swallow the notice.
   */
  freshEvictions() {
    const total = this.#live?.tabs?.stats?.surfacesEvicted ?? 0;
    const fresh = total - this.#evicted;
    this.#evicted = total;
    return fresh > 0 ? fresh : 0;
  }

  #wrap(raw, live) {
    let page = this.#wrapped.get(raw);
    if (!page) {
      page = this.#controlPage(raw, live.capabilities);
      this.#wrapped.set(raw, page);
    }
    return page;
  }

  /** Hand the browser back and end the session (client gone). */
  async close() {
    this.#disarmIdle();
    await this.#releasing; // a release already in flight must finish its tab hand-back
    const live = this.#live;
    this.#live = null;
    this.#shutdown.abort(new Error("the MCP client disconnected")); // an in-flight script stops sleeping here
    this.jobs.cancelAll(); // a loop must not keep driving a browser nobody is watching
    try {
      await live?.browser?.close?.(); // the browser may already be gone
    } catch {} // teardown must finish even when the bridge is already down
  }
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

/**
 * Marks content a tool already built as MCP content. A marker class rather
 * than sniffing `result?.content`, because browser_evaluate returns whatever
 * the page says: a page evaluating to `({content:[…]})` could forge an image
 * or send content malformed enough to drop the connection.
 */
class Payload {
  constructor(content) {
    this.content = content;
  }
}

/**
 * Losing a named page MUST stay visible, so a result appends what was evicted
 * as its own block — a screenshot's payload is not ours to rewrite — and says
 * nothing when nothing was lost.
 */
const withEvictions = (payload, evicted) =>
  evicted
    ? {
        ...payload,
        content: [
          ...payload.content,
          { type: "text", text: `surfacesEvicted: ${evicted} — that many least-recently-used names were dropped and their pages reused; navigate again with \`as\` to bind a name back.` },
        ],
      }
    : payload;

/** `on` is the same parameter on every acting tool, so it is written once. */
const ON = { type: "string", description: "Name of a page you kept with `as`; omit for the scratch page" };

/**
 * Tool definitions. `run(args, session)` returns a value (wrapped as text) or
 * a `new Payload([...])`; throwing becomes isError, never a transport error.
 */
export const TOOLS = [
  {
    name: "browser_status",
    description: "Report the transport, its capabilities, what the page guard is holding, and whether an idle release is configured.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_args, session) {
      try {
        return await session.status();
      } catch (err) {
        // Status is a diagnostic: "cannot attach, here is why" is the answer.
        return session.offlineStatus(err);
      }
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate to a URL. Give `as` a name to keep that page and return to it later with `on`; omit both and you get the scratch page.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL" },
        as: { type: "string", description: "Keep this page under this name" },
        on: ON,
        waitUntil: { type: "string", enum: ["commit", "domcontentloaded", "load", "networkidle"] },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run({ url, as, on, waitUntil }, session) {
      const { page, surface } = await session.target({ as, on });
      const response = await page.goto(url, waitUntil ? { waitUntil } : {});
      return {
        surface,
        url: page.url(),
        title: await page.title(),
        status: response?.status() ?? null,
      };
    },
  },
  {
    name: "browser_click",
    description: "Click the first element matching a selector.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector" }, on: ON },
      required: ["selector"],
      additionalProperties: false,
    },
    async run({ selector, on }, session) {
      const { page } = await session.target({ on });
      const result = await page.click(selector);
      // An unverified click MUST reach the agent: the page may simply not have
      // acted, and only the caller knows whether clicking again is safe.
      if (result?.verified === false) return `clicked ${selector}, but ${result.reason}. Check the page before clicking again: repeating it may act twice.`;
      return `clicked ${selector}${result?.via === "dom-fallback" ? " (the real click went nowhere, so this was a DOM-level click)" : ""}`;
    },
  },
  {
    name: "browser_type",
    description: "Append text to a field.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, text: { type: "string" }, on: ON },
      required: ["selector", "text"],
      additionalProperties: false,
    },
    async run({ selector, text: value, on }, session) {
      const { page } = await session.target({ on });
      await page.type(selector, value);
      return `typed into ${selector}`;
    },
  },
  {
    name: "browser_fill",
    description: "Replace a field's value.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, value: { type: "string" }, on: ON },
      required: ["selector", "value"],
      additionalProperties: false,
    },
    async run({ selector, value, on }, session) {
      const { page } = await session.target({ on });
      await page.fill(selector, value);
      return `filled ${selector}`;
    },
  },
  {
    name: "browser_text",
    description: "Read visible text of the page or one element.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "Defaults to the whole document" }, on: ON },
      required: [],
      additionalProperties: false,
    },
    async run({ selector, on }, session) {
      const { page } = await session.target({ on });
      const value = await page.evaluate((sel) => {
        const el = sel ? document.querySelector(sel) : document.body;
        return el ? el.innerText : null;
      }, selector ?? null);
      if (value === null) throw new Error(`browser_text found no element for ${selector}`);
      const limit = TEXT_LIMIT();
      return value.length > limit ? `${value.slice(0, limit)}\n…[truncated at BC_MCP_TEXT_LIMIT=${limit} characters]` : value;
    },
  },
  {
    name: "browser_evaluate",
    description: "Evaluate a JavaScript expression in a page.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "JavaScript expression or IIFE" }, on: ON },
      required: ["expression"],
      additionalProperties: false,
    },
    async run({ expression, on }, session) {
      const { page } = await session.target({ on });
      const value = await page.evaluate(expression);
      return value === undefined ? "undefined" : value;
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a PNG of the viewport or one element.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "Defaults to the viewport" }, on: ON },
      required: [],
      additionalProperties: false,
    },
    async run({ selector, on }, session) {
      const { page } = await session.target({ on });
      const buffer = selector ? await page.locator(selector).first().screenshot({ type: "png" }) : await page.screenshot();
      return new Payload([{ type: "image", data: buffer.toString("base64"), mimeType: "image/png" }]);
    },
  },
  {
    name: "browser_wait_for",
    description: "Wait for a selector to reach a state.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
        timeoutMs: { type: "integer" },
        on: ON,
      },
      required: ["selector"],
      additionalProperties: false,
    },
    async run({ selector, state = "visible", timeoutMs, on }, session) {
      const { page } = await session.target({ on });
      await page.locator(selector).first().waitFor({ state, timeout: timeoutMs ?? WAIT_TIMEOUT_MS() });
      return `${selector} is ${state}`;
    },
  },
  {
    name: "browser_surfaces",
    description: "List the pages you have named, with their URL and how long each has been idle, plus the scratch page. Tabs need no closing; the browser stays attached until you call browser_release.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    run: (_args, session) => session.surfaces(),
  },
  {
    name: "browser_release",
    description:
      "Hand the whole browser back when your browser work is done: closes this session's tabs and the extension relay page, keeps `state` and the job table, and the next call attaches again. This is the only early release — a quiet browser is never closed on a timer unless the operator set BC_MCP_IDLE_MS. Refused while a named job is still running.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_args, session) {
      const released = await session.handBack();
      return released
        ? { released: true, note: "this session's tabs and relay page are gone; `state` and the job table stay, and the next call attaches again" }
        : { released: false, note: "no browser was attached; nothing to release" };
    },
  },
  {
    name: "browser_script",
    description: SCRIPT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Async function body. `await` freely; `return` the result" },
        on: { type: "string", description: "Name of the page `page` should be; omit for the scratch page" },
        as: { type: "string", description: "Keep `page` under this name for later calls" },
        timeoutMs: { type: "number", description: "Ceiling for the whole body (default BC_MCP_SCRIPT_MS, 120000)" },
      },
      required: ["code"],
      additionalProperties: false,
    },
    async run({ code, on, as, timeoutMs }, session) {
      const { page } = await session.target({ on, as });
      const live = await session.live();
      return new Payload(await runScript({ code, timeoutMs, page, live, wrap: (raw) => session.wrap(raw), signal: session.signal, handBack: () => session.handBack() }));
    },
  },
];

/** What tools/list returns: the schemas, without the handlers. */
export const toolSpecs = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Thrown for genuine protocol-level argument mistakes (JSON-RPC -32602). */
export class InvalidParams extends Error {}

/** Minimal JSON-Schema enforcement: presence and primitive type, nothing clever. */
function validate(tool, args) {
  for (const key of tool.inputSchema.required) {
    if (args[key] === undefined) throw new InvalidParams(`${tool.name} requires "${key}"`);
  }
  for (const [key, value] of Object.entries(args)) {
    // hasOwn, because inherited "constructor"/"toString" used to be read off
    // Object.prototype and reported as a parameter of the wrong type.
    if (!Object.hasOwn(tool.inputSchema.properties, key)) throw new InvalidParams(`${tool.name} has no parameter "${key}"`);
    const schema = tool.inputSchema.properties[key];
    const wanted = schema.type === "integer" ? "an integer" : `a ${schema.type}`;
    const ok = schema.type === "integer" ? Number.isInteger(value) : typeof value === schema.type;
    if (!ok) throw new InvalidParams(`${tool.name}.${key} must be ${wanted}`);
    if (schema.enum && !schema.enum.includes(value)) throw new InvalidParams(`${tool.name}.${key} must be one of ${schema.enum.join(", ")}`);
  }
  // A call carrying both names two different pages, and honouring `as` alone would act somewhere the client never asked for.
  if (args.as !== undefined && args.on !== undefined) throw new InvalidParams(`${tool.name} takes either "as" or "on", not both`);
}

/**
 * Run a tool. Protocol mistakes throw InvalidParams; everything else — no
 * browser, bad selector, page exploded — comes back as an isError result.
 */
export async function callTool(name, args, session) {
  const tool = byName.get(name);
  if (!tool) throw new InvalidParams(`unknown tool "${name}"`);
  validate(tool, args);
  const done = session.activity?.();
  let payload;
  try {
    const result = await tool.run(args, session);
    payload = result instanceof Payload ? { content: result.content } : text(result);
  } catch (err) {
    payload = { ...text(`${name} failed: ${flatten(err)}`), isError: true };
  } finally {
    done?.(); // only now is the browser genuinely idle
  }
  // One place consumes the eviction counter; seven tools used to drop the notice on the floor.
  return withEvictions(payload, session.freshEvictions());
}
