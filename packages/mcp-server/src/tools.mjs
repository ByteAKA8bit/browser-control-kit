// The agent-facing surface: one browser session, pages addressed by NAME, ten
// tools.
//
// Non-goal: tab handles. The earlier version of this file handed the agent tab
// indices and then spent three tool descriptions policing them — don't open
// one, don't close the operator's, close yours when you are done. Agents leak
// handles; that is what handles are for. So there is no handle: `as` names the
// page a navigation should keep, `on` goes back to a named page, and omitting
// both lands on the scratch page that the next unnamed navigation reuses.
// Lifetime belongs to browser-control's TabGuard — named pages are pinned,
// unnamed ones recycled, idle ones blanked and reclaimed — which is why no tool
// here can open or close a tab and nothing has to be explained to the agent.
//
// browser-control — and through it playwright-core — is imported lazily inside
// #connect(), so a server that an agent has merely listed tools on costs
// nothing but a Node process.
const ATTACH_TIMEOUT_MS = () => Number(process.env.BC_MCP_ATTACH_TIMEOUT_MS ?? 60_000);
const TEXT_LIMIT = () => Number(process.env.BC_MCP_TEXT_LIMIT ?? 20_000);
const WAIT_TIMEOUT_MS = () => Number(process.env.BC_MCP_WAIT_MS ?? 20_000);
// Nothing to configure here on purpose: an MCP session does one thing at a
// time, and TabGuard already measures that rhythm and sizes its own windows
// from it. Adding "tuned for MCP" constants would just be a second opinion.

/**
 * The one paragraph a client shows before the first tool call (MCP
 * `initialize.instructions`). It exists so the per-call descriptions do not
 * have to nag: state the addressing model once, say that nothing needs
 * closing, stop.
 */
export const INSTRUCTIONS =
  "Pages are addressed by name, never by handle. Pass `as` to browser_navigate to keep that page under a name, and `on` to come back to it from any later call; leave both out and you get the scratch page, which the next unnamed navigation reuses. Nothing needs closing — named pages are kept while you use them, unnamed ones are recycled, idle ones are reclaimed — and browser_surfaces lists what is named right now.";

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
 * One attached browser per server process, created on the first tool call that
 * needs it and re-created if the browser goes away.
 *
 * It keeps no page state of its own — no "active tab", nothing to desynchronise
 * from the browser. Every call resolves its page through the guard's name
 * table, so a page that closed underneath us simply comes back as a fresh one
 * under the same name.
 */
export class Session {
  #live = null;
  #connecting = null;
  #controlPage = null;
  #wrapped = new WeakMap(); // raw page → controlPage proxy, so a call does not rebuild one
  #evicted = 0; // last seen guard.stats.surfacesEvicted, to report only what is new

  /** The attach() result, connecting at most once at a time. */
  async browser() {
    if (this.#live?.browser.isConnected()) return this.#live;
    this.#live = null;
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #connect() {
    // Lazy on purpose: this is the line that pulls in playwright-core.
    const { attach, controlPage } = await import("browser-control");
    const live = await withTimeout(
      attach({ clientName: "browser-control-mcp" }),
      ATTACH_TIMEOUT_MS(),
      "attach()",
    );
    this.#controlPage = controlPage;
    this.#evicted = live.tabs?.stats?.surfacesEvicted ?? 0;
    this.#live = live;
    return live;
  }

  /**
   * The page a call should act on, wrapped by controlPage.
   *
   * `as` binds (or re-binds) a name, `on` must already exist, and neither means
   * the scratch page. The guard creates, recycles or hands back as needed; this
   * method never opens or closes anything itself.
   * @returns {Promise<{ page: object, surface: string | null, evicted: number }>}
   */
  async target({ as, on } = {}) {
    const live = await this.browser();
    const guard = this.#guard(live);
    // Trimmed because that is what the guard keys on; a blank name is the
    // guard's error to raise, not a second opinion here.
    const name = (as ?? on)?.trim() ?? null;
    if (name && as === undefined) this.#assertNamed(guard, name);
    const raw = await guard.surface(name ?? undefined);
    return { page: this.#wrap(raw, live), surface: name, evicted: this.#freshEvictions(guard) };
  }

  /** What is bound right now, and the reassurance that it needs no cleanup. */
  async surfaces() {
    const live = await this.browser();
    const guard = this.#guard(live);
    return {
      surfaces: guard.surfaces(),
      note: "Nothing here needs closing: named pages are held while you use them, unnamed ones are recycled, idle ones are reclaimed.",
    };
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
      support,
    };
  }

  /** What status() reports when there is no browser to attach to. */
  async offlineStatus(err) {
    const { transportSupport, DEFAULT_MODE } = await import("browser-control");
    return { attached: false, reason: flatten(err), mode: DEFAULT_MODE, support: transportSupport() };
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

  /** Evictions the agent has not been told about yet (losing a name must be visible). */
  #freshEvictions(guard) {
    const total = guard.stats?.surfacesEvicted ?? 0;
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

  /** Hand the browser back (shutdown only). */
  async close() {
    const live = this.#live;
    this.#live = null;
    await live?.browser.close().catch(() => {}); // the browser may already be gone
  }
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

/** `on` is the same parameter on every acting tool, so it is written once. */
const ON = { type: "string", description: "Name of a page you kept with `as`; omit for the scratch page" };

/**
 * Tool definitions. `run(args, session)` returns a value (wrapped as text) or a
 * ready-made content payload; throwing is fine — the server turns it into
 * isError, never a transport error.
 */
export const TOOLS = [
  {
    name: "browser_status",
    description: "Report the transport, its capabilities, and what the page guard is holding right now.",
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
      const { page, surface, evicted } = await session.target({ as, on });
      const response = await page.goto(url, waitUntil ? { waitUntil } : {});
      return {
        surface,
        url: page.url(),
        title: await page.title(),
        status: response?.status() ?? null,
        // Only ever present when a name was actually lost, never as a reminder.
        ...(evicted ? { surfacesEvicted: evicted } : {}),
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
      await page.click(selector);
      return `clicked ${selector}`;
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
      return { content: [{ type: "image", data: buffer.toString("base64"), mimeType: "image/png" }] };
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
    description: "List the pages you have named, with their URL and how long each has been idle.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    run: (_args, session) => session.surfaces(),
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
