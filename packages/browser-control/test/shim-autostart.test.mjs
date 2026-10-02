// Why these exist: the `cdp` transport must cost the operator exactly ONE
// "Allow remote debugging?" click. That holds only if attach() reuses a shim
// that is already listening and starts a detached one just once — so the
// reuse/start decision is the load-bearing part, and it is decidable without
// Chrome: a dead port, a live stub, and the BC_SHIM_AUTOSTART=0 opt-out.
// Starting a real shim is NOT exercised here (it would need Chrome); the live
// proof is in the shim's own run. No browser needed.
//
//   node --test test/shim-autostart.test.mjs
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ensureShim, probeShim, transportSupport } from "../src/attach.mjs";

/** A stub that answers /json/version like the shim does, on an OS-chosen port. */
async function stubShim() {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ Browser: "Chrome/stub", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/shim" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, server, hits: () => hits, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A port nothing listens on: bind one, read it, give it back. */
async function deadUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  return url;
}

const savedEnv = { ...process.env };
const restoreEnv = () => {
  for (const key of ["BC_CDP_URL", "BC_SHIM_AUTOSTART", "BC_SHIM_PROBE_MS", "BC_SHIM_START_MS"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
};

describe("probeShim", () => {
  let stub;
  before(async () => {
    stub = await stubShim();
    process.env.BC_SHIM_PROBE_MS = "500"; // keep the suite fast; a local port answers instantly
  });
  after(async () => {
    await stub.close();
    restoreEnv();
  });
  afterEach(restoreEnv);

  it("is true for a live shim endpoint", async () => {
    assert.equal(await probeShim(stub.url), true);
    assert.ok(stub.hits() > 0, "the probe actually asked for /json/version");
  });

  it("is false for a port nothing listens on", async () => {
    assert.equal(await probeShim(await deadUrl()), false);
  });

  it("counts an open port that answers nothing as a live shim (the Allow dialog is up)", async () => {
    // A shim blocked on the operator's approval replies to no HTTP request;
    // calling that "no shim" would start a second one that cannot bind.
    const silent = createServer(() => {}); // accepts, never responds
    await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${silent.address().port}`;
    try {
      assert.equal(await probeShim(url, 200), true);
    } finally {
      silent.closeAllConnections?.();
      await new Promise((resolve) => silent.close(resolve));
    }
  });
});

describe("ensureShim", () => {
  let stub;
  before(async () => {
    stub = await stubShim();
    process.env.BC_SHIM_PROBE_MS = "500";
  });
  after(async () => {
    await stub.close();
    restoreEnv();
  });
  afterEach(restoreEnv);

  it("reuses a listening shim instead of starting one", async () => {
    const before = stub.hits();
    const shim = await ensureShim(stub.url);
    assert.deepEqual(shim, { url: stub.url, started: false, pid: null });
    assert.equal(stub.hits(), before + 1, "exactly one probe, no spawn");
  });

  it("refuses with a runnable instruction when BC_SHIM_AUTOSTART=0", async () => {
    process.env.BC_SHIM_AUTOSTART = "0";
    const url = await deadUrl();
    await assert.rejects(() => ensureShim(url), (err) => {
      assert.match(err.message, /BC_SHIM_AUTOSTART=0/);
      assert.match(err.message, /npm run shim/);
      assert.ok(err.message.includes(url), "names the address it probed");
      return true;
    });
  });

  it("still reuses a live shim when autostart is off", async () => {
    process.env.BC_SHIM_AUTOSTART = "0";
    assert.deepEqual(await ensureShim(stub.url), { url: stub.url, started: false, pid: null });
  });

  it("refuses to start a shim for a remote BC_CDP_URL", async () => {
    await assert.rejects(() => ensureShim("http://shim.example.invalid:9333"), /not this machine/);
  });

  // Not covered here: actually spawning the shim. It needs Chrome's
  // DevToolsActivePort to be of any use, and a detached process that survives
  // the test run is the opposite of hermetic — that path is proven live.
});

describe("transportSupport", () => {
  afterEach(restoreEnv);

  it("tells the operator whether a missing shim will be started", () => {
    delete process.env.BC_SHIM_AUTOSTART;
    assert.equal(transportSupport().cdp.autostart, true, "autostart is the default");
    process.env.BC_SHIM_AUTOSTART = "0";
    assert.equal(transportSupport().cdp.autostart, false);
    assert.match(transportSupport().cdp.shimUrl, /^https?:\/\//);
  });
});
