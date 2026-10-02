// Why these exist: `browser.close()` on a connectOverCDP connection sends
// Browser.close, and the shim proxies every client over the ONE approved socket
// to the operator's real Chrome — so forwarding it quits the browser the
// operator is using (reproduced twice on 2026-10-02: Chrome gone, shim dead
// reconnecting into nothing). The shim must answer those commands itself.
// Hermetic: a fake CDP browser built from node:http + ../src/ws-server.mjs, a
// real shim child process pointed at it, and a raw WebSocket client. No Chrome.
//
//   node --test test/shim-policy.test.mjs
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

/** Methods the fake Chrome was asked to run — the whole point of the suite. */
const seen = [];
let fake;
let fakePort;
let shim;
let shimPort;
let client;
/** id -> resolve, for replies the client is waiting on. */
const waiting = new Map();

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** A CDP browser that records every method and answers with an empty result. */
function startFake() {
  const server = createServer((_req, res) => res.end());
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://127.0.0.1").pathname !== FAKE_PATH) return socket.destroy();
    const conn = upgrade(req, socket, head);
    if (!conn) return socket.destroy();
    conn.onMessage = (raw) => {
      const msg = JSON.parse(raw);
      seen.push(msg.method);
      conn.send(JSON.stringify({ id: msg.id, result: { echoed: msg.method } }));
    };
  });
  return server;
}

const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = waiting.size + 1;
    const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 5_000);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    client.send(JSON.stringify({ id, method, params }));
  });

before(async () => {
  fake = startFake();
  fakePort = await listen(fake);

  // The shim learns where Chrome is from a DevToolsActivePort file; point it here.
  const dir = await mkdtemp(join(tmpdir(), "shim-policy-"));
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
    shim.stderr.resume(); // refusals are logged here; drained so the child never blocks
  });

  client = new WebSocket(`ws://127.0.0.1:${shimPort}/devtools/browser/shim`);
  await new Promise((resolve, reject) => {
    client.onopen = resolve;
    client.onerror = () => reject(new Error("client could not reach the shim"));
  });
  client.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    waiting.get(msg.id)?.(msg);
  };
});

after(async () => {
  client?.close();
  shim?.kill();
  await new Promise((r) => fake.close(r));
});

describe("shim refuses browser-destroying commands", () => {
  it("answers Browser.close locally with a success reply", async () => {
    const reply = await call("Browser.close");
    assert.deepEqual(reply.result, {});
    assert.equal(reply.error, undefined);
  });

  it("never forwards Browser.close to the browser", () => {
    assert.ok(!seen.includes("Browser.close"), `browser saw ${seen.join(", ")}`);
  });

  it("leaves the client's own connection usable afterwards", async () => {
    const reply = await call("Runtime.evaluate", { expression: "1+1" });
    assert.deepEqual(reply.result, { echoed: "Runtime.evaluate" });
  });

  it("forwards ordinary commands untouched", () => {
    assert.ok(seen.includes("Runtime.evaluate"), `browser saw ${seen.join(", ")}`);
  });

  it("refuses Browser.crash and Browser.crashGpuProcess the same way", async () => {
    for (const method of ["Browser.crash", "Browser.crashGpuProcess"]) {
      const reply = await call(method);
      assert.deepEqual(reply.result, {}, method);
      assert.ok(!seen.includes(method), `browser saw ${method}`);
    }
  });

  it("still serves /json/version over the one socket", async () => {
    const res = await fetch(`http://127.0.0.1:${shimPort}/json/version`);
    assert.equal(res.status, 200);
    assert.ok(seen.includes("Browser.getVersion"));
  });
});
