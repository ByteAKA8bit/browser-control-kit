// A task outlives this process: the MCP client restarts, Chrome quits and is
// reopened, a different agent picks the work up tomorrow. A file is the only
// thing that survives all three, so the intent, the journal, `state` and the
// named pages live there.
//
// Non-goal: resuming work. A job may have clicked "pay" when the process died;
// on load it is reported interrupted, never started again.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_MAX = () => Number(process.env.BC_MCP_TASK_STATE_MAX ?? 262_144);
const JOURNAL_MAX = () => Number(process.env.BC_MCP_TASK_JOURNAL ?? 500);
const FIELD_MAX = 1_000;
const ENABLED = () => process.env.BC_MCP_TASK !== "0";

const flatten = (err) => String(err?.message ?? err).split("\n")[0];
const now = () => new Date().toISOString();
const cut = (value) => String(value ?? "").trim().slice(0, FIELD_MAX);

/** Where tasks live: the kit's one cache directory unless the operator moved it. */
export const taskDir = () =>
  process.env.BC_TASK_DIR ?? path.join(process.env.BC_SHIM_LOG_DIR ?? path.join(os.homedir(), ".cache", "browser-control"), "tasks");

/** A directory-safe id: the client name, or BC_TASK_ID when two agents share a directory. */
export function taskId(client) {
  const raw = String(process.env.BC_TASK_ID ?? "").trim() || String(client ?? "");
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return slug || "task";
}

/** JSON that survives a function, a Buffer or a cycle; `lost` says what cannot come back. */
export function encodeState(value) {
  const seen = new WeakSet();
  const lost = [];
  let text;
  try {
    text = JSON.stringify(value ?? {}, (key, item) => {
      if (typeof item === "function") {
        lost.push(`function ${item.name || key}`);
        return undefined;
      }
      if (typeof item === "bigint") {
        lost.push(`bigint ${key}`);
        return String(item);
      }
      if (item && typeof item === "object") {
        // toJSON runs before the replacer, so a Buffer arrives as {type:"Buffer",data:[…]}.
        if (item.type === "Buffer" && Array.isArray(item.data)) {
          lost.push(`Buffer ${key} (${item.data.length} bytes)`);
          return `[Buffer ${item.data.length} bytes]`;
        }
        if (seen.has(item)) {
          lost.push(`repeated ${key}`);
          return "[Circular]";
        }
        seen.add(item);
      }
      return item;
    });
  } catch (err) {
    return { text: "{}", lost: [`the whole state (${flatten(err)})`] };
  }
  return { text: text ?? "{}", lost };
}

/** One journal record as the agent reads it: time, what changed, and the next step. */
function journalLine(entry) {
  const at = String(entry.at ?? "").slice(11, 19);
  const bits = [
    entry.intent && `intent: ${entry.intent}`,
    entry.status && `status: ${entry.status}`,
    entry.note,
    entry.next && `next: ${entry.next}`,
    entry.state,
    entry.jobs?.length && `interrupted: ${entry.jobs.join(", ")}`,
    entry.event === "state-too-large" && `state too large: ${entry.bytes} > ${entry.limit}`,
    entry.event === "reset" && "journal archived, state cleared",
  ].filter(Boolean);
  return `${at} ${bits.join(" · ")}`.trim();
}

/**
 * The durable record for one name. Every write is atomic and every failure is
 * reported in `report()` rather than thrown at a tool call.
 */
export class Task {
  #file;
  #journalFile;
  #data;
  #state;
  #stateText = "{}";
  #dirty = false;
  #lastError = null;
  #lastLost = [];

  constructor({ client = path.basename(process.cwd() || "") || "browser-control-mcp", dir = taskDir() } = {}) {
    this.enabled = ENABLED();
    this.id = taskId(client);
    this.client = client;
    this.#file = path.join(dir, this.id, "task.json");
    this.#journalFile = path.join(dir, this.id, "journal.ndjson");
    this.#data = {
      version: 1,
      id: this.id,
      client,
      intent: "",
      status: "active",
      next: "",
      createdAt: now(),
      updatedAt: null,
      state: {},
      stateBytes: 0,
      stateSkipped: null,
      surfaces: {},
      jobs: [],
    };
    if (this.enabled) this.#read();
    this.#state = this.#data.state && typeof this.#data.state === "object" ? this.#data.state : {};
    this.#stateText = JSON.stringify(this.#state);
  }

  /** The live object scripts mutate; it keeps its identity for the whole session. */
  get state() {
    return this.#state;
  }

  get file() {
    return this.#file;
  }

  /** What this name was last seen at, so `on` can reopen it after a restart. */
  surface(name) {
    return this.#data.surfaces[String(name ?? "").trim()] ?? null;
  }

  /** Remember a page's URL (and title, when a navigate call has it) for the next process. */
  rememberSurface(name, { url, title } = {}) {
    const key = String(name ?? "").trim();
    if (!this.enabled || !key || !url || url === "about:blank") return;
    const prev = this.#data.surfaces[key];
    if (prev?.url === url && (title === undefined || prev.title === title)) return;
    this.#data.surfaces[key] = { url, title: title ?? prev?.title ?? "", savedAt: now() };
    this.#dirty = true;
    this.save();
  }

  /** One write per call: state, the URL behind each name, and the last-known jobs. */
  sync({ state, surfaces, jobs } = {}) {
    if (!this.enabled) return { saved: false, reason: "BC_MCP_TASK=0" };
    if (state) this.#commitState(state);
    if (surfaces) this.#commitSurfaces(surfaces);
    if (jobs) this.#commitJobs(jobs);
    return this.save();
  }

  /** Apply what the agent asked for, journal it, and write once. */
  edit({ intent, next, status, note, state, reset } = {}) {
    if (!this.enabled) throw new Error("durable tasks are off: this server runs with BC_MCP_TASK=0");
    if (reset) this.#reset();
    const entry = { event: "edit" };
    if (intent !== undefined) {
      this.#data.intent = cut(intent);
      entry.intent = this.#data.intent;
      this.#dirty = true;
    }
    if (next !== undefined) {
      this.#data.next = cut(next);
      entry.next = this.#data.next;
      this.#dirty = true;
    }
    if (status !== undefined) {
      this.#data.status = status;
      entry.status = status;
      this.#dirty = true;
    }
    if (note !== undefined) entry.note = cut(note);
    if (state !== undefined) {
      Object.assign(this.#state, state);
      this.#commitState(this.#state);
      entry.state = `${Object.keys(state).length} key(s) merged`;
    }
    if (Object.keys(entry).length > 1) this.#append(entry);
    this.save();
    return this.report();
  }

  /** The full record: intent, state, saved pages, last-known jobs and the journal tail. */
  report({ journal = 10 } = {}) {
    return {
      enabled: this.enabled,
      id: this.id,
      client: this.client,
      intent: this.#data.intent,
      status: this.#data.status,
      next: this.#data.next,
      created: this.#data.createdAt,
      updated: this.#data.updatedAt,
      state: {
        keys: Object.keys(this.#state).length,
        bytes: this.#data.stateBytes ?? 0,
        skipped: this.#data.stateSkipped ?? null,
        ...(this.#lastLost?.length ? { lost: this.#lastLost.slice(0, 10) } : {}),
      },
      surfaces: Object.entries(this.#data.surfaces).map(([name, saved]) => ({ name, ...saved })),
      jobs: this.#data.jobs,
      journal: journal > 0 ? this.#tail(journal) : [],
      file: this.#file,
      ...(this.loadError ? { loadError: this.loadError } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  /** The small version for browser_status: no journal read, no state dump. */
  brief() {
    return {
      enabled: this.enabled,
      id: this.id,
      intent: this.#data.intent,
      status: this.#data.status,
      next: this.#data.next,
      updated: this.#data.updatedAt,
      file: this.#file,
      ...(this.loadError ? { loadError: this.loadError } : {}),
    };
  }

  /** A note for a client attaching to existing work; "" when there is nothing to resume. */
  resume() {
    if (!this.enabled) return "";
    if (this.loadError) return `The task file could not be read (${this.loadError}); it was kept as task.json.corrupt-* and this task started empty.`;
    const jobs = this.#data.jobs.filter((job) => job.state === "interrupted");
    const surfaces = Object.keys(this.#data.surfaces).length;
    if (!this.#data.intent && !this.#data.next && !surfaces && !jobs.length) return "";
    const bits = [];
    if (this.#data.intent) bits.push(`intent: ${this.#data.intent}`);
    if (this.#data.next) bits.push(`next: ${this.#data.next}`);
    if (surfaces) bits.push(`${surfaces} saved page(s) reopen with \`on\``);
    if (jobs.length) bits.push(`interrupted job(s): ${jobs.map((job) => job.name).join(", ")} — check before retrying`);
    return `Resuming task "${this.id}" (updated ${this.#data.updatedAt ?? this.#data.createdAt}): ${bits.join("; ")}. Call browser_task for the journal.`;
  }

  /** Write the record atomically; a full disk is reported, never thrown into a tool call. */
  save() {
    if (!this.enabled) return { saved: false, reason: "BC_MCP_TASK=0" };
    if (!this.#dirty) return { saved: false, reason: "unchanged", file: this.#file };
    try {
      mkdirSync(path.dirname(this.#file), { recursive: true });
      this.#data.updatedAt = now();
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`);
      renameSync(tmp, this.#file);
      this.#dirty = false;
      this.#lastError = null;
      return { saved: true, file: this.#file };
    } catch (err) {
      this.#lastError = flatten(err);
      return { saved: false, error: this.#lastError };
    }
  }

  #read() {
    if (!existsSync(this.#file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8"));
      if (raw?.version !== 1) throw new Error(`unknown task version ${raw?.version}`);
      this.#data = {
        ...this.#data,
        ...raw,
        state: raw.state && typeof raw.state === "object" && !Array.isArray(raw.state) ? raw.state : {},
        surfaces: { ...(raw.surfaces ?? {}) },
        jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
      };
    } catch (err) {
      this.loadError = flatten(err);
      try {
        renameSync(this.#file, `${this.#file}.corrupt-${Date.now()}`); // kept: it is the only copy of the work
      } catch {} // unreadable and unmovable: report it, do not fail the session
      return;
    }
    this.#recover();
  }

  #recover() {
    const running = this.#data.jobs.filter((job) => job.state === "running");
    if (!running.length) return;
    // A loop that was mid-flight when the process died may already have acted; saying
    // "interrupted" is the only honest answer, and restarting it could act twice.
    for (const job of running) job.state = "interrupted";
    this.#append({ event: "interrupted", jobs: running.map((job) => job.name) });
    this.#dirty = true;
    this.save();
  }

  #commitState(state) {
    const { text, lost } = encodeState(state);
    const bytes = Buffer.byteLength(text);
    const limit = STATE_MAX();
    this.#lastLost = lost;
    if (bytes > limit) {
      if (!this.#data.stateSkipped) this.#append({ event: "state-too-large", bytes, limit });
      this.#data.stateSkipped = { bytes, limit };
      this.#dirty = true;
      return;
    }
    if (text === this.#stateText) return;
    this.#stateText = text;
    this.#data.state = JSON.parse(text);
    this.#data.stateBytes = bytes;
    this.#data.stateSkipped = null;
    this.#dirty = true;
  }

  #commitSurfaces(list) {
    for (const { name, url } of list) {
      const key = String(name ?? "").trim();
      if (!key || !url || url === "about:blank") continue;
      const prev = this.#data.surfaces[key];
      if (prev?.url === url) continue;
      this.#data.surfaces[key] = { url, title: prev?.title ?? "", savedAt: now() };
      this.#dirty = true;
    }
  }

  #commitJobs(list) {
    const current = new Map(list.slice(0, 20).map((job) => [job.name, { name: job.name, state: job.state, startedAt: job.startedAt }]));
    // An interrupted job stays in the record until a job of the same name replaces
    // it or the task is reset: it is the only warning that an action may have run.
    const carried = this.#data.jobs.filter((job) => job.state === "interrupted" && !current.has(job.name));
    const next = [...carried, ...current.values()].slice(-20);
    if (JSON.stringify(next) === JSON.stringify(this.#data.jobs)) return;
    this.#data.jobs = next;
    this.#dirty = true;
  }

  #reset() {
    const stamp = now().replace(/[:.]/g, "-");
    try {
      renameSync(this.#journalFile, path.join(path.dirname(this.#journalFile), `journal-${stamp}.ndjson`));
    } catch {} // no journal yet
    for (const key of Object.keys(this.#state)) delete this.#state[key]; // scripts hold this object
    this.#stateText = "{}";
    Object.assign(this.#data, {
      intent: "",
      next: "",
      status: "active",
      createdAt: now(),
      state: {},
      stateBytes: 0,
      stateSkipped: null,
      surfaces: {},
      jobs: [],
    });
    this.#dirty = true;
    this.#append({ event: "reset" });
  }

  #append(entry) {
    if (!this.enabled) return;
    try {
      mkdirSync(path.dirname(this.#journalFile), { recursive: true });
      writeFileSync(this.#journalFile, `${JSON.stringify({ at: now(), ...entry })}\n`, { flag: "a" });
      this.#trim();
    } catch (err) {
      this.#lastError = flatten(err);
    }
  }

  #trim() {
    const max = JOURNAL_MAX();
    if (!(max > 0)) return;
    let lines;
    try {
      lines = readFileSync(this.#journalFile, "utf8").split("\n").filter(Boolean);
    } catch {
      return; // the file vanished between append and trim; the append is what mattered
    }
    if (lines.length <= max) return;
    const tmp = `${this.#journalFile}.tmp`;
    writeFileSync(tmp, `${lines.slice(-max).join("\n")}\n`);
    renameSync(tmp, this.#journalFile);
  }

  #tail(count) {
    let lines;
    try {
      lines = readFileSync(this.#journalFile, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
    return lines.slice(-Math.min(Number(count) || 0, JOURNAL_MAX())).map((line) => {
      try {
        return journalLine(JSON.parse(line));
      } catch {
        return line.slice(0, 200); // a hand-edited line is still a journal entry
      }
    });
  }
}
