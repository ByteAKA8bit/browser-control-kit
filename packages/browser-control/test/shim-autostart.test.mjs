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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureShim, probeShim, transportSupport } from "../src/attach.mjs";

/** A stub that answers /json/version like the shim does, on an OS-chosen port. */
async function stubShim(port = 0) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ Browser: "Chrome/stub", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/shim" }));
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
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
  for (const key of ["BC_CDP_URL", "BC_SHIM_AUTOSTART", "BC_SHIM_PROBE_MS", "BC_SHIM_START_MS", "NODE_OPTIONS", "BCTEST_PIDFILE", "BCTEST_BLOCK_MS"]) {
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

  // Not covered here: a shim that actually serves CDP. It needs Chrome's
  // DevToolsActivePort to be of any use — that path is proven live. The spawn
  // branch itself IS covered below, with a child that cannot outlive the test.
});

// The spawn branch, with the child's fate forced instead of waited for: a
// preload runs before cdp-shim.mjs ever loads, so no shim, no Chrome, no port
// is ever bound by the child — only its liveness varies, which is exactly what
// ensureShim() reads to decide who paid for the approval click.
describe("ensureShim after it spawns a child", () => {
  let tmp;
  const spawnedPidFiles = [];

  // NOT `--require <path>`: NODE_OPTIONS treats a backslash inside quotes as an
  // escape, so a Windows temp path arrives with its separators eaten and the
  // child dies on MODULE_NOT_FOUND instead of on cue. A file: URL has no
  // backslashes and percent-encodes spaces, so it needs no quotes at all.
  const preloadFlag = (file) => `--import ${pathToFileURL(path.join(tmp, file)).href}`;
  /** Kill the child the test asked to stay alive; safe to call twice. */
  const reap = (pidFile) => {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    } catch {} // already gone, or never got far enough to write its pid
  };

  before(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "bc-shim-child-"));
    // Leaves a receipt, then dies before cdp-shim.mjs can load: proof that the
    // spawn branch ran, without a shim ever existing.
    writeFileSync(
      path.join(tmp, "die.mjs"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.BCTEST_PIDFILE, String(process.pid));\nprocess.exit(0);\n',
    );
    writeFileSync(
      path.join(tmp, "linger.mjs"),
      // Node awaits an --import module before loading the main entry, so this
      // timer holds cdp-shim.mjs back and no port is ever bound, while the
      // pending timer keeps the process visibly alive past ensureShim's
      // deadline. It exits on its own afterwards, so a missed reap cannot leak.
      'import { writeFileSync } from "node:fs";\n' +
        "writeFileSync(process.env.BCTEST_PIDFILE, String(process.pid));\n" +
        "await new Promise((resolve) => setTimeout(resolve, Number(process.env.BCTEST_BLOCK_MS)));\n" +
        "process.exit(0);\n",
    );
  });
  after(() => {
    for (const pidFile of spawnedPidFiles) reap(pidFile);
    rmSync(tmp, { recursive: true, force: true });
    restoreEnv();
  });
  afterEach(restoreEnv);

  it("refuses to call the answering shim its own when the child it spawned is already gone", async () => {
    // EADDRINUSE in slow motion: our child stands down, somebody else's shim
    // answers the port afterwards. Claiming started/pid here would tell the
    // operator we paid for an approval click that another process paid for.
    const url = await deadUrl(); // dead at the first probe, so the spawn branch is taken
    const port = Number(new URL(url).port);
    const receipt = path.join(tmp, "died.pid");
    rmSync(receipt, { force: true });
    process.env.BCTEST_PIDFILE = receipt;
    process.env.BC_SHIM_AUTOSTART = "1";
    process.env.BC_SHIM_PROBE_MS = "300";
    process.env.BC_SHIM_START_MS = "5000";
    process.env.NODE_OPTIONS = preloadFlag("die.mjs");
    const latecomer = new Promise((resolve) => setTimeout(() => resolve(stubShim(port)), 300));
    try {
      const shim = await ensureShim(url);
      assert.equal(shim.url, url);
      assert.ok(Number(readFileSync(receipt, "utf8")) > 0, "a child really was spawned and really died");
      assert.equal(shim.started, false, "the port is served by a process we did not start");
      assert.equal(shim.pid, null, "a dead child's pid must never be handed back");
    } finally {
      await (await latecomer).close();
    }
  });

  it("blames the child's exit when the deadline passes and the child is gone", async () => {
    const url = await deadUrl();
    process.env.BCTEST_PIDFILE = path.join(tmp, "died-late.pid");
    process.env.BC_SHIM_AUTOSTART = "1";
    process.env.BC_SHIM_PROBE_MS = "100";
    process.env.BC_SHIM_START_MS = "600";
    process.env.NODE_OPTIONS = preloadFlag("die.mjs");
    await assert.rejects(
      () => ensureShim(url),
      (err) => {
        assert.ok(err.message.includes(url), "names the address that stayed silent");
        assert.match(err.message, /exit|kill|signal/i, "reports that the child terminated");
        assert.doesNotMatch(err.message, /still running/i, "must not send the operator after a live process");
        return true;
      },
    );
  });

  it("blames a hung child when the deadline passes and the child is still alive", async () => {
    const url = await deadUrl();
    const pidFile = path.join(tmp, "linger.pid");
    rmSync(pidFile, { force: true });
    spawnedPidFiles.push(pidFile);
    process.env.BCTEST_PIDFILE = pidFile;
    process.env.BCTEST_BLOCK_MS = "4000"; // outlives the deadline below; killed in the finally
    process.env.BC_SHIM_AUTOSTART = "1";
    process.env.BC_SHIM_PROBE_MS = "100";
    process.env.BC_SHIM_START_MS = "600";
    process.env.NODE_OPTIONS = preloadFlag("linger.mjs");
    try {
      await assert.rejects(
        () => ensureShim(url),
        (err) => {
          assert.match(err.message, /still running/i, "a hung child reads differently than a dead one");
          assert.doesNotMatch(err.message, /exited with|killed by/i, "nothing terminated, so nothing may be blamed on it");
          return true;
        },
      );
    } finally {
      reap(pidFile);
    }
  });
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
