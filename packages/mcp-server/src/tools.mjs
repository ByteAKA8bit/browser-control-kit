// The agent-facing surface: one browser session, pages addressed by NAME, and
// seventeen tools. Elements are addressed by `ref` from browser_snapshot, by
// CSS, or by `text=…`; the ref exists because an agent should not have to
// reconstruct the DOM to find a button it can already see. The task itself —
// intent, next step, journal, `state`, saved page URLs — lives on disk, so a
// multi-day flow resumes after the process or Chrome goes away.
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
import { FETCH_IN_PAGE, saveBytes, uploads } from "./files.mjs";
import { Jobs } from "./jobs.mjs";
import { SCRIPT_DESCRIPTION, runScript } from "./script.mjs";
import { Task } from "./task.mjs";

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
  "Pages are addressed by name, never by handle. Pass `as` to browser_navigate to keep that page under a name, and `on` to come back to it from any later call; leave both out and you get the scratch page, the single page every unnamed call shares. Calls that name the same page run in the order they arrived; different pages run in parallel. Elements are addressed by `ref`: call browser_snapshot first and use the refs it returns (valid until the next snapshot or navigation), or pass a CSS selector / `text=…`. Tabs need no closing, and the browser is not closed for being quiet — a long task may still need it. You decide: call browser_release when your browser work is done (or `handBack()` at the end of a browser_script); it hands back this session's tabs and the extension relay page, keeps `state` and jobs, and the next call attaches again. browser_surfaces lists what is named right now, and browser_status also lists recent console and uncaught page errors. A browser dialog (confirm/alert/beforeunload) is dismissed by default and reported with the result; pass `dialog:\"accept\"` on the click/press/navigate that opens it if it should proceed. browser_upload attaches local files to an input; browser_download saves a URL's bytes with the page's cookies — take the `href` from browser_snapshot. For anything longer than one step, prefer browser_script: it runs a whole flow in one call against this same session, and `state` inside it survives between calls. For work that spans more than one sitting, browser_task is the durable record — record `intent`, park with `next`, and both survive a server or Chrome restart, as do the named pages and `state`.";

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

/** Page output is untrusted and unbounded; the agent's context is neither. */
function clip(value) {
  const body = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  const limit = TEXT_LIMIT();
  return body.length > limit
    ? `${body.slice(0, limit)}\n…[truncated at BC_MCP_TEXT_LIMIT=${limit} characters; narrow the expression or use browser_snapshot]`
    : body;
}

/** `ref` from browser_snapshot and `selector` are two ways to name one element. */
function targetOf(args, tool) {
  if (args.selector !== undefined && args.ref !== undefined) throw new Error(`${tool}: pass either "selector" or "ref", not both`);
  const target = args.ref ?? args.selector;
  if (!target) throw new Error(`${tool}: pass "selector" (CSS or text=…) or a "ref" from browser_snapshot`);
  return target;
}

/** What the operator has to do before the next attach can work: a click, an install, or nothing. */
export function needsOf(message) {
  const why = String(message ?? "");
  if (/does not export the extension factory/i.test(why)) {
    return { needs: "install", hint: "the installed playwright-core cannot use the extension transport" };
  }
  if (/approved Chrome connection|approval|Allow dialog/i.test(why)) {
    return { needs: "approval", hint: "Chrome is waiting for the operator to allow this debugging connection, once" };
  }
  if (/token|Playwright Extension not found|did not connect|Full Disk Access/i.test(why)) {
    return { needs: "extension", hint: "the Playwright Extension is not reachable in the operator's Chrome; check the token and the extension" };
  }
  return { needs: "unknown", hint: "read `reason`; Chrome may not be running" };
}

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
  #queues = new Map(); // surface name → tail of its call queue
  #rawOf = new WeakMap(); // wrapped page → the Playwright page behind it
  #dialogs = []; // dialogs seen since the last tool result, consumed like evictions
  #logs = []; // recent console/page errors, for browser_status
  /** The durable record; `scriptState` is its live state object, so a restart resumes both. */
  task;
  /** Script state outlives a release; only the client ending clears it. */
  scriptState;
  /** Named background work started by browser_script; see src/jobs.mjs. */
  jobs = new Jobs();
  // Aborted once, when the client is gone: an in-flight script stops waiting
  // instead of driving a browser nobody is listening to.
  #shutdown = new AbortController();

  constructor({ idleMs = IDLE_MS(), connect, task } = {}) {
    this.#idleMs = idleMs;
    this.#connectImpl = connect;
    this.task = task ?? new Task({ client: clientName() });
    this.scriptState = this.task.state;
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

  /**
   * Run a page-acting call after every earlier call on the same name ("" is the
   * scratch page), so two parallel tool calls cannot interleave on one page.
   * Different names still run in parallel. A script that opens extra surfaces
   * does not lock them, which is what keeps this queue deadlock-free.
   */
  async serial(name, fn) {
    const key = typeof name === "string" ? name.trim() : "";
    const prev = this.#queues.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.#queues.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
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
    this.persist(); // the tabs are about to go; their URLs are what a resume reopens
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
  async target({ as, on, resume = true } = {}) {
    const live = await this.browser();
    const guard = this.#guard(live);
    // Trimmed because that is what the guard keys on; a blank name is the guard's error to raise.
    const name = (as ?? on)?.trim() ?? null;
    const resumed = name && as === undefined && resume ? await this.#resume(guard, live, name) : false;
    const raw = await guard.surface(name ?? undefined);
    return { page: this.#wrap(raw, live), surface: name, resumed };
  }

  /** Reopen a name this task knows but this browser does not, at the URL it was last seen at. */
  async #resume(guard, live, name) {
    if (guard.surfaces().some((surface) => surface.name === name)) return false;
    const saved = this.task.surface(name);
    if (!saved?.url) {
      this.#assertNamed(guard, name); // throws, naming what is bound
      return false;
    }
    return this.#reopen(guard, live, name, saved.url);
  }

  /** A named page for a script: a saved name reopens at its URL, an unknown one opens blank. */
  async openSurface(name) {
    const live = await this.browser();
    const guard = this.#guard(live);
    const key = typeof name === "string" ? name.trim() : "";
    if (!key) throw new Error("surface(name) wants a non-empty string name");
    const saved = this.task.surface(key);
    if (saved?.url && !guard.surfaces().some((surface) => surface.name === key)) await this.#reopen(guard, live, key, saved.url);
    return this.#wrap(await guard.surface(key), live);
  }

  async #reopen(guard, live, name, url) {
    const page = this.#wrap(await guard.surface(name), live);
    try {
      await page.goto(url);
    } catch (err) {
      guard.release(name); // leave the name free, so the next `on` retries the saved URL
      throw new Error(`page "${name}" was last at ${url}, but reopening it failed: ${flatten(err)}`);
    }
    return true;
  }

  /** Save a page's URL under its name, so a later process can resume it. */
  rememberSurface(name, info) {
    if (name) this.task.rememberSurface(name, info);
  }

  /** Write state, page URLs and the last-known jobs to the task file; never throws. */
  persist() {
    if (!this.task?.enabled) return null;
    try {
      return this.task.sync({
        state: this.scriptState,
        surfaces: this.#live?.tabs?.surfaces?.() ?? [],
        jobs: this.jobs.list(),
      });
    } catch (err) {
      return { saved: false, error: flatten(err) };
    }
  }

  /** What is bound right now, and the reassurance that it needs no cleanup. */
  async surfaces() {
    const live = await this.browser();
    const guard = this.#guard(live);
    const open = guard.surfaces();
    const names = new Set(open.map((surface) => surface.name));
    return {
      surfaces: open,
      // Not bound here, but this task knows the URL: `on` reopens it, so a restart
      // costs a navigation rather than a re-walk of the flow.
      saved: this.task.report({ journal: 0 }).surfaces.filter((surface) => !names.has(surface.name)),
      scratch: guard.report().scratch,
      note: "Tabs need no closing: named pages are held while you use them, the scratch page is reused by every unnamed call, and unnamed tabs are reclaimed after a quiet spell. A name in `saved` reopens at that URL when you pass it as `on`. The browser itself stays attached until you call browser_release or your client disconnects.",
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
      task: this.task.brief(),
      errors: this.recentErrors(),
      support,
    };
  }

  /** What status() reports when there is no browser to attach to. */
  async offlineStatus(err) {
    const { transportSupport, DEFAULT_MODE } = await import("browser-control");
    const reason = flatten(err);
    return {
      attached: false,
      client: clientName(),
      reason,
      mode: DEFAULT_MODE,
      ...needsOf(reason),
      task: this.task.brief(),
      support: transportSupport(),
    };
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
      this.#rawOf.set(page, raw);
      // What the page said while failing: the agent's only view is the DOM,
      // and a console error is often the reason nothing changed.
      raw.on?.("console", (message) => {
        if (message.type?.() !== "error") return;
        this.#log(raw, "console", message.text?.() ?? "");
      });
      raw.on?.("pageerror", (error) => this.#log(raw, "pageerror", String(error?.message ?? error)));
    }
    return page;
  }

  #log(raw, kind, text) {
    let url = "";
    try {
      url = raw.url?.() ?? "";
    } catch {} // a page that closed under us still has a last error worth keeping
    this.#logs.push({ at: new Date().toISOString(), kind, text: String(text).slice(0, 500), url });
    if (this.#logs.length > 50) this.#logs.shift();
  }

  /** Recent console and uncaught errors, newest last; diagnostic, so never consumed. */
  recentErrors(limit = 10) {
    const n = Number(limit);
    return n > 0 ? this.#logs.slice(-n) : [];
  }

  /**
   * Answer a dialog the action opens: "accept" or (the default) "dismiss".
   * The listener lives only for this action, so a script's own handler still
   * wins and nothing is left listening on the operator's page.
   */
  async withDialog(page, behavior, fn) {
    const raw = this.#rawOf.get(page);
    if (!raw?.on) return fn();
    const answer = behavior === "accept" ? "accept" : "dismiss";
    const onDialog = (dialog) => {
      let url = "";
      try {
        url = raw.url?.() ?? "";
      } catch {} // a page that closed under us must still get an answer
      this.#dialogs.push({ type: dialog.type?.() ?? "dialog", message: dialog.message?.() ?? "", accepted: answer === "accept", url });
      if (this.#dialogs.length > 20) this.#dialogs.shift();
      void (answer === "accept" ? dialog.accept() : dialog.dismiss()).catch(() => {}); // the page may be gone already
    };
    raw.on("dialog", onDialog);
    try {
      return await fn();
    } finally {
      raw.off?.("dialog", onDialog);
    }
  }

  /** Dialogs seen since the last tool result, so none is dismissed without the agent knowing. */
  freshDialogs() {
    if (!this.#dialogs.length) return [];
    const seen = this.#dialogs;
    this.#dialogs = [];
    return seen;
  }

  /** Hand the browser back and end the session (client gone). */
  async close() {
    this.#disarmIdle();
    await this.#releasing; // a release already in flight must finish its tab hand-back
    const live = this.#live;
    this.persist(); // before cancelAll: a job running at shutdown is interrupted, not silently lost
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

/** A dismissed dialog is a no-op the agent must hear about, like an eviction. */
const withDialogs = (payload, dialogs) =>
  dialogs.length
    ? {
        ...payload,
        content: [
          ...payload.content,
          ...dialogs.map((dialog) => ({
            type: "text",
            text: `dialog (${dialog.type}, ${dialog.accepted ? "accepted" : "dismissed"}): ${JSON.stringify(dialog.message)} — ${
              dialog.accepted
                ? "it was allowed to proceed."
                : 'if it was asking permission, that action did NOT run; repeat the call with dialog:"accept" if it should have.'
            }`,
          })),
        ],
      }
    : payload;

/** `on` is the same parameter on every acting tool, so it is written once. */
const ON = { type: "string", description: "Name of a page you kept with `as`; omit for the scratch page" };

/** A dialog is dismissed unless the call asks for it, and either way the agent is told. */
const DIALOG = {
  type: "string",
  enum: ["accept", "dismiss"],
  description: "How to answer a dialog this call opens (default dismiss; a dismissed confirm means the action did not run)",
};

/** The task tool's answer: the goal, where it stands, and what a resumed agent needs. */
function formatTask(task) {
  const lines = [`task ${task.id} — ${task.status}${task.enabled ? "" : " — persistence is off (BC_MCP_TASK=0)"}`];
  if (task.intent) lines.push(`intent: ${task.intent}`);
  if (task.next) lines.push(`next: ${task.next}`);
  if (task.loadError) lines.push(`warning: the previous task file was unreadable (${task.loadError}); it was kept as task.json.corrupt-* and this task started empty`);
  lines.push(
    task.state.skipped
      ? `state: ${task.state.keys} key(s) — NOT saved: ${task.state.skipped.bytes} > ${task.state.skipped.limit} bytes (BC_MCP_TASK_STATE_MAX); the previous copy is on disk. Keep ids and small values, not page HTML`
      : `state: ${task.state.keys} key(s), ${task.state.bytes} bytes`,
  );
  if (task.state.lost?.length) lines.push(`state cannot round-trip: ${task.state.lost.join(", ")}`);
  if (task.surfaces.length) {
    lines.push("surfaces (reopened by `on` after a restart):");
    for (const surface of task.surfaces) lines.push(`  ${surface.name}  ${surface.url}${surface.title ? ` — ${surface.title}` : ""}`);
  }
  if (task.jobs.length) {
    lines.push("jobs (last known):");
    for (const job of task.jobs) {
      lines.push(`  ${job.name}: ${job.state}${job.state === "interrupted" ? " — it did NOT resume; check what its last action did before retrying" : ""}`);
    }
  }
  if (task.journal.length) {
    lines.push("journal:");
    for (const line of task.journal) lines.push(`  ${line}`);
  }
  if (task.lastError) lines.push(`warning: the task file could not be written: ${task.lastError}`);
  lines.push(`updated: ${task.updated ?? "never"}  file: ${task.file}`);
  return lines.join("\n");
}

/**
 * Tool definitions. `run(args, session)` returns a value (wrapped as text) or
 * a `new Payload([...])`; throwing becomes isError, never a transport error.
 */
export const TOOLS = [
  {
    name: "browser_status",
    description: "Report the transport, its capabilities, what the page guard is holding, the task, and recent console/uncaught page errors.",
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
    name: "browser_task",
    description:
      "Read or update the durable task: intent, next step, status, state and a journal. It is written to disk, so it survives a server restart and a Chrome restart; a named page is reopened at its last URL when you call `on`. With no arguments it reports the task.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "What this task is, in one line" },
        next: { type: "string", description: "The next concrete step, so a resumed agent knows where to start" },
        status: { type: "string", enum: ["active", "parked", "done"] },
        note: { type: "string", description: "One journal line: what happened, or what is blocking" },
        state: { type: "object", description: "Shallow-merged into the durable `state` object" },
        journal: { type: "integer", description: "How many recent journal lines to return (default 10)" },
        reset: { type: "boolean", description: "Archive the journal and start this task empty" },
      },
      required: [],
      additionalProperties: false,
    },
    async run({ intent, next, status, note, state, journal, reset }, session) {
      if (state !== undefined && (state === null || Array.isArray(state) || typeof state !== "object")) {
        throw new Error("browser_task.state must be an object of values to merge");
      }
      const edit = reset || [intent, next, status, note, state].some((value) => value !== undefined);
      if (edit) session.task.edit({ intent, next, status, note, state, reset });
      return formatTask(session.task.report({ journal: journal ?? 10 }));
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
        dialog: DIALOG,
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run({ url, as, on, waitUntil, dialog }, session) {
      const { page, surface } = await session.target({ as, on, resume: false });
      const response = await session.withDialog(page, dialog, () => page.goto(url, waitUntil ? { waitUntil } : {}));
      const title = await page.title().catch(() => "");
      session.rememberSurface(surface, { url: page.url(), title });
      return {
        surface,
        url: page.url(),
        title,
        status: response?.status() ?? null,
      };
    },
  },
  {
    name: "browser_click",
    description: "Click an element by `ref` from browser_snapshot, or by a CSS / text= selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector, or text=… (e.g. text=Save)" },
        ref: { type: "string", description: "Ref from browser_snapshot, e.g. f0:3" },
        on: ON,
        dialog: DIALOG,
      },
      required: [],
      additionalProperties: false,
    },
    async run({ selector, ref, on, dialog }, session) {
      const target = targetOf({ selector, ref }, "browser_click");
      const { page } = await session.target({ on });
      const result = await session.withDialog(page, dialog, () => page.click(target));
      // An unverified click MUST reach the agent: the page may simply not have
      // acted, and only the caller knows whether clicking again is safe.
      if (result?.verified === false) return `clicked ${target}, but ${result.reason}. Check the page before clicking again: repeating it may act twice.`;
      const note =
        result?.via === "dom-fallback"
          ? " (the real click went nowhere, so this was a DOM-level click)"
          : result?.via === "ref"
            ? " (resolved from the last snapshot; DOM dispatch, so the event is not trusted)"
            : "";
      return `clicked ${target}${note}`;
    },
  },
  {
    name: "browser_type",
    description: "Append text to a field addressed by ref or selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector, or text=…" },
        ref: { type: "string", description: "Ref from browser_snapshot" },
        text: { type: "string" },
        on: ON,
        dialog: DIALOG,
      },
      required: ["text"],
      additionalProperties: false,
    },
    async run({ selector, ref, text: value, on, dialog }, session) {
      const target = targetOf({ selector, ref }, "browser_type");
      const { page } = await session.target({ on });
      await session.withDialog(page, dialog, () => page.type(target, value));
      return `typed into ${target}`;
    },
  },
  {
    name: "browser_fill",
    description: "Replace a field's value; a `<select>` picks the option whose value or visible label matches.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector, or text=…" },
        ref: { type: "string", description: "Ref from browser_snapshot" },
        value: { type: "string" },
        on: ON,
        dialog: DIALOG,
      },
      required: ["value"],
      additionalProperties: false,
    },
    async run({ selector, ref, value, on, dialog }, session) {
      const target = targetOf({ selector, ref }, "browser_fill");
      const { page } = await session.target({ on });
      await session.withDialog(page, dialog, () => page.fill(target, value));
      return `filled ${target}`;
    },
  },
  {
    name: "browser_upload",
    description: "Attach files to a file input: this machine's paths, or inline base64/text when the bytes came from somewhere else.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the input, or text=…" },
        ref: { type: "string", description: "Ref from browser_snapshot" },
        files: {
          type: "array",
          minItems: 1,
          items: {
            anyOf: [
              { type: "string", description: "A path this server can read" },
              {
                type: "object",
                properties: {
                  path: { type: "string" },
                  name: { type: "string" },
                  base64: { type: "string" },
                  text: { type: "string" },
                  type: { type: "string", description: "MIME type, e.g. text/csv" },
                },
                additionalProperties: false,
              },
            ],
          },
        },
        on: ON,
        dialog: DIALOG,
      },
      required: ["files"],
      additionalProperties: false,
    },
    async run({ selector, ref, files, on, dialog }, session) {
      const target = targetOf({ selector, ref }, "browser_upload");
      const list = uploads(files);
      const { page } = await session.target({ on });
      const result = await session.withDialog(page, dialog, () => page.setInputFiles(target, list));
      return { ...result, files: list.map((file) => file.name) };
    },
  },
  {
    name: "browser_download",
    description:
      "Fetch a URL with the page's cookies and save the bytes on this machine (Chrome's download plumbing is not exposed on the extension transport). Pass the `href` a browser_snapshot shows; returns the saved path, which browser_upload can take straight back.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The file URL, usually a link's `href` from browser_snapshot" },
        path: { type: "string", description: "Where to save it; defaults to BC_DOWNLOAD_DIR or ~/.cache/browser-control/downloads" },
        timeoutMs: { type: "integer", description: "How long to wait for the response (default 30000)" },
        on: ON,
      },
      required: ["url"],
      additionalProperties: false,
    },
    async run({ url, path: target, timeoutMs, on }, session) {
      if (typeof url !== "string" || !url) throw new Error('browser_download needs "url": the href a browser_snapshot shows');
      const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30_000;
      const configured = Number(process.env.BC_MCP_DOWNLOAD_MAX);
      const max = configured > 0 ? configured : 67_108_864;
      const { page } = await session.target({ on });
      const result = await page.evaluate(FETCH_IN_PAGE, url, ms, max);
      if (!result?.ok) {
        throw new Error(`browser_download(${url}) failed: ${result?.reason ?? "unknown"}; a POST or JS-created download is outside this tool — use browser_script to drive the click and see what the page does`);
      }
      return { ...saveBytes(result, target), type: result.type, bytes: result.bytes };
    },
  },
  {
    name: "browser_press",
    description: "Press a key (Enter, Escape, Tab, ArrowDown, Control+A) on a ref/selector, or on the focused element.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Playwright key name, e.g. Enter" },
        selector: { type: "string", description: "CSS selector, or text=…" },
        ref: { type: "string", description: "Ref from browser_snapshot" },
        on: ON,
        dialog: DIALOG,
      },
      required: ["key"],
      additionalProperties: false,
    },
    async run({ key, selector, ref, on, dialog }, session) {
      const target = selector === undefined && ref === undefined ? null : targetOf({ selector, ref }, "browser_press");
      const { page } = await session.target({ on });
      await session.withDialog(page, dialog, () => page.press(target, key));
      return `pressed ${key}${target ? ` on ${target}` : ""}`;
    },
  },
  {
    name: "browser_text",
    description: "Read visible text of the page, or of one element addressed by ref or selector.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector, or text=…; defaults to the whole document" },
        ref: { type: "string", description: "Ref from browser_snapshot" },
        on: ON,
      },
      required: [],
      additionalProperties: false,
    },
    async run({ selector, ref, on }, session) {
      if (selector !== undefined && ref !== undefined) throw new Error('browser_text: pass either "selector" or "ref", not both');
      const { page } = await session.target({ on });
      return clip(await page.text(ref ?? selector));
    },
  },
  {
    name: "browser_snapshot",
    description: "List every visible, actionable element with a ref, role, name, value/state (and an `href` for links). Refs are valid until the next snapshot or navigation.",
    inputSchema: {
      type: "object",
      properties: {
        max: { type: "integer", description: "Per-frame element cap (default 200)" },
        on: ON,
      },
      required: [],
      additionalProperties: false,
    },
    async run({ max, on }, session) {
      const { page } = await session.target({ on });
      const snap = await page.snapshot({ max: max ?? 200 });
      const lines = [`${snap.title || "(untitled)"} — ${snap.url}`];
      for (const frame of snap.frames) {
        lines.push(`[frame ${frame.frame}] ${frame.url}`);
        for (const item of frame.items) {
          const state = item.state?.length ? ` (${item.state.join(",")})` : "";
          const value = item.value ? ` value=${JSON.stringify(item.value)}` : "";
          lines.push(`${item.ref} ${item.role} ${JSON.stringify(item.name)}${value}${state}`);
        }
        if (frame.truncated) lines.push(`…[frame ${frame.frame} truncated at ${max ?? 200}; raise max]`);
      }
      if (!snap.frames.length) lines.push("(no visible actionable elements)");
      return clip(lines.join("\n"));
    },
  },
  {
    name: "browser_evaluate",
    description: "Evaluate a JavaScript expression in a page.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "JavaScript expression or IIFE" }, on: ON, dialog: DIALOG },
      required: ["expression"],
      additionalProperties: false,
    },
    async run({ expression, on, dialog }, session) {
      const { page } = await session.target({ on });
      const value = await session.withDialog(page, dialog, () => page.evaluate(expression));
      return value === undefined ? "undefined" : clip(value);
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
    description: "List the pages you have named (URL and idle time), the names this task can reopen at their last URL, and the scratch page. Tabs need no closing; the browser stays attached until you call browser_release.",
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
      try {
        return new Payload(await runScript({ code, timeoutMs, page, live, wrap: (raw) => session.wrap(raw), surface: (name) => session.openSurface(name), signal: session.signal, handBack: () => session.handBack() }));
      } finally {
        // A script is where `state` and most navigations happen; both belong to the
        // task, not to this call, and the "finally" covers a body that threw or timed out.
        session.persist();
      }
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
    // Two concurrent calls on one page would interleave; every other acting tool
    // carries `as`/`on`, so that is the lock key. Read-only calls skip the queue.
    const acts = Boolean(tool.inputSchema?.properties?.on || tool.inputSchema?.properties?.as);
    const run = () => tool.run(args, session);
    const result = acts && session.serial ? await session.serial(args.as ?? args.on, run) : await run();
    payload = result instanceof Payload ? { content: result.content } : text(result);
  } catch (err) {
    payload = { ...text(`${name} failed: ${flatten(err)}`), isError: true };
  } finally {
    done?.(); // only now is the browser genuinely idle
  }
  // One place consumes the eviction counter; seven tools used to drop the notice on the floor.
  return withDialogs(withEvictions(payload, session.freshEvictions()), session.freshDialogs?.() ?? []);
}
