// Long-lived CDP shim for the operator's real Chrome: ONE approved connection.
// Chrome asks the operator to approve EVERY new external CDP connection to the
// default profile and never remembers the answer; an unapproved Chrome 404s all
// /json/* and hangs the ws handshake. So the shim holds one approved browser
// socket, proxies every client over it (ids rewritten, events routed by session)
// and rebuilds /json/* on top of it. NEVER advertise Chrome's own ws URL: that
// is a dialog per attach, which is what this file used to cost.
// Non-goal: starting, quitting or configuring the operator's Chrome.
// Invariant: approval clicks = shim processes, so one shim owns the port.
// Runs on Node >= 22 (global WebSocket), pinned by ../.nvmrc.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { statSync, truncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { upgrade } from "./ws-server.mjs";

// Everything this kit writes lives in ONE directory, so "what did you put on my
// machine?" has a one-line answer (plus launchd's own plist). BC_SHIM_LOG_DIR moves it.
const LOG_DIR = process.env.BC_SHIM_LOG_DIR ?? path.join(os.homedir(), ".cache", "browser-control");
const LOG_MAX = Number(process.env.BC_SHIM_LOG_MAX ?? 262_144);

const CHROME_HOST = process.env.CHROME_HOST ?? "127.0.0.1";
const LISTEN_PORT = Number(process.env.SHIM_PORT ?? 9333);
// Chrome's default user-data-dir per platform; CHROME_PORT_FILE overrides it for
// a custom profile, another channel, or a browser we have not met.
const CHROME_PROFILE_DIRS = {
  darwin: () => path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"),
  win32: () => path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data"),
  linux: () => path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "google-chrome"),
};
const ACTIVE_PORT_FILE =
  process.env.CHROME_PORT_FILE ?? path.join((CHROME_PROFILE_DIRS[os.platform()] ?? CHROME_PROFILE_DIRS.linux)(), "DevToolsActivePort");

let chromePort = Number(process.env.CHROME_PORT ?? 9222);
// A dropped browser socket costs another "Allow" click, and idle websockets are
// what sleep states reap; one Browser.getVersion per interval keeps it warm.
// BC_SHIM_KEEPALIVE_MS=0 switches the timer off.
const KEEPALIVE_MS = Number(process.env.BC_SHIM_KEEPALIVE_MS ?? 30_000);
let connects = 0;

// Browser-destroying commands the shim answers ITSELF with `{}` rather than
// forward: playwright's browser.close() sends Browser.close, which over this
// shared socket killed the operator's real browser — measured twice 2026-10-02.
const REFUSED_METHODS = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess"]);

/**
 * Chrome's browser websocket. The per-launch id lives in DevToolsActivePort,
 * which macOS keeps behind Full Disk Access — when that read fails, the id-less
 * `/devtools/browser` endpoint upgrades just the same, so a shim without the
 * permission still works instead of sending the operator to restart Chrome.
 */
async function endpoint() {
  try {
    const [port, wsPath] = (await readFile(ACTIVE_PORT_FILE, "utf8")).trim().split("\n");
    if (wsPath) {
      chromePort = Number(port) || chromePort;
      return `ws://${CHROME_HOST}:${chromePort}${wsPath}`;
    }
  } catch (err) {
    portFileReason = String(err?.message ?? err).split("\n")[0];
  }
  return `ws://${CHROME_HOST}:${chromePort}/devtools/browser`;
}

let socket = null;
let connecting = null;
// Why the one socket is down, phrased for the operator, or null while healthy.
// /shim/status hands it to attach.mjs: "no debugging port" vs "click Allow".
let notAttached = null;
// Set when DevToolsActivePort could not be read: the connection still goes
// ahead over the id-less endpoint, but a failure must name this.
let portFileReason = null;
let seq = 0;
// Ceiling for a proxied command Chrome never answers, looser than our own 15s
// because a client's navigation may be slow. BC_SHIM_PROXY_TIMEOUT_MS moves it.
const PROXY_TIMEOUT_MS = Number(process.env.BC_SHIM_PROXY_TIMEOUT_MS ?? 60_000);
/** shimId -> { resolve, reject } for our own calls, or { client, id, timer, attach, detaching } for proxied ones. */
const pending = new Map();
/** Every attached automation client. A page client also carries its CDP session. */
const clients = new Set();
// sessionId -> owning client, learnt only from attach REPLIES (Chrome names the
// session there) and forgotten on detach. Untracked client-opened sessions sent
// one run's page events to every other browser-endpoint client instead.
const sessionOwner = new Map();
const ATTACH_METHODS = new Set(["Target.attachToTarget", "Target.attachToBrowserTarget"]);

/** Why connect() failed: a hung handshake means Chrome is listening and waiting on Allow, anything else means nothing usable is on that port. */
function whyNotAttached(err) {
  const detail = String(err?.message ?? err).split("\n")[0];
  if (detail.includes("connect timeout")) {
    return `Chrome is listening but never finished the websocket handshake, which is what it does while an approval dialog is open: click Allow in Chrome (${detail})`;
  }
  // The port file is a hint now, not a requirement — but when it could not be
  // read, say so, because that is the difference between "grant Full Disk
  // Access" and "this Chrome has no debugging port at all".
  const aside = portFileReason
    ? ` — and ${ACTIVE_PORT_FILE} could not be read (${portFileReason}), so the id-less /devtools/browser endpoint was used instead: on macOS grant Full Disk Access to whatever starts the shim, or point CHROME_PORT_FILE at a readable copy`
    : "";
  return `nothing usable answered on ${CHROME_HOST}:${chromePort} — set CHROME_HOST/CHROME_PORT if Chrome's debugging port is not the default one (${detail})${aside}`;
}

// Chrome binds 9222 before its DevTools handler is ready, so the first dial after
// a browser restart is closed instantly (measured 2026-10-06: 285 ms, while a
// healthy dial takes ~2.2 s). Retrying that is the difference between "the agent's
// next call works" and "it fell back to the other transport for no reason". A
// `connect timeout` is NOT retried: that one means an approval dialog is open.
const DIAL_RETRIES = Number(process.env.BC_SHIM_DIAL_RETRIES ?? 3);
const DIAL_BACKOFF_MS = Number(process.env.BC_SHIM_DIAL_BACKOFF_MS ?? 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  if (socket?.readyState === WebSocket.OPEN) return socket;
  if (connecting) return connecting;
  connecting = (async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await dial();
      } catch (err) {
        const dialogIsUp = String(err?.message ?? err).includes("timeout");
        if (dialogIsUp || attempt > DIAL_RETRIES) throw err;
        await sleep(DIAL_BACKOFF_MS * attempt);
      }
    }
  })();
  try {
    const ws = await connecting;
    notAttached = null;
    return ws;
  } catch (err) {
    notAttached = whyNotAttached(err);
    throw err;
  } finally {
    connecting = null;
  }
}

/** One dial: the websocket, wired up, or a throw naming how it failed. */
async function dial() {
  const url = await endpoint();
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connect timeout")), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("connect failed"));
    };
    ws.onclose = (e) => {
      clearTimeout(timer);
      reject(new Error(`connect closed ${e.code}`));
    };
  });
  ws.onmessage = (event) => route(JSON.parse(event.data));
  ws.onclose = () => {
    socket = null;
    for (const [id, waiter] of pending) {
      pending.delete(id);
      if (waiter.client) failProxied(waiter, "the shim's browser socket closed before Chrome answered this command; the next attach reconnects and Chrome will ask the operator to click Allow once more");
      else waiter.reject(new Error("browser socket closed"));
    }
    // Reconnecting costs the operator another approval dialog, so say so.
    for (const client of clients) client.conn.close(1001);
    clients.clear();
    sessionOwner.clear(); // every session died with the socket they lived on
    console.error("browser socket closed; the next request reconnects and Chrome will ask the operator to click Allow ONCE more");
  };
  socket = ws;
  connects += 1;
  if (connects > 1) console.error(`reconnected to Chrome (connection #${connects}) — that cost one more approval click`);
  console.log(`attached to ${url}`);
  return ws;
}

/** Chrome → us: answer our own calls, or hand the message back to its client. */
function route(msg) {
  const waiter = msg.id !== undefined ? pending.get(msg.id) : null;
  if (waiter) {
    pending.delete(msg.id);
    if (waiter.client) {
      clearTimeout(waiter.timer);
      // The reply is the only place a client-opened session can be learnt.
      if (waiter.attach && msg.result?.sessionId) sessionOwner.set(msg.result.sessionId, waiter.client);
      // A refused detach left the session alive, so only a clean reply forgets.
      if (waiter.detaching && !msg.error) sessionOwner.delete(waiter.detaching);
      send(waiter.client, { ...msg, id: waiter.id });
    } else if (msg.error) {
      waiter.reject(new Error(msg.error.message));
    } else {
      waiter.resolve(msg.result);
    }
    return;
  }
  if (msg.id !== undefined) return; // a reply nobody is waiting for
  // A crashed or closed target never replies to detach, so this event is the
  // only notice; it rides the PARENT session, so forgetting the child is safe.
  if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) sessionOwner.delete(msg.params.sessionId);
  const owner = msg.sessionId ? sessionOwner.get(msg.sessionId) : null;
  if (owner) {
    send(owner, msg);
    return;
  }
  // No session, or one nobody claims: browser-endpoint clients see it (page
  // clients are deaf to the rest of the browser). Broadcasting beats dropping —
  // a spare copy shows up in a client's log, a vanished event shows up nowhere.
  for (const client of clients) if (!client.sessionId) send(client, msg);
}

/** How many clients speak to the BROWSER endpoint (page clients own a session instead). */
const browserClients = () => [...clients].filter((c) => !c.sessionId).length;

/** A page-endpoint client believes it owns the connection, so its own session id is invisible to it. */
function send(client, msg) {
  const payload = { ...msg };
  if (client.sessionId && payload.sessionId === client.sessionId) delete payload.sessionId;
  if (payload.sessionId === undefined) delete payload.sessionId;
  client.conn.send(JSON.stringify(payload));
}

/** Answer a proxied call with a CDP error; dropped silently it hangs the client's run forever. */
function failProxied(waiter, message) {
  clearTimeout(waiter.timer);
  try {
    send(waiter.client, { id: waiter.id, error: { code: -32_000, message } });
  } catch {} // a closed client connection is the normal case here, not a fault
}

async function cdp(method, params = {}) {
  const ws = await connect();
  const id = ++seq;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`cdp timeout: ${method}`));
    }, 15_000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** Attach a client to the one approved socket; with `targetId` it gets a flat session and never sees a sessionId. */
async function attachClient(conn, targetId) {
  const ws = await connect();
  const client = { conn, sessionId: null };
  if (targetId) {
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    client.sessionId = sessionId;
  }
  clients.add(client);
  if (client.sessionId) sessionOwner.set(client.sessionId, client);
  conn.onMessage = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // not CDP; a client that speaks nonsense gets silence
    }
    if (REFUSED_METHODS.has(msg.method)) {
      console.error(`refused ${msg.method}: the shim does not quit the operator's browser; this client's own connection is unaffected`);
      send(client, { id: msg.id, result: {} });
      return;
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      failProxied({ client, id: msg.id }, `cdp timeout: Chrome did not answer ${msg.method ?? "the command"} within ${PROXY_TIMEOUT_MS}ms; raise BC_SHIM_PROXY_TIMEOUT_MS if this command is legitimately slower`);
    }, PROXY_TIMEOUT_MS);
    const out = { ...msg, id };
    if (client.sessionId && !msg.sessionId) out.sessionId = client.sessionId;
    // route() reads `attach`/`detaching` off the REPLY; the request is the last
    // place to learn them. The deprecated detach form names no session: use ours.
    pending.set(id, { client, id: msg.id, timer, attach: ATTACH_METHODS.has(msg.method), detaching: msg.method === "Target.detachFromTarget" ? (msg.params?.sessionId ?? out.sessionId) : null });
    ws.send(JSON.stringify(out));
  };
  conn.onClose = () => {
    clients.delete(client);
    // Left-behind sessions would route Chrome's events into a socket nobody reads.
    for (const [sessionId, owner] of sessionOwner) if (owner === client) sessionOwner.delete(sessionId);
    for (const [id, waiter] of pending) {
      if (waiter.client !== client) continue;
      clearTimeout(waiter.timer); // nobody is left to answer; the socket is gone
      pending.delete(id);
    }
    // Detaching keeps Chrome tidy; the approved browser socket stays open.
    if (client.sessionId) cdp("Target.detachFromTarget", { sessionId: client.sessionId }).catch(() => {});
    // Target.setAutoAttach is per-CONNECTION state and every client shares this
    // one: after the first client enabled it the next run saw 0 pages where run
    // 1 saw 2 (measured 2026-10-02), so the last one out clears it. Only on a
    // live socket — cdp() would reconnect and pop a dialog with nobody waiting.
    if (!client.sessionId && !browserClients() && socket?.readyState === WebSocket.OPEN) {
      cdp("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    }
    console.log(`client detached (${clients.size} left)`);
  };
  console.log(`client attached${targetId ? ` to page ${targetId}` : ""} (${clients.size} total)`);
}

// Handlers return { body, status, type } and the Node server writes them out.
const json = (body, status = 200) => ({ status, type: "application/json; charset=UTF-8", body: JSON.stringify(body, null, 2) });
const text = (body, status = 200) => ({ status, type: "text/plain; charset=UTF-8", body });

// Every advertised ws URL points at the SHIM: dialling Chrome pops a new dialog.
const SHIM_WS = `ws://127.0.0.1:${LISTEN_PORT}`;

const describe = (t) => ({
  description: "",
  devtoolsFrontendUrl: `/devtools/inspector.html?ws=${CHROME_HOST}:${chromePort}/devtools/page/${t.targetId}`,
  id: t.targetId,
  title: t.title ?? "",
  type: t.type ?? "page",
  url: t.url ?? "",
  webSocketDebuggerUrl: `${SHIM_WS}/devtools/page/${t.targetId}`,
});

async function pages() {
  const { targetInfos } = await cdp("Target.getTargets");
  return targetInfos.filter((t) => t.type === "page");
}

async function handle(rawUrl) {
  const url = new URL(rawUrl, `http://127.0.0.1:${LISTEN_PORT}`);
  const searchParams = url.searchParams;
  // playwright asks for "/json/version/", other clients "/json/version".
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  // Ahead of the try on purpose: this must answer while Chrome is unreachable,
  // which is exactly when attach.mjs asks. Not /json/*, which is DevTools'.
  if (pathname === "/shim/status") {
    return json({ attached: socket?.readyState === WebSocket.OPEN, reason: notAttached, chrome: `${CHROME_HOST}:${chromePort}`, portFile: ACTIVE_PORT_FILE });
  }
  try {
    if (pathname === "/json/version") {
      const v = await cdp("Browser.getVersion");
      return json({
        Browser: v.product,
        "Protocol-Version": v.protocolVersion,
        "User-Agent": v.userAgent,
        "V8-Version": v.jsVersion,
        "WebKit-Version": v.revision,
        webSocketDebuggerUrl: `${SHIM_WS}/devtools/browser/shim`,
      });
    }
    if (pathname === "/json" || pathname === "/json/list") return json((await pages()).map(describe));
    if (pathname === "/json/new") {
      const target = searchParams.get("url") ?? "about:blank";
      const { targetId } = await cdp("Target.createTarget", { url: target });
      const created = (await pages()).find((t) => t.targetId === targetId);
      return json(describe(created ?? { targetId, url: target }));
    }
    if (pathname.startsWith("/json/activate/")) {
      await cdp("Target.activateTarget", { targetId: pathname.split("/").pop() });
      return text("Target activated");
    }
    if (pathname.startsWith("/json/close/")) {
      await cdp("Target.closeTarget", { targetId: pathname.split("/").pop() });
      return text("Target is closing");
    }
    return text("", 404);
  } catch (err) {
    return json({ error: String(err?.message ?? err) }, 500);
  }
}

const server = createServer(async (req, res) => {
  const out = await handle(req.url);
  res.writeHead(out.status, { "Content-Type": out.type });
  res.end(out.body);
});

server.on("upgrade", async (req, socket, head) => {
  const path = new URL(req.url, SHIM_WS).pathname;
  const page = /^\/devtools\/page\/(.+)$/.exec(path);
  if (!page && !/^\/devtools\/browser\//.test(path)) {
    socket.destroy();
    return;
  }
  const conn = upgrade(req, socket, head);
  if (!conn) {
    socket.destroy();
    return;
  }
  // node hands over upgraded sockets half-open: a client that exits without a
  // close frame stays "attached" and keeps setAutoAttach set (2026-10-02).
  socket.on("end", () => conn.close(1001));
  try {
    await attachClient(conn, page?.[1]);
  } catch (err) {
    console.log(`client attach failed: ${String(err?.message ?? err).split("\n")[0]}`);
    conn.close(1011);
  }
});

// EADDRINUSE is a verdict, not a stray error: another shim owns the port and
// serves our clients, so this one stands down instead of holding an approval
// grant nobody can reach. The loser only dials Chrome from the listen callback
// below, so it spends no dialog; attach.mjs's probeShim() sees the winner's port.
server.on("error", (err) => {
  if (err?.code !== "EADDRINUSE") {
    // Any other listen error: a resident service does not get to die of one.
    console.error(
      `shim http server error: ${String(err?.message ?? err).split("\n")[0]} — the shim stays up so the approved Chrome socket survives; set SHIM_PORT to move it to a port it can have`,
    );
    return;
  }
  console.error(
    `another shim already serves 127.0.0.1:${LISTEN_PORT}, so this process is standing down rather than sitting on an approved Chrome socket nobody can reach; set SHIM_PORT to run a second shim on a free port`,
  );
  socket?.close(1001); // give the approval grant back before leaving
  process.exit(0); // the port ended up in the state we wanted, so this is no failure
});

// Same rule one layer up: a stray rejection is fatal on Node 22 otherwise.
process.on("unhandledRejection", (err) => {
  console.error(`shim ignored an unhandled rejection: ${String(err?.message ?? err).split("\n")[0]} — the shim stays up so the approved Chrome socket survives`);
});

// The two log files are the only thing this process leaves on the machine, and
// launchd appends to them forever. Truncating at startup (the fd is O_APPEND, so
// the next write restarts at 0) bounds the footprint without a rotation scheme
// nobody would ever read. BC_SHIM_LOG_DIR / BC_SHIM_LOG_MAX move the numbers.
for (const name of ["shim.log", "shim.err.log"]) {
  const file = path.join(LOG_DIR, name);
  try {
    if (statSync(file).size > LOG_MAX) truncateSync(file, 0);
  } catch {} // no log file, or none we may touch: nothing to cap
}

// Dialling Chrome only after the bind succeeds is what keeps approval clicks =
// shim processes: the EADDRINUSE loser must not spend a grant it takes to the
// grave. Connecting is an optimisation, not a precondition — Chrome may not be
// running yet, so failure is logged and the port keeps listening for a retry.
server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(
    `cdp-shim ready on http://127.0.0.1:${LISTEN_PORT} (one approved Chrome connection, proxied; keep-alive ${KEEPALIVE_MS || "off"}${KEEPALIVE_MS ? "ms" : ""})`,
  );
  connect().catch(() => {
    console.error(`not attached to Chrome yet — ${notAttached}; the shim is listening on ${LISTEN_PORT} and retries on the first request`);
  });
});

// Keep the approved socket warm, and only ever ping an OPEN one: reconnecting
// from a timer would pop the approval dialog with nobody waiting on it.
if (KEEPALIVE_MS > 0) {
  const beat = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    cdp("Browser.getVersion").catch(() => {}); // a dead socket is handled by onclose, not here
  }, KEEPALIVE_MS);
  beat.unref(); // never the reason this process stays alive
}
