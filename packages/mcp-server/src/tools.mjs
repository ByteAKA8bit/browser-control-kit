// The agent-facing surface: one browser session, one active tab, twelve tools.
//
// Non-goal: opening tabs. There is deliberately NO "new tab" tool — the
// complaint this server answers is agents that open a tab per step until the
// operator's Chrome holds forty renderers. browser_navigate reuses the active
// tab and tab_select switches between tabs that already exist, so the number of
// tabs follows the work actually in flight instead of a quota. Reuse, memory
// pressure and idle reclaiming are browser-control's TabGuard; browser_status
// prints its report back so the agent can see what it is costing.
//
// browser-control — and through it playwright-core — is imported lazily inside
// #connect(), so a server that an agent has merely listed tools on costs
// nothing but a Node process.
const ATTACH_TIMEOUT_MS = () => Number(process.env.BC_MCP_ATTACH_TIMEOUT_MS ?? 60_000);
const TEXT_LIMIT = () => Number(process.env.BC_MCP_TEXT_LIMIT ?? 20_000);
const WAIT_TIMEOUT_MS = () => Number(process.env.BC_MCP_WAIT_MS ?? 20_000);
// An MCP session is single-threaded by nature: it does one thing at a time, so
// a tab that has gone quiet is the tab the next navigation should use. Recycle
// aggressively and blank early — the defaults are tuned for a long-lived agent
// session, not for a parallel crawl.
const RECYCLE_MS = () => Number(process.env.BC_TAB_RECYCLE_MS ?? 2_000);
const BLANK_MS = () => Number(process.env.BC_TAB_BLANK_MS ?? 30_000);

/** Reject instead of hanging forever when the operator never approves a connection. */
function withTimeout(promise, ms, what) {
  if (!(ms > 0)) return promise;
  let timer;
  const alarm = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms (raise BC_MCP_ATTACH_TIMEOUT_MS, or check Chrome and the extension token)`)), ms);
  });
  return Promise.race([promise, alarm]).finally(() => clearTimeout(timer));
}

/** Tabs the agent may drive: the extension's own pages are not browsing tabs. */
function ordinaryPages(context) {
  return context.pages().filter((page) => {
    const url = page.url();
    return !url.startsWith("chrome-extension://") && !url.startsWith("devtools://");
  });
}

const flatten = (err) => String(err?.message ?? err).split("\n")[0];

/**
 * One attached browser per server process, created on the first tool call that
 * needs it and re-created if the browser goes away.
 */
export class Session {
  #live = null;
  #connecting = null;
  #active = null;
  #controlPage = null;

  /** The attach() result, connecting at most once at a time. */
  async browser() {
    if (this.#live?.browser.isConnected()) return this.#live;
    this.#live = null;
    this.#active = null;
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #connect() {
    // Lazy on purpose: this is the line that pulls in playwright-core.
    const { attach, controlPage } = await import("browser-control");
    const live = await withTimeout(
      attach({ clientName: "browser-control-mcp", guard: { recycleMs: RECYCLE_MS(), blankMs: BLANK_MS() } }),
      ATTACH_TIMEOUT_MS(),
      "attach()",
    );
    this.#controlPage = controlPage;
    this.#live = live;
    return live;
  }

  /**
   * The active tab, wrapped by controlPage; sticky across tool calls.
   *
   * There is deliberately no newPage() here: this server never grows the
   * browser. It drives the tab it drove last, else a tab this session already
   * owns, else the most recently opened ordinary tab — and when there is no
   * ordinary tab at all it says so instead of conjuring one.
   */
  async page() {
    const live = await this.browser();
    if (this.#active && !this.#active.raw.isClosed()) {
      live.context.tabGuard?.touch(this.#active.raw);
      return this.#active.page;
    }
    const pages = ordinaryPages(live.context);
    const target = pages.find((page) => live.tabs?.owned.has(page)) ?? pages.at(-1);
    if (!target) throw new Error("no ordinary tab is open: open one in Chrome and retry — this server never opens tabs itself");
    return this.#adopt(target, live);
  }

  /** Point every later tool call at an existing tab. */
  async selectTab(index) {
    const live = await this.browser();
    const pages = ordinaryPages(live.context);
    const target = pages[index];
    if (!target) throw new Error(`no tab at index ${index}: there are ${pages.length} (0-${Math.max(0, pages.length - 1)})`);
    this.#adopt(target, live);
    return { index, url: target.url() };
  }

  async closeTab(index) {
    const live = await this.browser();
    const pages = ordinaryPages(live.context);
    const target = pages[index];
    if (!target) throw new Error(`no tab at index ${index}: there are ${pages.length}`);
    // Ownership: tabs that predate this session are the operator's. Closing one
    // is exactly the surprise this tool must never deliver.
    if (live.tabs?.protectedPages.has(target)) {
      throw new Error(`tab ${index} was already open before this session started, so it is the operator's and will not be closed`);
    }
    // Crash invariant: closing the last ordinary tab exits Chrome and takes the
    // automation bridge with it.
    if (pages.length <= 1) throw new Error("refusing to close the last ordinary tab: Chrome would exit and take the connection with it");
    const url = target.url();
    if (this.#active?.raw === target) this.#active = null;
    await target.close();
    return { closed: index, url, remaining: pages.length - 1 };
  }

  async tabs() {
    const live = await this.browser();
    return Promise.all(
      ordinaryPages(live.context).map(async (page, index) => ({
        index,
        active: page === this.#active?.raw,
        ours: live.tabs ? live.tabs.owned.has(page) : null, // only "ours" tabs may be closed
        url: page.url(),
        title: await page.title().catch(() => ""), // a tab mid-navigation has no title yet
      })),
    );
  }

  async status() {
    const { transportSupport, DEFAULT_MODE } = await import("browser-control");
    const support = { mode: DEFAULT_MODE, ...transportSupport() };
    const live = await this.browser();
    return {
      attached: true,
      mode: live.mode,
      capabilities: live.capabilities,
      tabGuard: live.tabs?.report() ?? { enforced: false, reason: "BC_TAB_GUARD=0" },
      activeTab: this.#active ? this.#active.raw.url() : null,
      support,
    };
  }

  /** What status() reports when there is no browser to attach to. */
  async offlineStatus(err) {
    const { transportSupport, DEFAULT_MODE } = await import("browser-control");
    return { attached: false, reason: flatten(err), mode: DEFAULT_MODE, support: transportSupport() };
  }

  #adopt(raw, live) {
    const page = this.#controlPage(raw, live.capabilities);
    this.#active = { raw, page };
    live.context.tabGuard?.touch(raw);
    return page;
  }

  /** Hand the browser back (shutdown only). */
  async close() {
    const live = this.#live;
    this.#live = null;
    this.#active = null;
    await live?.browser.close().catch(() => {}); // the browser may already be gone
  }
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

/**
 * Tool definitions. `run(args, session)` returns a value (wrapped as text) or a
 * ready-made content payload; throwing is fine — the server turns it into
 * isError, never a transport error.
 */
export const TOOLS = [
  {
    name: "browser_status",
    description:
      "Report the transport, its capabilities, and how many tabs this session is holding against its budget. Read it when a tab operation is refused.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    async run(_args, session) {
      try {
        return await session.status();
      } catch (err) {
        // Status is a diagnostic: "cannot attach, here is why" is the answer,
        // not a failure.
        return session.offlineStatus(err);
      }
    },
  },
  {
    name: "browser_navigate",
    description:
      "Navigate THIS session's active tab to a URL. There is no tool that opens a tab: this server reuses one tab for the whole session, because every extra tab is a Chrome renderer process in the operator's own browser. Switch with browser_tab_select, finish with browser_tab_close.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL" },
        waitUntil: { type: "string", enum: ["commit", "domcontentloaded", "load", "networkidle"] },
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run({ url, waitUntil }, session) {
      const page = await session.page();
      const response = await page.goto(url, waitUntil ? { waitUntil } : {});
      return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
    },
  },
  {
    name: "browser_click",
    description: "Click the first element matching a selector.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS selector" } },
      required: ["selector"],
      additionalProperties: false,
    },
    async run({ selector }, session) {
      const page = await session.page();
      await page.click(selector);
      return `clicked ${selector}`;
    },
  },
  {
    name: "browser_type",
    description: "Append text to a field.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, text: { type: "string" } },
      required: ["selector", "text"],
      additionalProperties: false,
    },
    async run({ selector, text: value }, session) {
      const page = await session.page();
      await page.type(selector, value);
      return `typed into ${selector}`;
    },
  },
  {
    name: "browser_fill",
    description: "Replace a field's value.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" }, value: { type: "string" } },
      required: ["selector", "value"],
      additionalProperties: false,
    },
    async run({ selector, value }, session) {
      const page = await session.page();
      await page.fill(selector, value);
      return `filled ${selector}`;
    },
  },
  {
    name: "browser_text",
    description: "Read visible text of the page or one element.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "Defaults to the whole document" } },
      required: [],
      additionalProperties: false,
    },
    async run({ selector }, session) {
      const page = await session.page();
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
    description: "Evaluate a JavaScript expression in the active tab.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "JavaScript expression or IIFE" } },
      required: ["expression"],
      additionalProperties: false,
    },
    async run({ expression }, session) {
      const page = await session.page();
      const value = await page.evaluate(expression);
      return value === undefined ? "undefined" : value;
    },
  },
  {
    name: "browser_screenshot",
    description: "Capture a PNG of the viewport or one element.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "Defaults to the viewport" } },
      required: [],
      additionalProperties: false,
    },
    async run({ selector }, session) {
      const page = await session.page();
      const buffer = selector ? await page.locator(selector).first().screenshot({ type: "png" }) : await page.screenshot();
      return { content: [{ type: "image", data: buffer.toString("base64"), mimeType: "image/png" }] };
    },
  },
  {
    name: "browser_tabs",
    description:
      "List the tabs this session can see, with their index and whether this session owns them. Tabs the operator opened are theirs: read them, never close them.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    run: (_args, session) => session.tabs(),
  },
  {
    name: "browser_tab_select",
    description:
      "Make an existing tab the active one for the calls that follow. This is how you move between pages; the session will not open a second tab for you.",
    inputSchema: {
      type: "object",
      properties: { index: { type: "integer", description: "Index from browser_tabs" } },
      required: ["index"],
      additionalProperties: false,
    },
    run: ({ index }, session) => session.selectTab(index),
  },
  {
    name: "browser_tab_close",
    description:
      "Close a tab this session opened, as soon as you are done with it. Idle tabs are blanked and reclaimed automatically, but closing promptly is what keeps the operator's Chrome small.",
    inputSchema: {
      type: "object",
      properties: { index: { type: "integer" } },
      required: ["index"],
      additionalProperties: false,
    },
    run: ({ index }, session) => session.closeTab(index),
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
      },
      required: ["selector"],
      additionalProperties: false,
    },
    async run({ selector, state = "visible", timeoutMs }, session) {
      const page = await session.page();
      await page.locator(selector).first().waitFor({ state, timeout: timeoutMs ?? WAIT_TIMEOUT_MS() });
      return `${selector} is ${state}`;
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
    const schema = tool.inputSchema.properties[key];
    if (!schema) throw new InvalidParams(`${tool.name} has no parameter "${key}"`);
    const kind = schema.type === "integer" ? "number" : schema.type;
    if (typeof value !== kind) throw new InvalidParams(`${tool.name}.${key} must be a ${schema.type}`);
    if (schema.enum && !schema.enum.includes(value)) throw new InvalidParams(`${tool.name}.${key} must be one of ${schema.enum.join(", ")}`);
  }
}

/**
 * Run a tool. Protocol mistakes throw InvalidParams; everything else — no
 * browser, bad selector, page exploded — comes back as an isError result,
 * because a failing page is not a broken connection.
 * @returns {Promise<{ content: object[], isError?: true }>}
 */
export async function callTool(name, args, session) {
  const tool = byName.get(name);
  if (!tool) throw new InvalidParams(`unknown tool "${name}"`);
  validate(tool, args);
  try {
    const result = await tool.run(args, session);
    return result?.content ? result : text(result);
  } catch (err) {
    return { ...text(`${name} failed: ${flatten(err)}`), isError: true };
  }
}
