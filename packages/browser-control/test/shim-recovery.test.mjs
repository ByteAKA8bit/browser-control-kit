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

/** A port nothing listens on: bind one, read it, give it straight back. */
async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/**
 * A CDP browser that can be unhelpful on purpose: `hold()` makes it record
 * commands and answer nothing (the hang the shim must end on its own), `flush()`
 * delivers those answers late, `drop()` closes the one browser socket under
 * whatever is in flight. `connections` counts approval grants it would have cost.
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

/** A raw CDP client on the shim's browser endpoint, recording EVERY reply per id. */
async function connectClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/shim`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("client could not reach the shim"));
  });
  const replies = new Map(); // id -> [msg, ...]; a second entry is a duplicate delivery
  const wake = new Map();
  const closed = new Promise((resolve) => {
    ws.onclose = (event) => resolve(event.code);
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id === undefined) return; // events, not replies
    replies.set(msg.id, [...(replies.get(msg.id) ?? []), msg]);
    wake.get(msg.id)?.();
  };
  let last = 0;
  const send = (method, params = {}) => {
    const id = ++last;
    ws.send(JSON.stringify({ id, method, params }));
    return id;
  };
  const reply = (id, ms = 3_000) =>
    new Promise((resolve, reject) => {
      if (replies.get(id)?.length) return resolve(replies.get(id)[0]);
      const timer = setTimeout(() => reject(new Error(`no reply to id ${id} within ${ms}ms`)), ms);
      wake.set(id, () => {
        clearTimeout(timer);
        resolve(replies.get(id)[0]);
      });
    });
  return { ws, send, reply, replies, closed, close: () => ws.close() };
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

describe("a command the browser never answers still ends", () => {
  const fake = startFake();
  let shimPort;
  let shim;
  let client;
  let timedOutId;

  before(async () => {
    const chromePort = await fake.listen();
    shimPort = await freePort();
    // Hundreds of milliseconds instead of the 60s default: the behaviour under
    // test is "the client gets an answer", not how long the ceiling is.
    shim = startShim({ SHIM_PORT: String(shimPort), CHROME_PORT_FILE: await portFileFor(chromePort), BC_SHIM_PROXY_TIMEOUT_MS: "400" });
    await shim.ready;
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
    const reply = await client.reply(timedOutId, 3_000);
    assert.equal(reply.id, timedOutId);
    assert.equal(reply.result, undefined);
    assert.equal(reply.error?.code, -32_000);
    assert.match(reply.error.message, /BC_SHIM_PROXY_TIMEOUT_MS/, "the error names the knob that moves the ceiling");
  });

  it("discards the browser's late answer instead of delivering it twice", async () => {
    fake.flush(); // the real reply, long after the client was told it timed out
    await sleep(200);
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
    await sleep(100); // long enough for the shim to have forwarded it
    leaver.close();
    await sleep(600); // past the proxy ceiling: the timer must fire into nothing
    fake.flush();
    await sleep(100);
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
    shimPort = await freePort();
    // A ceiling far beyond this test, so an error here can only come from the
    // dropped socket and never from the timeout path.
    shim = startShim({ SHIM_PORT: String(shimPort), CHROME_PORT_FILE: await portFileFor(chromePort), BC_SHIM_PROXY_TIMEOUT_MS: "120000" });
    await shim.ready;
    client = await connectClient(shimPort);
    fake.hold();
    first = client.send("Runtime.evaluate", { expression: "slow()" });
    second = client.send("Page.navigate", { url: "about:blank" });
    await sleep(100); // both are now in the shim's pending map
    fake.drop();
  });

  after(async () => {
    client?.close();
    shim.child.kill();
    await fake.close();
  });

  it("answers both in-flight commands with an error instead of silence", async () => {
    for (const id of [first, second]) {
      const reply = await client.reply(id, 3_000);
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
    shimPort = await freePort();
    const portFile = await portFileFor(chromePort);
    winner = startShim({ SHIM_PORT: String(shimPort), CHROME_PORT_FILE: portFile });
    await winner.ready;
    loser = startShim({ SHIM_PORT: String(shimPort), CHROME_PORT_FILE: portFile });
  });

  after(async () => {
    winner.child.kill();
    loser.child.kill();
    await fake.close();
  });

  it("exits cleanly rather than sitting on a port it does not own", async () => {
    const { code, signal } = await loser.exited;
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
    shimPort = await freePort();
    portFile = await portFileFor(null); // the file Chrome would have written, absent
    shim = startShim({ SHIM_PORT: String(shimPort), CHROME_PORT_FILE: portFile });
    await shim.ready;
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
    const body = await until(async () => (await getJson(shimPort, "/shim/status")).body.reason, 3_000, "a reason for not being attached");
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
    missingPort = await freePort();
    refusedPort = await freePort();
    deadChrome = await freePort();
    missing = startShim({ SHIM_PORT: String(missingPort), CHROME_PORT_FILE: await portFileFor(null) });
    await missing.ready;
    refused = startShim({ SHIM_PORT: String(refusedPort), CHROME_PORT_FILE: await portFileFor(deadChrome) });
    await refused.ready;
  });

  after(() => {
    missing.child.kill();
    refused.child.kill();
  });

  it("names the address when something should be listening there and is not", async () => {
    const reason = await until(async () => (await getJson(refusedPort, "/shim/status")).body.reason, 3_000, "a reason");
    assert.ok(reason.includes(`127.0.0.1:${deadChrome}`), `the reason names the address it dialled: ${reason}`);
  });

  it("gives the two failures different answers, because they need different fixes", async () => {
    const one = await until(async () => (await getJson(missingPort, "/shim/status")).body.reason, 3_000, "a reason");
    const two = await until(async () => (await getJson(refusedPort, "/shim/status")).body.reason, 3_000, "a reason");
    assert.notEqual(one, two);
  });
});

describe("attach() in cdp mode says WHICH failure this is", () => {
  const savedAutostart = process.env.BC_SHIM_AUTOSTART;
  let shim;
  let shimUrl;
  let portFile;
  let deadUrl;
  let mute;
  let muteUrl;
  /** The three failures, collected once: each must be actionable on its own AND unlike the others. */
  const failure = {};

  before(async () => {
    // Nothing in this suite may spawn a detached shim that outlives the run.
    process.env.BC_SHIM_AUTOSTART = "0";

    deadUrl = `http://127.0.0.1:${await freePort()}`;

    // A shim that is up but has never reached Chrome: the case /shim/status exists for.
    const shimPort = await freePort();
    portFile = await portFileFor(null);
    shim = startShim({ SHIM_PORT: String(shimPort), CHROME_PORT_FILE: portFile });
    await shim.ready;
    shimUrl = `http://127.0.0.1:${shimPort}`;
    await until(async () => (await getJson(shimPort, "/shim/status")).body.reason, 3_000, "the shim to know why it is not attached");

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
    if (savedAutostart === undefined) delete process.env.BC_SHIM_AUTOSTART;
    else process.env.BC_SHIM_AUTOSTART = savedAutostart;
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
