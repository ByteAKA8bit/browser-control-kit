// One tool call, a whole flow. Measured 2026-10-06: 40 actions cost 878 ms as 40
// tool calls and 642 ms in one script — but 41 agent turns against 1, and the
// turns are what an agent actually pays for. So the batch runs HERE, inside the
// session that is already attached, instead of in a child process that would
// attach again and lose every named page when it exits.
//
// Deliberately NOT a sandbox: the body gets the real page, the real guard, and
// `import()`/`require` like any module. An agent that can run this can already
// run bash; fencing it would cost upload, download and file-writing flows and
// buy nothing. `state` is what makes a flow resumable — it survives calls, so
// nothing has to be handed back to the agent as a handle.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
export const SCRIPT_TIMEOUT_MS = () => Number(process.env.BC_MCP_SCRIPT_MS ?? 120_000);

/** Everything the body can name, in the order it is passed in. */
const SCOPE = ["page", "surface", "release", "surfaces", "state", "jobs", "log", "guard", "context", "browser", "capabilities", "fixtures", "controlPage", "require", "sleep"];

/** A result the transport can carry: Buffers become images, everything else JSON. */
function present(value, logs) {
  const content = [];
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    content.push({ type: "image", data: Buffer.from(value).toString("base64"), mimeType: "image/png" });
  } else if (value !== undefined) {
    content.push({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
  }
  if (logs.length) content.push({ type: "text", text: logs.join("\n") });
  if (!content.length) content.push({ type: "text", text: "(the script returned nothing and logged nothing)" });
  return content;
}

/**
 * Run `code` as an async function body with the live session in scope.
 * @param {{ code: string, timeoutMs?: number, page: object, live: object, wrap: (raw: object) => object }} args
 * @returns {Promise<Array<object>>} MCP content blocks
 */
export async function runScript({ code, timeoutMs, page, live, wrap }) {
  const logs = [];
  const log = (...parts) => logs.push(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" "));
  const guard = live.tabs;
  const scope = {
    page,
    surface: async (name) => wrap(await guard.surface(name)),
    release: (name) => guard.release(name),
    surfaces: () => guard.surfaces(),
    state: live.scriptState,
    jobs: live.jobs,
    log,
    guard,
    context: live.context,
    browser: live.browser,
    capabilities: live.capabilities,
    fixtures: await import("browser-control/fixtures"),
    controlPage: (raw) => wrap(raw),
    require,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const body = new AsyncFunction(...SCOPE, code);
  // console.log is what an agent reaches for first; MCP calls are serial, so
  // borrowing it for the duration is safe, and stdout MUST stay protocol-only.
  const realLog = console.log;
  console.log = log;
  let timer = null;
  try {
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : SCRIPT_TIMEOUT_MS();
    const capped = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`browser_script exceeded ${ms}ms (raise timeoutMs, or BC_MCP_SCRIPT_MS)`)), ms);
      timer.unref?.();
    });
    const value = await Promise.race([body(...SCOPE.map((key) => scope[key])), capped]);
    return present(value, logs);
  } finally {
    clearTimeout(timer);
    console.log = realLog;
  }
}

/** The one-line contract the agent reads before writing a body. */
export const SCRIPT_DESCRIPTION =
  "Run JavaScript in this session to do many things in one call — the efficient way to drive a flow. " +
  "The body is an async function: `await` freely, `return` a value (JSON, or a Buffer for a PNG). " +
  `In scope: ${SCOPE.join(", ")}. ` +
  "`page` is the same named/scratch page the other tools use, `surface(name)` opens or returns another one, " +
  "`state` is an object that survives between calls, `log()` and console.log are returned with the result. " +
  "For work that outlives one call — waiting for the operator to log in or pay, polling for a slot, retrying a sold-out ticket, a loop that runs for an hour — " +
  "hand it to a NAMED job: `jobs.start('snipe', async ({ signal, log }) => { while (!signal.aborted) { … } })` returns at once, " +
  "and a later call reads `jobs.status('snipe')` / `jobs.list()` / `await jobs.wait('snipe', 5000)` / `jobs.cancel('snipe')`. " +
  "Example: `const p = await surface('docs'); await p.goto(url); return p.$$eval('h2', h => h.map(x => x.textContent));`";
