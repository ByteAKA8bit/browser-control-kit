// Long-lived CDP shim for the operator's real Chrome: ONE approved connection.
//
// Runs on Node (>= 22, for the global WebSocket) — same runtime as the rest of
// the harness, which is pinned by ../.nvmrc.
//
// Why it exists, in order of how much pain each point caused:
//
//   1. Chrome asks the operator to approve EVERY new external CDP connection to
//      the default profile, and the grant is not persisted. Until it is
//      approved, /json/* answers 404 and the websocket handshake just hangs.
//      So the shim keeps ONE approved browser socket and *proxies* every client
//      over it: approve once per Chrome restart, not once per run. Handing out
//      Chrome's own websocket URL (what this file used to do) meant a fresh
//      dialog per attach — the shim only ever saved the HTTP half of the job.
//   2. The same Chrome serves the DevTools websocket but 404s /json discovery,
//      which puppeteer-style clients need; those endpoints are rebuilt here on
//      top of the one socket.
//
// Multiplexing rules: command ids are rewritten to shim-global ids and mapped
// back per client; events without a session go to every browser-endpoint
// client; a client attached to /devtools/page/<targetId> gets its own flat CDP
// session, with sessionId stripped on the way out and injected on the way in.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upgrade } from "./ws-server.mjs";

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
// A browser socket that drops costs the operator another "Allow" click, and an
// idle websocket is exactly what intermediaries and sleep states reap. One
// Browser.getVersion per interval keeps it warm; 0 disables the timer.
const KEEPALIVE_MS = Number(process.env.BC_SHIM_KEEPALIVE_MS ?? 30_000);
let connects = 0;

// Browser-destroying commands the shim answers ITSELF instead of forwarding.
// The operator's Chrome is not ours to quit: a playwright `browser.close()` on
// a connectOverCDP connection sends Browser.close, and over this shared socket
// that killed the operator's real browser (and then the shim, reconnecting into
// nothing) — measured twice on 2026-10-02. A `{}` reply is what the client
// wants anyway; it drops its own socket next, which is all closing a *client*
// ever needed. Crash/crashGpuProcess are the same weapon with a worse exit.
const REFUSED_METHODS = new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess"]);

async function endpoint() {
  const [port, path] = (await readFile(ACTIVE_PORT_FILE, "utf8")).trim().split("\n");
  if (!path) throw new Error("DevToolsActivePort has no websocket path");
  chromePort = Number(port) || chromePort;
  return `ws://${CHROME_HOST}:${chromePort}${path}`;
}

let socket = null;
let connecting = null;
let seq = 0;
/** shimId -> { resolve, reject } for our own calls, or { client, id } for proxied ones. */
const pending = new Map();
/** Every attached automation client. A page client also carries its CDP session. */
const clients = new Set();

async function connect() {
  if (socket?.readyState === WebSocket.OPEN) return socket;
  if (connecting) return connecting;
  connecting = (async () => {
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
        waiter.reject?.(new Error("browser socket closed"));
      }
      // Reconnecting costs the operator another approval dialog, so say so.
      for (const client of clients) client.conn.close(1001);
      clients.clear();
      console.error("browser socket closed; the next request reconnects and Chrome will ask the operator to click Allow ONCE more");
    };
    socket = ws;
    connects += 1;
    if (connects > 1) console.error(`reconnected to Chrome (connection #${connects}) — that cost one more approval click`);
    console.log(`attached to ${url}`);
    return ws;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Chrome → us: answer our own calls, or hand the message back to its client. */
function route(msg) {
  const waiter = msg.id !== undefined ? pending.get(msg.id) : null;
  if (waiter) {
    pending.delete(msg.id);
    if (waiter.client) {
      send(waiter.client, { ...msg, id: waiter.id });
    } else if (msg.error) {
      waiter.reject(new Error(msg.error.message));
    } else {
      waiter.resolve(msg.result);
    }
    return;
  }
  if (msg.id !== undefined) return; // a reply nobody is waiting for
  for (const client of clients) {
    if (client.sessionId) {
      if (msg.sessionId === client.sessionId) send(client, msg);
    } else if (!msg.sessionId || !ownedSession(msg.sessionId)) {
      send(client, msg);
    }
  }
}

const ownedSession = (sessionId) => [...clients].some((c) => c.sessionId === sessionId);
/** How many clients speak to the BROWSER endpoint (page clients own a session instead). */
const browserClients = () => [...clients].filter((c) => !c.sessionId).length;

/** A page-endpoint client believes it owns the connection, so its own session id is invisible to it. */
function send(client, msg) {
  const payload = { ...msg };
  if (client.sessionId && payload.sessionId === client.sessionId) delete payload.sessionId;
  if (payload.sessionId === undefined) delete payload.sessionId;
  client.conn.send(JSON.stringify(payload));
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

/**
 * Attach an automation client to the one approved socket.
 * `targetId` set → the client believes it is talking straight to a page, so it
 * gets a flat session and never sees a sessionId.
 */
async function attachClient(conn, targetId) {
  const ws = await connect();
  const client = { conn, sessionId: null };
  if (targetId) {
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    client.sessionId = sessionId;
  }
  clients.add(client);
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
    pending.set(id, { client, id: msg.id });
    const out = { ...msg, id };
    if (client.sessionId && !msg.sessionId) out.sessionId = client.sessionId;
    ws.send(JSON.stringify(out));
  };
  conn.onClose = () => {
    clients.delete(client);
    for (const [id, waiter] of pending) if (waiter.client === client) pending.delete(id);
    // Detaching keeps Chrome tidy; the approved browser socket stays open.
    if (client.sessionId) cdp("Target.detachFromTarget", { sessionId: client.sessionId }).catch(() => {});
    // Target.setAutoAttach is per-CONNECTION state, and every client shares this
    // one connection: after the first client enabled it Chrome treats every page
    // as already attached and reports nothing to the NEXT client, which then
    // sees an empty browser (measured 2026-10-02: run 1 saw 2 pages, run 2 saw
    // 0). Clearing it when the last browser-endpoint client leaves makes the
    // next run — the whole point of keeping the shim alive — see the real tabs.
    // Only ever on a live socket: calling cdp() here would otherwise reconnect
    // and pop an approval dialog with nobody waiting for it.
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

// Every advertised websocket URL points at the SHIM, never at Chrome: a client
// that dials Chrome directly would trigger a fresh approval dialog.
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
  // playwright's connectOverCDP requests "/json/version/" (trailing slash),
  // other clients request "/json/version" — normalise so both work.
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
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
  // node's http server hands over upgraded sockets in half-open mode, so a
  // client that dies without a close frame (an automation run that just exits)
  // leaves us in CLOSE_WAIT and "attached" forever — and a client that is still
  // attached in Chrome's eyes keeps the shared socket's Target.setAutoAttach
  // state, which makes the NEXT run see an empty browser. Measured 2026-10-02.
  socket.on("end", () => conn.close(1001));
  try {
    await attachClient(conn, page?.[1]);
  } catch (err) {
    console.log(`client attach failed: ${String(err?.message ?? err).split("\n")[0]}`);
    conn.close(1011);
  }
});

server.listen(LISTEN_PORT, "127.0.0.1");

await connect();

// Keep the approved socket warm. Only ever pings an OPEN socket: reconnecting
// from a background timer would pop the approval dialog in the operator's face
// with nothing waiting on it. BC_SHIM_KEEPALIVE_MS=0 switches it off.
if (KEEPALIVE_MS > 0) {
  const beat = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    cdp("Browser.getVersion").catch(() => {}); // a dead socket is handled by onclose, not here
  }, KEEPALIVE_MS);
  beat.unref(); // never the reason this process stays alive
}

console.log(
  `cdp-shim ready on http://127.0.0.1:${LISTEN_PORT} (one approved Chrome connection, proxied; keep-alive ${KEEPALIVE_MS || "off"}${KEEPALIVE_MS ? "ms" : ""})`,
);
