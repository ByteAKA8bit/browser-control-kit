// Why these exist: the shim multiplexes every automation client over the ONE
// approved Chrome socket, so a CDP event that Chrome sends once must be handed
// to exactly the client it belongs to. Events carry a sessionId and nothing
// else: get the ownership wrong and the mistake is silent in both directions —
// a client reading another client's page (two automation runs sharing the
// operator's browser is the normal case here, not an exotic one), and the
// client that actually opened the session seeing nothing at all, which looks
// like a page that never emits anything rather than like a routing bug.
//
// Sessions come from two places and only one of them used to be tracked:
//   1. the shim's own flat session for a /devtools/page/<targetId> client;
//   2. a session the CLIENT opened itself with Target.attachToTarget — an
//      out-of-process iframe, a worker, a second tab, or anything
//      playwright/puppeteer attaches to on its own.
// Ownership also has to be given BACK, or a detached session keeps routing
// events to a client that no longer has it.
//
// Hermetic: a fake CDP browser built from node:http + ../src/ws-server.mjs that
// hands out session ids and can emit any event on demand, a real shim child
// process pointed at it, and raw WebSocket clients. No Chrome.
//
//   node --test test/shim-session.test.mjs
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { upgrade } from "../src/ws-server.mjs";

const SHIM = fileURLToPath(new URL("../src/cdp-shim.mjs", import.meta.url));
const FAKE_PATH = "/devtools/browser/fake";
const PAGE_TARGET = "PAGE-1";

let fake;
let shim;
let shimPort;
/** Every client socket this file opened, closed at the end however the run went. */
const opened = new Set();

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/**
 * A CDP browser that hands out a fresh session id for every attach, echoes
 * everything else, and emits whatever event the test asks for. It mirrors the
 * real protocol in the two places that matter here: a reply carries back the
 * sessionId the command ran on, and an attach reply carries the NEW session.
 */
function startFake() {
  const state = { server: null, conn: null, sessions: new Map(), seq: 0 };
  state.server = createServer((_req, res) => res.end());
  state.server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://127.0.0.1").pathname !== FAKE_PATH) return socket.destroy();
    const conn = upgrade(req, socket, head);
    if (!conn) return socket.destroy();
    state.conn = conn;
    conn.onMessage = (raw) => {
      const msg = JSON.parse(raw);
      const reply = { id: msg.id, result: { echoed: msg.method } };
      if (msg.sessionId) reply.sessionId = msg.sessionId; // Chrome answers on the session it ran on
      if (msg.method === "Target.attachToTarget" || msg.method === "Target.attachToBrowserTarget") {
        const sessionId = `SESSION-${++state.seq}`;
        state.sessions.set(msg.params?.targetId ?? "browser", sessionId);
        reply.result = { sessionId };
      }
      conn.send(JSON.stringify(reply));
    };
  });
  /** Push an unsolicited event down the one browser socket, exactly as Chrome would. */
  state.emit = (event) => state.conn.send(JSON.stringify(event));
  state.close = () =>
    new Promise((resolve) => {
      state.conn?.socket?.destroy(); // a killed shim leaves its upgraded socket behind
      state.server.closeAllConnections();
      state.server.close(resolve);
    });
  return state;
}

/**
 * One automation client. `events` collects everything that is not a reply, so a
 * test can assert both who got a message and who did not.
 */
async function connect(path) {
  const ws = new WebSocket(`ws://127.0.0.1:${shimPort}${path}`);
  opened.add(ws);
  const client = { ws, events: [], waiting: new Map(), seq: 0 };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`a client could not reach the shim at ${path}`));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && client.waiting.has(msg.id)) client.waiting.get(msg.id)(msg);
    else client.events.push(msg);
  };
  client.call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++client.seq;
      const timer = setTimeout(() => reject(new Error(`no reply to ${method} on ${path}`)), 5_000);
      client.waiting.set(id, (msg) => {
        clearTimeout(timer);
        client.waiting.delete(id);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  // A round trip over the same two sockets the events travel on: once the reply
  // is here, anything the fake emitted BEFORE the command had already arrived.
  // That is an ordering guarantee, not a sleep, so "nobody else got it" is
  // decidable instead of merely likely.
  client.settle = () => client.call("Runtime.evaluate", { expression: "1" });
  return client;
}

const methodsOn = (client, sessionId) => client.events.filter((e) => e.sessionId === sessionId).map((e) => e.method);

let browserA;
let browserB;
let page;

before(async () => {
  fake = startFake();
  const fakePort = await listen(fake.server);

  // The shim learns where Chrome is from a DevToolsActivePort file; point it here.
  const dir = await mkdtemp(join(tmpdir(), "shim-session-"));
  const portFile = join(dir, "DevToolsActivePort");
  await writeFile(portFile, `${fakePort}\n${FAKE_PATH}\n`);

  // Grab a free port for the shim, then hand it over.
  const probe = createServer();
  shimPort = await listen(probe);
  await new Promise((r) => probe.close(r));

  shim = spawn(process.execPath, [SHIM], {
    env: { ...process.env, SHIM_PORT: String(shimPort), CHROME_PORT_FILE: portFile, BC_SHIM_KEEPALIVE_MS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shim never reported ready")), 10_000);
    shim.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (chunk.includes("cdp-shim ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    shim.stderr.resume(); // drained so the child never blocks on a full pipe
  });

  browserA = await connect("/devtools/browser/shim");
  browserB = await connect("/devtools/browser/shim");
  page = await connect(`/devtools/page/${PAGE_TARGET}`);
});

after(async () => {
  for (const ws of opened) ws.close();
  shim?.kill("SIGKILL");
  await fake.close();
});

describe("events for a session the client opened itself", () => {
  let own;

  it("reaches the client that opened it", async () => {
    const reply = await browserA.call("Target.attachToTarget", { targetId: "TARGET-A", flatten: true });
    own = reply.result.sessionId;
    assert.ok(own, "the fake browser must hand out a session id");

    fake.emit({ method: "Runtime.consoleAPICalled", sessionId: own, params: { type: "log" } });
    await Promise.all([browserA.settle(), browserB.settle(), page.settle()]);

    assert.deepEqual(methodsOn(browserA, own), ["Runtime.consoleAPICalled"]);
  });

  it("is not broadcast to the other browser-endpoint client", () => {
    assert.deepEqual(methodsOn(browserB, own), []);
  });

  it("is not broadcast to a page-endpoint client", () => {
    assert.deepEqual(methodsOn(page, own), []);
  });
});

describe("events for a nested session a page client opened", () => {
  let nested;

  it("reaches the page client that opened it", async () => {
    const reply = await page.call("Target.attachToTarget", { targetId: "IFRAME-1", flatten: true });
    nested = reply.result.sessionId;

    fake.emit({ method: "Network.requestWillBeSent", sessionId: nested, params: { requestId: "7" } });
    await Promise.all([browserA.settle(), browserB.settle(), page.settle()]);

    assert.deepEqual(methodsOn(page, nested), ["Network.requestWillBeSent"]);
  });

  it("keeps the nested sessionId, which is not the one the page client is flattened onto", () => {
    const event = page.events.find((e) => e.method === "Network.requestWillBeSent");
    assert.equal(event.sessionId, nested);
  });

  it("does not leak to browser-endpoint clients", () => {
    assert.deepEqual(methodsOn(browserA, nested), []);
    assert.deepEqual(methodsOn(browserB, nested), []);
  });

  it("leaves the page client's own flat session stripped of its sessionId", async () => {
    const flat = fake.sessions.get(PAGE_TARGET);
    fake.emit({ method: "Page.loadEventFired", sessionId: flat, params: {} });
    await Promise.all([browserA.settle(), page.settle()]);

    const event = page.events.find((e) => e.method === "Page.loadEventFired");
    assert.ok(event, "the page client must receive events on the session the shim opened for it");
    assert.equal("sessionId" in event, false, "a page client believes it owns the connection");
    assert.deepEqual(
      browserA.events.filter((e) => e.method === "Page.loadEventFired"),
      [],
    );
  });
});

describe("a session is forgotten once it ends", () => {
  it("when the owner detaches it, later events fall back to the browser endpoint", async () => {
    const { result } = await browserA.call("Target.attachToTarget", { targetId: "TARGET-DETACH", flatten: true });
    const gone = result.sessionId;
    await browserA.call("Target.detachFromTarget", { sessionId: gone });

    fake.emit({ method: "Runtime.consoleAPICalled", sessionId: gone, params: { type: "log" } });
    await Promise.all([browserA.settle(), browserB.settle()]);

    assert.deepEqual(methodsOn(browserB, gone), ["Runtime.consoleAPICalled"], "a detached session must not stay owned");
  });

  it("when Chrome reports Target.detachedFromTarget", async () => {
    const { result } = await browserA.call("Target.attachToTarget", { targetId: "TARGET-CRASHED", flatten: true });
    const gone = result.sessionId;

    fake.emit({ method: "Target.detachedFromTarget", params: { sessionId: gone, targetId: "TARGET-CRASHED" } });
    fake.emit({ method: "Runtime.consoleAPICalled", sessionId: gone, params: { type: "log" } });
    await Promise.all([browserA.settle(), browserB.settle()]);

    assert.deepEqual(methodsOn(browserB, gone), ["Runtime.consoleAPICalled"]);
  });

  it("when the owning client disconnects, its events are not swallowed", async () => {
    const leaving = await connect("/devtools/browser/shim");
    const { result } = await leaving.call("Target.attachToTarget", { targetId: "TARGET-LEAVER", flatten: true });
    const orphan = result.sessionId;
    leaving.ws.close();
    // The shim must have processed the close before the event arrives; a round
    // trip on another client only orders the browser socket, not this one.
    await new Promise((resolve) => {
      leaving.ws.onclose = resolve;
    });

    fake.emit({ method: "Runtime.consoleAPICalled", sessionId: orphan, params: { type: "log" } });
    await Promise.all([browserA.settle(), browserB.settle()]);

    assert.deepEqual(methodsOn(browserA, orphan), ["Runtime.consoleAPICalled"], "an orphaned session must not swallow events");
    assert.equal(shim.exitCode, null, "the shim must survive an event for a client that left");
  });
});

describe("an event for a session nobody claimed", () => {
  it("still reaches every browser-endpoint client", async () => {
    fake.emit({ method: "Target.targetCreated", sessionId: "SESSION-FROM-NOWHERE", params: {} });
    await Promise.all([browserA.settle(), browserB.settle()]);

    assert.deepEqual(methodsOn(browserA, "SESSION-FROM-NOWHERE"), ["Target.targetCreated"]);
    assert.deepEqual(methodsOn(browserB, "SESSION-FROM-NOWHERE"), ["Target.targetCreated"]);
  });

  it("reaches them without a session too", async () => {
    fake.emit({ method: "Target.targetDestroyed", params: { targetId: "T" } });
    await Promise.all([browserA.settle(), browserB.settle()]);

    assert.ok(browserA.events.some((e) => e.method === "Target.targetDestroyed"));
    assert.ok(browserB.events.some((e) => e.method === "Target.targetDestroyed"));
  });
});
