// Long-lived CDP HTTP discovery shim for the operator's real Chrome.
//
// Runs on Node (>= 22, for the global WebSocket) — same runtime as the rest of
// the harness, which is pinned by ../.nvmrc.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// Chrome 152 on the default profile serves the DevTools websocket but 404s every
// /json HTTP endpoint, which puppeteer-style clients need for discovery. We hold ONE
// persistent browser websocket (auto-reconnecting) and rebuild the /json endpoints on
// top of it, so attaching never re-handshakes and never re-prompts.
const CHROME_HOST = process.env.CHROME_HOST ?? "127.0.0.1";
const LISTEN_PORT = Number(process.env.SHIM_PORT ?? 9333);
const ACTIVE_PORT_FILE =
  process.env.CHROME_PORT_FILE ??
  `${process.env.HOME}/Library/Application Support/Google/Chrome/DevToolsActivePort`;

let chromePort = Number(process.env.CHROME_PORT ?? 9222);

async function endpoint() {
  const [port, path] = (await readFile(ACTIVE_PORT_FILE, "utf8")).trim().split("\n");
  if (!path) throw new Error("DevToolsActivePort has no websocket path");
  chromePort = Number(port) || chromePort;
  return `ws://${CHROME_HOST}:${chromePort}${path}`;
}

let socket = null;
let connecting = null;
let seq = 0;
const pending = new Map();

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
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
    };
    ws.onclose = () => {
      socket = null;
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(new Error("browser socket closed"));
      }
      console.log("browser socket closed; will reconnect on next request");
    };
    socket = ws;
    console.log(`attached to ${url}`);
    return ws;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
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

// Handlers return { body, status, type } and the Node server writes them out.
const json = (body, status = 200) => ({ status, type: "application/json; charset=UTF-8", body: JSON.stringify(body, null, 2) });
const text = (body, status = 200) => ({ status, type: "text/plain; charset=UTF-8", body });

const describe = (t) => ({
  description: "",
  devtoolsFrontendUrl: `/devtools/inspector.html?ws=${CHROME_HOST}:${chromePort}/devtools/page/${t.targetId}`,
  id: t.targetId,
  title: t.title ?? "",
  type: t.type ?? "page",
  url: t.url ?? "",
  webSocketDebuggerUrl: `ws://${CHROME_HOST}:${chromePort}/devtools/page/${t.targetId}`,
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
        webSocketDebuggerUrl: await endpoint(),
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

createServer(async (req, res) => {
  const out = await handle(req.url);
  res.writeHead(out.status, { "Content-Type": out.type });
  res.end(out.body);
}).listen(LISTEN_PORT, "127.0.0.1");

await connect();
console.log(`cdp-shim ready on http://127.0.0.1:${LISTEN_PORT}`);
