// Why these exist: the shim is a resident process between every automation run
// and the operator's one approved Chrome socket, so its FAILURE modes are what
// an operator actually meets. Four of them had no test and each one is silent
// by nature:
//   1. a proxied command Chrome never answers — the client waits forever, which
//      looks like a hang with no error anywhere (the worst outcome this process
//      can produce), and the same hole swallows a browser socket that drops
//      under in-flight commands;
//   2. a second shim started on a port that is already served — it must stand
//      down instead of becoming a zombie holding an approval grant nobody can
//      reach, and it must not spend a grant (an "Allow" click) on the way out;
//   3. Chrome not reachable at all — the shim must keep listening and /shim/status
//      must still answer, because that is exactly when attach.mjs asks it why;
//   4. the same answer read back by attach(), which is where it reaches the
//      operator: "no shim is running" and "a shim is running but never reached
//      Chrome" need opposite actions and must never arrive as one message.
// Hermetic: a fake CDP browser built from node:http + ../src/ws-server.mjs that
// can be told to answer nothing or drop the socket, real ../src/cdp-shim.mjs
// child processes on OS-chosen ports, and raw WebSocket clients. No Chrome.
//
//   node --test test/shim-recovery.test.mjs
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attach } from "../src/attach.mjs";
import { upgrade } from "../src/ws-server.mjs";

const SHIM = fileURLToPath(new URL("../src/cdp-shim.mjs", import.meta.url));
const FAKE_PATH = "/devtools/browser/fake";

/** Every shim child this file started, reaped at the end however the run went. */
const children = new Set();
after(() => {
  for (const child of children) child.kill("SIGKILL");
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// One ceiling for every wait here. Each one polls a CONDITION and stops on it,
// so a loaded runner costs seconds rather than a pass: time is where we give up,
// never the proof that something happened.
const PATIENCE_MS = 10_000;
// The proxy ceiling the first suite runs under. Short enough to observe quickly,
// long enough that a stalled runner cannot make a healthy reply look late.
const PROXY_MS = 1_000;
/** The fake's ordering marker: an event, so it can never be mistaken for a reply. */
const MARKER = "Runtime.executionContextsCleared";

/** Ports already handed out here: the kernel reuses one it has just taken back. */
const handedOut = new Set();

/** A port nothing listens on: bind one, read it, give it straight back. */
async function freePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    await new Promise((r) => server.close(r));
    if (handedOut.has(port)) continue;
    handedOut.add(port);
    return port;
  }
  throw new Error("every port offered here had already been used by this file");
}

/**
 * A CDP browser that can be unhelpful on purpose: `hold()` makes it record
 * commands and answer nothing (the hang the shim must end on its own), `flush()`
 * delivers those answers late, `drop()` closes the one browser socket under
 * whatever is in flight and `marker()` sends an event that orders everything
 * sent before it. `connections` counts approval grants it would have cost.
 */
function startFake() {
  const fake = { connections: 0, held: [], mode: "reply", conn: null };
  fake.server = createServer((_req, res) => res.end());
  fake.server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://127.0.0.1").pathname !== FAKE_PATH) return socket.destroy();
    const conn = upgrade(req, socket, head);
    if (!conn) return socket.destroy();
    fake.connections += 1;
    fake.conn = conn;
    conn.onMessage = (raw) => {
      const msg = JSON.parse(raw);
      if (fake.mode === "hold") {
        fake.held.push(msg);
        return;
      }
      conn.send(JSON.stringify({ id: msg.id, result: { echoed: msg.method } }));
    };
  });
  fake.hold = () => {
    fake.mode = "hold";
  };
  fake.answer = () => {
    fake.mode = "reply";
  };
  fake.flush = () => {
    for (const msg of fake.held.splice(0)) fake.conn.send(JSON.stringify({ id: msg.id, result: { echoed: msg.method, late: true } }));
  };
  fake.drop = () => fake.conn.close(1001);
  // An event rather than a reply, so it rides the same socket BEHIND whatever
  // the fake has already sent: see `settle`.
  fake.marker = () => fake.conn.send(JSON.stringify({ method: MARKER }));
  fake.listen = async () => {
    await new Promise((r) => fake.server.listen(0, "127.0.0.1", r));
    return fake.server.address().port;
  };
  // A killed shim leaves its upgraded socket behind and node's http server
  // waits for it forever, so drop it by hand rather than hang the whole file.
  fake.close = () =>
    new Promise((r) => {
      fake.conn?.socket?.destroy();
      fake.server.closeAllConnections();
      fake.server.close(r);
    });
  return fake;
}

/** A DevToolsActivePort file in a fresh temp dir, pointing wherever we say. */
async function portFileFor(port, wsPath = FAKE_PATH) {
  const dir = await mkdtemp(join(tmpdir(), "shim-recovery-"));
  const file = join(dir, "DevToolsActivePort");
  if (port !== null) await writeFile(file, `${port}\n${wsPath}\n`);
  return file;
}

/** Spawn the real shim. `ready` resolves on its own readiness line, `exited` on its exit. */
function startShim(env) {
  const child = spawn(process.execPath, [SHIM], {
    env: { ...process.env, CHROME_HOST: "127.0.0.1", CHROME_PORT: "9222", BC_SHIM_KEEPALIVE_MS: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const log = { out: "", err: "" };
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`shim never reported ready (out: ${log.out} err: ${log.err})`)), 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      log.out += chunk;
      if (log.out.includes("cdp-shim ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`shim exited with code ${code} before it was ready (err: ${log.err})`));
    });
  });
  ready.catch(() => {}); // a shim we expect to stand down is never awaited
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    log.err += chunk;
  });
  return { child, log, ready, exited };
}

/**
 * A shim that OWNS its port. Between freePort() handing a port back and the
 * child binding it anything on the machine may take it, and a shim that finds
 * its port already served stands down with exit 0 — which would read here as a
 * broken suite instead of the race it was. So try somewhere else.
 */
async function startShimOnFreePort(env, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    const port = await freePort();
    const shim = startShim({ ...env, SHIM_PORT: String(port) });
    try {
      await shim.ready;
      return { port, shim };
    } catch (err) {
      // Exit 0 before readiness is the stand-down path and nothing else.
      if (shim.child.exitCode !== 0 || attempt === attempts) throw err;
    }
  }
}

/** A raw CDP client on the shim's browser endpoint, recording EVERY reply per id. */
async function connectClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/shim`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the shim did not accept a client within ${PATIENCE_MS}ms`)), PATIENCE_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("client could not reach the shim"));
    };
  });
  const replies = new Map(); // id -> [msg, ...]; a second entry is a duplicate delivery
  const wake = new Map();
  let markers = 0;
  // Under the same ceiling as every other wait here: a shim that stops hanging
  // up on its clients must turn this file red rather than park it. Unref'd and
  // pre-caught because most clients are closed by the test and never awaited.
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the shim did not close this client within ${PATIENCE_MS}ms`)), PATIENCE_MS);
    timer.unref();
    ws.onclose = (event) => {
      clearTimeout(timer);
      resolve(event.code);
    };
  });
  closed.catch(() => {}); // a client nobody awaits must not reject into the void
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id === undefined) {
      if (msg.method === MARKER) markers += 1;
      return; // an event, not a reply
    }
    replies.set(msg.id, [...(replies.get(msg.id) ?? []), msg]);
    wake.get(msg.id)?.();
  };
  let last = 0;
  const send = (method, params = {}) => {
    const id = ++last;
    ws.send(JSON.stringify({ id, method, params }));
    return id;
  };
  const reply = (id, ms = PATIENCE_MS) =>
    new Promise((resolve, reject) => {
      if (replies.get(id)?.length) return resolve(replies.get(id)[0]);
      const timer = setTimeout(() => reject(new Error(`no reply to id ${id} within ${ms}ms`)), ms);
      wake.set(id, () => {
        clearTimeout(timer);
        resolve(replies.get(id)[0]);
      });
    });
  return { ws, send, reply, replies, closed, markers: () => markers, close: () => ws.close() };
}

const getJson = async (port, path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
};

/** Poll `fn` until it returns something truthy, or give up loudly. */
async function until(fn, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms}ms`);
    await sleep(50);
  }
}

/** Wait for the shim's one browser socket: "cdp-shim ready" is the PORT, not Chrome. */
const attachedToChrome = (port) => until(async () => (await getJson(port, "/shim/status")).body.attached, PATIENCE_MS, "the shim to reach the fake browser");

/**
 * Wait until the shim has handled everything the fake has sent it. The marker
 * event travels the one browser socket behind those messages, so a client that
 * has seen it proves they were handled first — an ordering guarantee, not a sleep.
 */
async function settle(fake, client) {
  const want = client.markers() + 1;
  fake.marker();
  await until(() => client.markers() >= want, PATIENCE_MS, "the marker event to come back through the shim");
}

describe("a command the browser never answers still ends", () => {
  const fake = startFake();
  let shimPort;
  let shim;
  let client;
  let timedOutId;

  before(async () => {
    const chromePort = await fake.listen();
    // A short ceiling instead of the 60s default: the behaviour under test is
    // "the client gets an answer", not how long the ceiling is.
    ({ port: shimPort, shim } = await startShimOnFreePort({ CHROME_PORT_FILE: await portFileFor(chromePort), BC_SHIM_PROXY_TIMEOUT_MS: String(PROXY_MS) }));
    // Readiness is the shim's own port; a command sent before its browser socket
    // is up reaches a connection still attaching, and nobody answers it.
    await attachedToChrome(shimPort);
    client = await connectClient(shimPort);
  });

  after(async () => {
    client?.close();
    shim.child.kill();
    await fake.close();
  });

  it("answers the client with an error carrying the client's own id", async () => {
    fake.hold();
    timedOutId = client.send("Runtime.evaluate", { expression: "never()" });
    const reply = await client.reply(timedOutId);
    assert.equal(reply.id, timedOutId);
    assert.equal(reply.result, undefined);
    assert.equal(reply.error?.code, -32_000);
    assert.match(reply.error.message, /BC_SHIM_PROXY_TIMEOUT_MS/, "the error names the knob that moves the ceiling");
  });

  it("discards the browser's late answer instead of delivering it twice", async () => {
    fake.flush(); // the real reply, long after the client was told it timed out
    await settle(fake, client);
    assert.equal(client.replies.get(timedOutId).length, 1, "the client was answered exactly once");
    assert.equal(shim.child.exitCode, null, "an unexpected id did not take the shim down");
  });

  it("keeps serving the same client after one command timed out", async () => {
    fake.answer();
    const id = client.send("Runtime.evaluate", { expression: "1+1" });
    assert.deepEqual((await client.reply(id)).result, { echoed: "Runtime.evaluate" });
  });

  it("survives a client that walks away with a command in flight", async () => {
    fake.hold();
    const leaver = await connectClient(shimPort);
    leaver.send("Runtime.evaluate", { expression: "abandoned()" });
    await until(() => fake.held.some((m) => m.params?.expression === "abandoned()"), PATIENCE_MS, "the shim to forward the abandoned command");
    leaver.close();
    await until(() => shim.log.out.includes("client detached"), PATIENCE_MS, "the shim to notice the client left");
    fake.flush();
    await settle(fake, client);
    assert.equal(shim.child.exitCode, null, "the shim outlived the abandoned command");
    fake.answer();
    const survivor = await connectClient(shimPort);
    const id = survivor.send("Runtime.evaluate", { expression: "2+2" });
    assert.deepEqual((await survivor.reply(id)).result, { echoed: "Runtime.evaluate" });
    survivor.close();
  });
});

describe("a browser socket that drops ends every command in flight", () => {
  const fake = startFake();
  let shimPort;
  let shim;
  let client;
  let first;
  let second;

  before(async () => {
    const chromePort = await fake.listen();
    // A ceiling far beyond this test, so an error here can only come from the
    // dropped socket and never from the timeout path.
    ({ port: shimPort, shim } = await startShimOnFreePort({ CHROME_PORT_FILE: await portFileFor(chromePort), BC_SHIM_PROXY_TIMEOUT_MS: "120000" }));
    await attachedToChrome(shimPort);
    client = await connectClient(shimPort);
    fake.hold();
    first = client.send("Runtime.evaluate", { expression: "slow()" });
    second = client.send("Page.navigate", { url: "about:blank" });
    // The browser having seen both is the shim having both in its pending map,
    // which is the state this suite drops the socket under.
    await until(() => fake.held.length === 2, PATIENCE_MS, "both commands to reach the browser");
    fake.drop();
  });

  after(async () => {
    client?.close();
    shim.child.kill();
    await fake.close();
  });

  it("answers both in-flight commands with an error instead of silence", async () => {
    for (const id of [first, second]) {
      const reply = await client.reply(id);
      assert.equal(reply.id, id);
      assert.equal(reply.result, undefined);
      assert.equal(reply.error?.code, -32_000, `id ${id} got an error object`);
    }
  });

  it("then hangs up on the client, which must reconnect to get a fresh socket", async () => {
    assert.equal(await client.closed, 1001);
  });

  it("stays up so the next run can reconnect", async () => {
    assert.equal(shim.child.exitCode, null);
    const { status } = await getJson(shimPort, "/shim/status");
    assert.equal(status, 200);
  });
});

describe("the loser of a bind race stands down", () => {
  const fake = startFake();
  let shimPort;
  let winner;
  let loser;

  before(async () => {
    const chromePort = await fake.listen();
    const portFile = await portFileFor(chromePort);
    ({ port: shimPort, shim: winner } = await startShimOnFreePort({ CHROME_PORT_FILE: portFile }));
    // The connection count below is a verdict only once the winner's own is in.
    await attachedToChrome(shimPort);
    loser = startShim({ SHIM_PORT: String(shimPort), CHROME_PORT_FILE: portFile });
    // The zombie this suite exists to catch is exactly the shim that never
    // exits, so an unbounded `await loser.exited` would park the run instead of
    // failing it. One ceiling here covers all three tests: past it the loser is
    // killed, `exited` settles with the real outcome, and the signalCode check
    // below reads as the stand-down that never came.
    const stoodDown = await Promise.race([loser.exited, sleep(PATIENCE_MS).then(() => null)]);
    if (!stoodDown) loser.child.kill("SIGKILL");
  });

  after(async () => {
    winner.child.kill();
    loser.child.kill();
    await fake.close();
  });

  it("exits cleanly rather than sitting on a port it does not own", async () => {
    const { code, signal } = await loser.exited;
    assert.equal(loser.child.signalCode, null, `the loser had to be killed: it never stood down within ${PATIENCE_MS}ms`);
    assert.equal(signal, null);
    assert.equal(code, 0, "standing down is the outcome we wanted, not a failure");
  });

  it("never dials Chrome, so losing costs the operator no approval click", async () => {
    await loser.exited;
    assert.equal(fake.connections, 1, "only the shim that owns the port connected");
  });

  it("leaves the shim that owns the port serving", async () => {
    await loser.exited;
    assert.equal(winner.child.exitCode, null);
    const status = await getJson(shimPort, "/shim/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.attached, true);
    const version = await fetch(`http://127.0.0.1:${shimPort}/json/version`);
    assert.equal(version.status, 200);
  });
});

describe("/shim/status answers while Chrome is unreachable", () => {
  let shimPort;
  let shim;
  let portFile;

  before(async () => {
    portFile = await portFileFor(null); // the file Chrome would have written, absent
    ({ port: shimPort, shim } = await startShimOnFreePort({ CHROME_PORT_FILE: portFile }));
  });

  after(() => shim.child.kill());

  it("keeps listening instead of exiting when the first connect fails", async () => {
    const { status, body } = await getJson(shimPort, "/shim/status");
    assert.equal(status, 200);
    assert.equal(body.attached, false);
    assert.equal(body.portFile, portFile);
    assert.equal(shim.child.exitCode, null);
  });

  it("reports a reason that points at the missing DevToolsActivePort", async () => {
    const body = await until(async () => (await getJson(shimPort, "/shim/status")).body.reason, PATIENCE_MS, "a reason for not being attached");
    assert.ok(body.includes(portFile), `the reason names the file to fix: ${body}`);
  });

  it("still answers after a /json request has failed against the same dead Chrome", async () => {
    const version = await getJson(shimPort, "/json/version");
    assert.equal(version.status, 500, "discovery cannot work without Chrome");
    const { status, body } = await getJson(shimPort, "/shim/status");
    assert.equal(status, 200, "diagnostics must answer when discovery cannot");
    assert.equal(body.attached, false);
    assert.equal(shim.child.exitCode, null);
  });
});

describe("the reason distinguishes a Chrome with no debugging port from one that is there", () => {
  let missing;
  let refused;
  let missingPort;
  let refusedPort;
  let deadChrome;

  before(async () => {
    deadChrome = await freePort();
    ({ port: missingPort, shim: missing } = await startShimOnFreePort({ CHROME_PORT_FILE: await portFileFor(null) }));
    ({ port: refusedPort, shim: refused } = await startShimOnFreePort({ CHROME_PORT_FILE: await portFileFor(deadChrome) }));
  });

  after(() => {
    missing.child.kill();
    refused.child.kill();
  });

  it("names the address when something should be listening there and is not", async () => {
    const reason = await until(async () => (await getJson(refusedPort, "/shim/status")).body.reason, PATIENCE_MS, "a reason");
    assert.ok(reason.includes(`127.0.0.1:${deadChrome}`), `the reason names the address it dialled: ${reason}`);
  });

  it("gives the two failures different answers, because they need different fixes", async () => {
    const one = await until(async () => (await getJson(missingPort, "/shim/status")).body.reason, PATIENCE_MS, "a reason");
    const two = await until(async () => (await getJson(refusedPort, "/shim/status")).body.reason, PATIENCE_MS, "a reason");
    assert.notEqual(one, two);
  });
});

describe("attach() in cdp mode says WHICH failure this is", () => {
  const saved = { BC_SHIM_AUTOSTART: process.env.BC_SHIM_AUTOSTART, BC_SHIM_PROBE_MS: process.env.BC_SHIM_PROBE_MS };
  let shim;
  let shimUrl;
  let portFile;
  let deadUrl;
  let mute;
  let muteUrl;
  /** The three failures, collected once: each must be actionable on its own AND unlike the others. */
  const failure = {};

  before(async () => {
    // Nothing here may spawn a detached shim that outlives the run, and attach()'s
    // own probes must wait out a slow machine rather than report it as a dead one.
    process.env.BC_SHIM_AUTOSTART = "0";
    process.env.BC_SHIM_PROBE_MS = String(PATIENCE_MS);

    deadUrl = `http://127.0.0.1:${await freePort()}`;

    // A shim that is up but has never reached Chrome: the case /shim/status exists for.
    portFile = await portFileFor(null);
    const started = await startShimOnFreePort({ CHROME_PORT_FILE: portFile });
    shim = started.shim;
    shimUrl = `http://127.0.0.1:${started.port}`;
    await until(async () => (await getJson(started.port, "/shim/status")).body.reason, PATIENCE_MS, "the shim to know why it is not attached");

    // A port that answers like a shim whose diagnostics are gone — an open port
    // is not the same thing as a shim that can still say what is wrong.
    mute = createServer((req, res) => {
      if (req.url.startsWith("/json/version")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "no browser" }));
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => mute.listen(0, "127.0.0.1", r));
    muteUrl = `http://127.0.0.1:${mute.address().port}`;

    for (const [name, url] of [
      ["none", deadUrl],
      ["mute", muteUrl],
      ["unattached", shimUrl],
    ]) {
      failure[name] = await attach({ mode: "cdp", shimUrl: url }).then(
        () => null,
        (err) => err.message,
      );
      assert.ok(failure[name], `attach() against ${name} should not have succeeded without Chrome`);
    }
  });

  after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    shim.child.kill();
    mute.closeAllConnections();
    await new Promise((r) => mute.close(r));
  });

  it("tells the operator to start one when no shim is listening", () => {
    assert.ok(failure.none.includes(deadUrl), `names the address it looked at: ${failure.none}`);
    assert.match(failure.none, /npm run shim/, "gives a command that fixes it");
  });

  it("hands over the shim's own reason when the shim never reached Chrome", () => {
    assert.ok(failure.unattached.includes(shimUrl), `names the shim: ${failure.unattached}`);
    assert.ok(failure.unattached.includes(portFile), `repeats what the shim said is wrong: ${failure.unattached}`);
  });

  it("does not blame Chrome when the shim itself stopped answering", () => {
    assert.ok(failure.mute.includes(muteUrl), `names the endpoint: ${failure.mute}`);
    assert.ok(!failure.mute.includes(portFile), `cannot know Chrome's side here: ${failure.mute}`);
  });

  it("gives the three a different answer each, because each needs a different move", () => {
    const messages = [failure.none, failure.mute, failure.unattached];
    assert.equal(new Set(messages).size, 3, messages.join("\n---\n"));
  });
});
