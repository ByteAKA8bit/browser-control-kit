// Why this exists: the server's job is to never be the flaky part. These cases
// speak real stdio JSON-RPC to a real child process — no browser, no mocks —
// and pin the things that break a client for good: a desynchronised stream, a
// reply to a notification, a chunk boundary in the middle of a message, and a
// tool failure escalating into a dead connection.
//
//   node --test test/protocol.test.mjs
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { clientOwnsStdin, createStdioTransport } from "../src/transport.mjs";
import { Session, TOOLS, callTool, clientName } from "../src/tools.mjs";
import { runScript } from "../src/script.mjs";
import { Jobs } from "../src/jobs.mjs";
import { Task } from "../src/task.mjs";
import { FETCH_IN_PAGE, uploads } from "../src/files.mjs";

const require = createRequire(import.meta.url);
const MANIFEST = require("../package.json");
const BIN = path.join(import.meta.dirname, "..", "bin", "browser-control-mcp.mjs");
// cdp mode at a dead port with autostart forbidden: attach() fails in
// milliseconds and nothing is launched on the operator's machine.
const NO_BROWSER = {
  BC_MODE: "cdp",
  BC_CDP_URL: "http://127.0.0.1:1",
  BC_SHIM_AUTOSTART: "0",
  BC_SHIM_PROBE_MS: "200",
  BC_MCP_ATTACH_TIMEOUT_MS: "5000",
};

// Every Session reads and writes a task file; keep the operator's ~/.cache out
// of it. The spawned server inherits this through process.env.
const TASK_DIR = mkdtempSync(path.join(tmpdir(), "bc-mcp-task-"));
process.env.BC_TASK_DIR = TASK_DIR;
after(() => rmSync(TASK_DIR, { recursive: true, force: true }));

/** A client that reads stdout strictly as newline-delimited JSON, like a real one. */
function startClient(env = {}) {
  const child = spawn(process.execPath, [BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BC_MCP_QUIET: "1", ...env },
  });
  const lines = [];
  const inbox = [];
  const waiting = [];
  const stderr = [];
  let buffer = "";
  let nextId = 0;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line.trim()) continue;
      lines.push(line);
      const message = JSON.parse(line); // every stdout line must be JSON, or this throws
      if (waiting.length) waiting.shift()(message);
      else inbox.push(message);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const receive = () =>
    inbox.length
      ? Promise.resolve(inbox.shift())
      : new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no reply within 10s; stderr: ${stderr.join("")}`)), 10_000);
          waiting.push((message) => {
            clearTimeout(timer);
            resolve(message);
          });
        });

  return {
    child,
    lines,
    stderr,
    receive,
    /** Raw bytes, so a test can choose its own chunk boundaries. */
    writeRaw: (text) => child.stdin.write(text),
    send: (method, params) => {
      const id = (nextId += 1);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return id;
    },
    request: async (method, params) => {
      const id = (nextId += 1);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const message = await receive();
      assert.equal(message.id, id, `reply out of order for ${method}`);
      return message;
    },
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.stdin.end();
      }),
  };
}

describe("stdio JSON-RPC", () => {
  let client;

  before(() => {
    client = startClient(NO_BROWSER);
  });

  after(async () => {
    const code = await client.stop();
    assert.equal(code, 0, "stdin EOF must be a clean exit");
    for (const line of client.lines) JSON.parse(line); // stdout stayed pure JSON start to finish
    assert.ok(client.lines.length > 0, "the server answered at least once");
  });

  it("negotiates the protocol version the client asked for", async () => {
    const { result } = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "protocol-test", version: "0" },
    });
    assert.equal(result.protocolVersion, "2025-03-26");
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.equal(result.serverInfo.name, "browser-control-mcp");
    // Not "carries a version" — the version a client reports to an operator is
    // the one that was published, so it is read from the manifest, not retyped.
    assert.equal(result.serverInfo.version, MANIFEST.version);
    assert.ok(result.instructions, "initialize carries the addressing model so no tool description has to");
    assert.match(result.instructions, /browser_release/, "the agent is told how to hand the browser back");
  });

  it("falls back to its own version when the client asks for an unknown one", async () => {
    const { result } = await client.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    assert.equal(result.protocolVersion, "2025-06-18");
  });

  it("tells a new client where the task stopped", async () => {
    new Task({ client: "protocol-resume-note", dir: TASK_DIR }).edit({ intent: "renew the passport", next: "upload a photo" });
    const resumed = startClient({ ...NO_BROWSER, BC_CLIENT_NAME: "protocol-resume-note" });
    try {
      const { result } = await resumed.request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      assert.match(result.instructions, /renew the passport/);
      assert.match(result.instructions, /upload a photo/);
    } finally {
      await resumed.stop();
    }
  });

  it("never replies to a notification", async () => {
    client.writeRaw(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const { result, id } = await client.request("ping", {});
    assert.deepEqual(result, {}, "the next message is the ping reply, not an answer to the notification");
    assert.ok(id > 0);
  });

  it("lists every tool with a usable schema", async () => {
    const { result } = await client.request("tools/list", {});
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "browser_click",
      "browser_download",
      "browser_evaluate",
      "browser_fill",
      "browser_navigate",
      "browser_press",
      "browser_release",
      "browser_screenshot",
      "browser_script",
      "browser_snapshot",
      "browser_status",
      "browser_surfaces",
      "browser_task",
      "browser_text",
      "browser_type",
      "browser_upload",
      "browser_wait_for",
    ]);
    for (const tool of result.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} schema`);
      assert.equal(typeof tool.inputSchema.properties, "object");
      assert.ok(Array.isArray(tool.inputSchema.required), `${tool.name} declares required`);
      for (const key of tool.inputSchema.required) {
        assert.ok(tool.inputSchema.properties[key], `${tool.name} requires "${key}" but does not declare it`);
      }
    }
  });

  it("offers no vocabulary for tabs at all", async () => {
    const { result } = await client.request("tools/list", {});
    for (const tool of result.tools) {
      // Not "no tool that opens one" — no tool that *names* one. A handle the
      // agent can hold is a handle the agent can leak.
      assert.ok(!/tab/i.test(tool.name), `${tool.name} speaks of tabs`);
      assert.ok(!/\b(open|close|select|new)\b/i.test(tool.name), `${tool.name} sounds like lifetime management`);
      const params = Object.keys(tool.inputSchema.properties);
      assert.ok(!params.includes("index"), `${tool.name} takes a tab index`);
      // Pages are addressed by name only: `as` to keep one, `on` to return.
      for (const key of params) {
        assert.ok(!/tab|index|handle/i.test(key), `${tool.name}.${key} is a handle`);
        if (key === "as" || key === "on") assert.equal(tool.inputSchema.properties[key].type, "string");
      }
    }
  });

  // The cost an agent pays is turns, not milliseconds: 40 actions measured
  // 878 ms as 40 tool calls and 642 ms in one script, but 41 turns against 1.
  // So the batching tool has to exist, say what is in scope, and fail honestly.
  it("offers one call that runs a whole flow, and says what the body can name", async () => {
    const { result } = await client.request("tools/list", {});
    const script = result.tools.find((tool) => tool.name === "browser_script");
    assert.deepEqual(script.inputSchema.required, ["code"]);
    for (const name of ["page", "surface", "handBack", "state", "log"]) {
      assert.ok(script.description.includes(name), `the description never mentions ${name}`);
    }
    assert.match(script.description, /survives between calls/, "state is the reason a flow can be resumed");
  });

  it("refuses a script with no body as a protocol mistake, not a tool error", async () => {
    const { error, result } = await client.request("tools/call", { name: "browser_script", arguments: {} });
    assert.equal(result, undefined);
    assert.equal(error.code, -32602);
    assert.match(error.message, /code/);
  });

  it("reports a script that cannot reach a browser as a tool error, like every other tool", async () => {
    const { error, result } = await client.request("tools/call", { name: "browser_script", arguments: { code: "return 1;" } });
    assert.equal(error, undefined);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /browser_script failed/);
  });

  it("has forgotten the handle-based tab tools entirely", async () => {
    for (const gone of ["browser_tabs", "browser_tab_select", "browser_tab_close"]) {
      const { error, result } = await client.request("tools/call", { name: gone, arguments: {} });
      assert.equal(result, undefined, `${gone} must not run`);
      assert.equal(error.code, -32602, `${gone} is not a tool any more`);
      assert.match(error.message, /unknown tool/);
    }
  });

  it("answers unknown methods with -32601 instead of dying", async () => {
    const { error } = await client.request("resources/list", {});
    assert.equal(error.code, -32601);
    assert.match(error.message, /resources\/list/);
  });

  it("answers malformed JSON with -32700 and a null id", async () => {
    client.writeRaw("{ this is not json }\n");
    const message = await client.receive();
    assert.equal(message.error.code, -32700);
    assert.equal(message.id, null);
  });

  it("rejects bad tool arguments with -32602", async () => {
    const { error } = await client.request("tools/call", { name: "browser_navigate", arguments: {} });
    assert.equal(error.code, -32602);
    assert.match(error.message, /url/);
  });

  it("takes a page name on every acting tool and rejects a non-string one", async () => {
    const bad = await client.request("tools/call", { name: "browser_click", arguments: { selector: "#go", on: 2 } });
    assert.equal(bad.error.code, -32602, "a page is named, so an index is a type error");
    assert.match(bad.error.message, /on must be a string/);
    // `as` and `on` are real parameters, not silently ignored extras: with no
    // browser this gets as far as attach() and fails there instead.
    const kept = await client.request("tools/call", {
      name: "browser_navigate",
      arguments: { url: "https://example.com", as: "docs" },
    });
    assert.equal(kept.error, undefined);
    assert.equal(kept.result.isError, true);
    assert.match(kept.result.content[0].text, /browser_navigate failed/);
  });

  it("refuses `as` and `on` in one call instead of quietly dropping one", async () => {
    const { error, result } = await client.request("tools/call", {
      name: "browser_navigate",
      arguments: { url: "https://example.com", as: "docs", on: "notes" },
    });
    assert.equal(result, undefined, "a call naming two pages must not run on either of them");
    assert.equal(error.code, -32602);
    assert.match(error.message, /"as" or "on"/);
  });

  it("tells a declared parameter from one inherited off Object.prototype", async () => {
    const { error, result } = await client.request("tools/call", {
      name: "browser_click",
      arguments: { selector: "#go", constructor: 1 },
    });
    assert.equal(result, undefined);
    assert.equal(error.code, -32602);
    assert.match(error.message, /has no parameter "constructor"/);
  });

  it("holds an integer parameter to whole numbers", async () => {
    const { error, result } = await client.request("tools/call", {
      name: "browser_wait_for",
      arguments: { selector: "#go", timeoutMs: 1.5 },
    });
    assert.equal(result, undefined, "a fractional timeout is a mistake, not a browser failure");
    assert.equal(error.code, -32602);
    assert.match(error.message, /timeoutMs must be an integer/);
  });

  it("reports surfaces as a tool error when there is no browser", async () => {
    const { error, result } = await client.request("tools/call", { name: "browser_surfaces", arguments: {} });
    assert.equal(error, undefined);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /browser_surfaces failed/);
  });

  it("handles two messages arriving in one chunk", async () => {
    const batch = [
      { jsonrpc: "2.0", id: 900, method: "ping" },
      { jsonrpc: "2.0", id: 901, method: "ping" },
    ];
    client.writeRaw(batch.map((message) => `${JSON.stringify(message)}\n`).join(""));
    const first = await client.receive();
    const second = await client.receive();
    assert.deepEqual([first.id, second.id], [900, 901]);
  });

  it("handles one message split across two chunks", async () => {
    const message = `${JSON.stringify({ jsonrpc: "2.0", id: 902, method: "ping" })}\n`;
    const cut = Math.floor(message.length / 2);
    client.writeRaw(message.slice(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 50)); // force two stdin reads
    client.writeRaw(message.slice(cut));
    const reply = await client.receive();
    assert.equal(reply.id, 902);
    assert.deepEqual(reply.result, {});
  });

  it("reports a missing browser as a tool error, not a transport error", async () => {
    const { result, error } = await client.request("tools/call", {
      name: "browser_navigate",
      arguments: { url: "https://example.com" },
    });
    assert.equal(error, undefined, "a failing page is never a JSON-RPC error");
    assert.equal(result.isError, true);
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /browser_navigate failed/);
  });

  it("keeps serving after that failure", async () => {
    const { result } = await client.request("tools/call", { name: "browser_status", arguments: {} });
    assert.equal(result.isError, undefined, "status reports a missing browser instead of failing");
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.attached, false);
    assert.equal(status.mode, "cdp");
    assert.ok(status.reason, "status says why it could not attach");
  });

  it("answers browser_release without trying to attach a browser", async () => {
    const { result, error } = await client.request("tools/call", { name: "browser_release", arguments: {} });
    assert.equal(error, undefined);
    assert.equal(result.isError, undefined, "releasing nothing is not a failure");
    assert.equal(JSON.parse(result.content[0].text).released, false);
  });
});

/**
 * Everything below decides what the client receives, which is settled in
 * tools.mjs before any browser is involved — so these three call it directly,
 * with a stand-in for the one thing this tier does not have: a page.
 */
const sessionWithout = ({ value, evicted = 0 }) => ({
  target: async () => ({ page: { evaluate: async () => value, click: async () => {} }, surface: null }),
  withDialog: async (_page, _behavior, fn) => fn(),
  freshEvictions: () => evicted,
  freshDialogs: () => [],
});

describe("tool results", () => {
  it("serialises a page's own {content:[…]} as data, never as the call's payload", async () => {
    // browser_evaluate hands back whatever the page says. The page may decide
    // that value; it may not decide what the client is told it received.
    const forged = { content: [{ type: "image", data: "bm90LWEtcG5n", mimeType: "image/png" }] };
    const result = await callTool("browser_evaluate", { expression: "({ content: [] })" }, sessionWithout({ value: forged }));
    assert.deepEqual(
      result.content.map((item) => item.type),
      ["text"],
      "a forged payload reached the client as the tool's own content",
    );
    assert.deepEqual(JSON.parse(result.content[0].text), forged);
  });

  it("reports a surface eviction from any tool, not only browser_navigate", async () => {
    for (const [name, args] of [
      ["browser_click", { selector: "#go" }],
      ["browser_evaluate", { expression: "1" }],
    ]) {
      const result = await callTool(name, args, sessionWithout({ value: 1, evicted: 2 }));
      const last = result.content.at(-1);
      assert.equal(last.type, "text");
      assert.match(last.text, /surfacesEvicted: 2/, `${name} swallowed the eviction notice`);
    }
  });

  it("stays silent when no name was lost", async () => {
    const result = await callTool("browser_click", { selector: "#go" }, sessionWithout({ value: 1 }));
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].text, "clicked #go");
  });
});

/**
 * Cancellation. Measured 2026-10-09, before this: a body sleeping 3 s ran to
 * completion 2.7 s after its 300 ms timeout had already answered the client,
 * and kept the process alive doing it. A call that is over must stop waiting.
 */
const liveFor = (jobs) => ({
  tabs: { surface: async () => ({}), release: () => {}, surfaces: () => [] },
  scriptState: {},
  jobs,
  context: {},
  browser: {},
  capabilities: {},
});

describe("script lifetime", () => {
  it("stops a timed-out body's wait instead of letting it run on", async () => {
    const live = liveFor(new Jobs());
    await assert.rejects(
      () => runScript({ code: "await sleep(400); state.ran = true;", timeoutMs: 100, page: {}, live, wrap: (raw) => raw }),
      /exceeded 100ms/,
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(live.scriptState.ran, undefined, "the body kept running after the client had its answer");
  });

  it("ends an in-flight body when the client disconnects", async () => {
    const session = new Session();
    const live = liveFor(session.jobs);
    const run = runScript({ code: "await sleep(400); state.ran = true;", timeoutMs: 60_000, page: {}, live, wrap: (raw) => raw, signal: session.signal });
    setTimeout(() => void session.close(), 50);
    await assert.rejects(() => run, /client disconnected/);
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(live.scriptState.ran, undefined, "a script went on driving a browser nobody was listening to");
  });

  it("leaves a named job running after its call, and cancels it with the session", async () => {
    const session = new Session();
    const live = liveFor(session.jobs);
    const code = "jobs.start('poll', async ({ signal, sleep, log }) => { let n = 0; while (!signal.aborted) { await sleep(20); log('tick', ++n); } return n; });";
    await runScript({ code, page: {}, live, wrap: (raw) => raw, signal: session.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(session.jobs.status("poll").state, "running", "a job is the thing that outlives a call");
    assert.ok(session.jobs.status("poll").logs.length > 0, "a job that cannot sleep cannot poll");
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(session.jobs.status("poll").state, "cancelled");
  });

  it("lets a script hand the browser back in the same call", async () => {
    let handedBack = 0;
    const content = await runScript({
      code: "await handBack(); return 'bye';",
      page: {},
      live: liveFor(new Jobs()),
      wrap: (raw) => raw,
      handBack: async () => {
        handedBack += 1;
        return true;
      },
    });
    assert.equal(handedBack, 1, "the body could end the browser it was using");
    assert.equal(content[0].text, "bye", "the result still reaches the client");
  });

  it("exits when the client goes, even though a body left a timer behind", async () => {
    // A `setTimeout` the body wrote itself is not ours to clear, and with the
    // client gone and the browser closed, waiting for it is waiting forever.
    // `-e` takes an import specifier, not a path: on Windows a bare D:\… is not one.
    const source = `import { startServer } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "src", "server.mjs")).href)};
      startServer();
      setInterval(() => {}, 50);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BC_MCP_QUIET: "1", BC_MCP_EXIT_GRACE_MS: "100" },
    });
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.end();
    const code = await Promise.race([
      new Promise((resolve) => child.on("exit", resolve)),
      new Promise((resolve) => setTimeout(() => resolve("still running"), 5_000)),
    ]);
    child.kill("SIGKILL");
    assert.equal(code, 0, "the script's own timer kept a server alive whose client was gone");
  });
});

describe("durable task", () => {
  it("shows the same task to a second session", async () => {
    const first = new Session({ task: new Task({ client: "protocol-task", dir: TASK_DIR }) });
    const shown = await callTool("browser_task", { intent: "book a table", next: "paste the SMS code", note: "waiting on the operator" }, first);
    assert.equal(shown.isError, undefined);
    assert.match(shown.content[0].text, /intent: book a table/);
    await first.close();

    const second = new Session({ task: new Task({ client: "protocol-task", dir: TASK_DIR }) });
    const resumed = await callTool("browser_task", {}, second);
    assert.match(resumed.content[0].text, /next: paste the SMS code/);
    assert.match(resumed.content[0].text, /waiting on the operator/);
    await second.close();
  });

  it("reopens a saved page by name after the process moved on", async () => {
    const saved = new Task({ client: "protocol-resume", dir: TASK_DIR });
    saved.rememberSurface("docs", { url: "https://example.com/docs" });

    const page = {
      current: "about:blank",
      keyboard: {},
      async goto(url) {
        page.current = url;
        return null;
      },
      url: () => page.current,
    };
    const live = {
      tabs: { surfaces: () => [], surface: async () => page, report: () => ({ scratch: null }), stats: { surfacesEvicted: 0 } },
      capabilities: { mode: "cdp" },
      context: {},
      browser: { isConnected: () => true, close: async () => {} },
    };
    const session = new Session({ task: new Task({ client: "protocol-resume", dir: TASK_DIR }), connect: async () => live });

    const target = await session.target({ on: "docs" });
    assert.equal(target.resumed, true);
    assert.equal(page.current, "https://example.com/docs");
    await session.close();
  });

  it("does not leave a name bound to a page that failed to reopen", async () => {
    new Task({ client: "protocol-retry", dir: TASK_DIR }).rememberSurface("docs", { url: "https://example.com/docs" });
    let bound = false;
    let fail = true;
    const page = {
      keyboard: {},
      async goto() {
        if (fail) throw new Error("net::ERR_CONNECTION_RESET");
      },
      url: () => "about:blank",
    };
    const guard = {
      surfaces: () => (bound ? [{ name: "docs" }] : []),
      surface: async () => {
        bound = true;
        return page;
      },
      release: () => {
        bound = false;
        return true;
      },
      report: () => ({ scratch: null }),
      stats: { surfacesEvicted: 0 },
    };
    const live = { tabs: guard, capabilities: { mode: "cdp" }, context: {}, browser: { isConnected: () => true, close: async () => {} }, scriptState: {} };
    const session = new Session({ task: new Task({ client: "protocol-retry", dir: TASK_DIR }), connect: async () => live });

    await assert.rejects(() => session.target({ on: "docs" }), /reopening it failed/);
    fail = false;
    const target = await session.target({ on: "docs" });
    assert.equal(target.resumed, true, "the second try reopened the saved URL instead of accepting a blank page");
    await session.close();
  });

  it("gives a script's surface(name) the same saved URL", async () => {
    new Task({ client: "protocol-script-resume", dir: TASK_DIR }).rememberSurface("docs", { url: "https://example.com/docs" });

    const page = {
      current: "about:blank",
      keyboard: {},
      async goto(url) {
        page.current = url;
        return null;
      },
      url: () => page.current,
    };
    const live = {
      tabs: { surfaces: () => [], surface: async () => page, report: () => ({ scratch: null }), stats: { surfacesEvicted: 0 } },
      capabilities: { mode: "cdp" },
      context: {},
      browser: { isConnected: () => true, close: async () => {} },
      scriptState: {},
    };
    const session = new Session({ task: new Task({ client: "protocol-script-resume", dir: TASK_DIR }), connect: async () => live });

    const out = await runScript({
      code: "const p = await surface('docs'); return p.url();",
      page,
      live,
      wrap: (raw) => raw,
      surface: (name) => session.openSurface(name),
    });
    assert.equal(out[0].text, "https://example.com/docs");
    await session.close();
  });

  it("says what the operator must do when attach fails", async () => {
    const session = new Session({
      task: new Task({ client: "protocol-needs", dir: TASK_DIR }),
      connect: async () => {
        throw new Error("The CDP shim on http://localhost:9333 is listening but has no approved Chrome connection: waiting for the operator");
      },
    });
    const result = await callTool("browser_status", {}, session);
    const status = JSON.parse(result.content[0].text);
    assert.equal(status.attached, false);
    assert.equal(status.needs, "approval");
    assert.match(status.hint, /allow/i);
    await session.close();
  });
});

describe("page serialisation", () => {
  const fakeSession = (page) => {
    const guard = {
      surfaces: () => [{ name: "docs" }],
      surface: async () => page,
      report: () => ({ scratch: null }),
      stats: { surfacesEvicted: 0 },
    };
    const live = {
      tabs: guard,
      capabilities: { mode: "cdp" },
      context: {},
      browser: { isConnected: () => true, close: async () => {} },
      scriptState: {},
    };
    return new Session({ task: new Task({ client: "protocol-serial", dir: TASK_DIR }), connect: async () => live });
  };

  it("runs two calls on one page in the order they arrived", async () => {
    const page = { keyboard: {}, url: () => "https://example.com", async goto() {} };
    const session = fakeSession(page);
    await Promise.all([
      callTool("browser_script", { on: "docs", code: "await sleep(40); state.order = [...(state.order ?? []), 'first'];" }, session),
      callTool("browser_script", { on: "docs", code: "state.order = [...(state.order ?? []), 'second'];" }, session),
    ]);
    assert.deepEqual(session.scriptState.order, ["first", "second"], "the second body must not run inside the first");
    await session.close();
  });

  it("does not make another page wait", async () => {
    const session = new Session({ task: new Task({ client: "protocol-serial-2", dir: TASK_DIR }), connect: async () => ({}) });
    const order = [];
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = session.serial("docs", async () => {
      order.push("docs-1 start");
      await gate;
      order.push("docs-1 end");
    });
    const second = session.serial("docs", async () => order.push("docs-2"));
    const other = session.serial("mail", async () => order.push("mail"));
    await other;
    assert.deepEqual(order, ["docs-1 start", "mail"], "different names run in parallel");
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["docs-1 start", "mail", "docs-1 end", "docs-2"]);
    await session.close();
  });
});

describe("file tools", () => {
  const tool = (name) => TOOLS.find((entry) => entry.name === name);
  const withPage = (page) => ({ target: async () => ({ page }), withDialog: async (_page, _behavior, fn) => fn() });

  it("hands an input the files it was given, inline bytes and paths alike", async () => {
    const seen = [];
    const page = {
      async setInputFiles(selector, files) {
        seen.push({ selector, files });
        return { ok: true, count: files.length, via: "fake" };
      },
    };
    const onDisk = path.join(TASK_DIR, "notes.txt");
    writeFileSync(onDisk, "from disk");
    const result = await tool("browser_upload").run(
      { selector: "#resume", files: [onDisk, { name: "cv.txt", text: "hello" }, { name: "logo.bin", base64: Buffer.from("png").toString("base64") }] },
      withPage(page),
    );
    assert.equal(result.count, 3);
    assert.deepEqual(result.files, ["notes.txt", "cv.txt", "logo.bin"]);
    assert.equal(seen[0].selector, "#resume");
    assert.equal(seen[0].files[0].buffer.toString(), "from disk");
    assert.equal(seen[0].files[1].buffer.toString(), "hello");
    assert.equal(seen[0].files[2].buffer.toString(), "png");
  });

  it("saves fetched bytes where the call asked, and reports its size", async () => {
    const target = path.join(TASK_DIR, "downloads", "invoice.pdf");
    const page = {
      evaluate: async (fn, url, ms, max) => {
        assert.equal(fn, FETCH_IN_PAGE);
        assert.equal(url, "https://example.com/invoice.pdf");
        assert.equal(ms, 30_000);
        assert.ok(max > 0);
        return { ok: true, base64: Buffer.from("pdf-bytes").toString("base64"), name: "invoice.pdf", type: "application/pdf", bytes: 9 };
      },
    };
    const result = await tool("browser_download").run({ url: "https://example.com/invoice.pdf", path: target }, withPage(page));
    assert.equal(result.path, target);
    assert.equal(result.size, 9);
    assert.equal(result.type, "application/pdf");
  });

  it("fetches with the page's cookies and names the file from Content-Disposition", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' });
      res.end("a,b\n1,2\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/export`;
      const result = await FETCH_IN_PAGE(url, 5_000, 1_024);
      assert.equal(result.ok, true);
      assert.equal(result.name, "report.csv");
      assert.equal(result.type, "text/csv");
      assert.equal(Buffer.from(result.base64, "base64").toString(), "a,b\n1,2\n");

      const tooBig = await FETCH_IN_PAGE(url, 5_000, 2);
      assert.match(tooBig.reason, /over BC_MCP_DOWNLOAD_MAX/);
    } finally {
      server.close();
    }
  });

  it("asks for a URL and names what an upload entry may be", async () => {
    await assert.rejects(() => tool("browser_download").run({}, withPage({})), /needs "url"/);
    assert.throws(() => uploads([{ name: "x" }]), /unsupported file entry/);
  });
});

describe("dialogs", () => {
  const sessionFor = async (raw) => {
    const live = {
      tabs: { surfaces: () => [], surface: async () => raw, report: () => ({ scratch: null }), stats: { surfacesEvicted: 0 } },
      capabilities: { mode: "cdp" },
      context: {},
      browser: { isConnected: () => true, close: async () => {} },
      scriptState: {},
    };
    const session = new Session({ task: new Task({ client: "protocol-dialogs", dir: TASK_DIR }), connect: async () => live });
    await session.browser();
    return session;
  };
  const makeDialog = (answers) => ({
    type: () => "confirm",
    message: () => "Delete it?",
    accept: async () => answers.push("accept"),
    dismiss: async () => answers.push("dismiss"),
  });

  it("dismisses an unhandled dialog and tells the next tool result", async () => {
    const raw = new EventEmitter();
    raw.keyboard = {};
    raw.url = () => "https://example.com/form";
    const session = await sessionFor(raw);
    const page = session.wrap(raw);
    const answers = [];
    await session.withDialog(page, undefined, async () => raw.emit("dialog", makeDialog(answers)));
    assert.deepEqual(answers, ["dismiss"], "the safe answer, not a hung page");
    assert.deepEqual(session.freshDialogs(), [{ type: "confirm", message: "Delete it?", accepted: false, url: "https://example.com/form" }]);
    assert.deepEqual(session.freshDialogs(), [], "a notice is consumed once");

    await session.withDialog(page, undefined, async () => raw.emit("dialog", makeDialog(answers)));
    raw.emit("console", { type: () => "error", text: () => "Boom: the cart failed" });
    raw.emit("pageerror", new Error("Uncaught boom"));
    const result = await callTool("browser_status", {}, session);
    const status = result.content.map((block) => block.text).join("\n");
    assert.match(status, /dialog \(confirm, dismissed\).*Delete it\?/);
    assert.match(status, /Boom: the cart failed/);
    assert.match(status, /Uncaught boom/);
    assert.equal(session.recentErrors().length, 2, "diagnostics stay readable on the next call");
    await session.close();
  });

  it("accepts when the call asks, and leaves nothing listening afterwards", async () => {
    const raw = new EventEmitter();
    raw.keyboard = {};
    raw.url = () => "https://example.com/form";
    const session = await sessionFor(raw);
    const page = session.wrap(raw);
    const answers = [];
    await session.withDialog(page, "accept", async () => raw.emit("dialog", makeDialog(answers)));
    assert.deepEqual(answers, ["accept"]);
    assert.equal(session.freshDialogs()[0].accepted, true);

    raw.emit("dialog", makeDialog(answers));
    assert.deepEqual(session.freshDialogs(), [], "no session listener survives the action");
    assert.deepEqual(answers, ["accept"], "a later dialog is Playwright's to auto-dismiss, not ours to answer");
    await session.close();
  });
});

describe("browser lifecycle", () => {
  const fakeLive = (name, onClose) => ({
    tabs: { stats: { surfacesEvicted: 0 }, report: () => ({}), surface: async () => ({}) },
    capabilities: { clientName: name },
    mode: "cdp",
    context: {},
    browser: { isConnected: () => true, close: async () => onClose() },
  });

  it("hands the tabs back after a quiet spell, and attaches again on the next call", async () => {
    let closed = 0;
    let attaches = 0;
    const session = new Session({
      idleMs: 30,
      connect: async (name) => {
        attaches += 1;
        assert.ok(name, "every connection has a project name for its tab group");
        return fakeLive(name, () => (closed += 1));
      },
    });
    await session.browser();
    session.scriptState.kept = "yes";
    session.activity()(); // a tool call just finished
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(closed, 1, "the idle browser gave its tabs back");
    const live = await session.browser();
    assert.equal(live.scriptState.kept, "yes", "state belongs to the session, not the browser");
    assert.equal(attaches, 2, "the session stayed alive and attached again");
    await session.close();
    assert.equal(closed, 2);
  });

  it("never releases while a tool call is still in flight", async () => {
    let closed = 0;
    const session = new Session({ idleMs: 30, connect: async (name) => fakeLive(name, () => (closed += 1)) });
    await session.browser();
    const done = session.activity();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, 0, "the browser belonged to a call that had not returned");

    done();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, 1);
    await session.close();
  });

  it("finishes closing the old browser before it attaches again", async () => {
    let closeStarted = false;
    let finishClose;
    const closed = new Promise((resolve) => (finishClose = resolve));
    const session = new Session({
      idleMs: 20,
      connect: async (name) => fakeLive(name, () => {
        closeStarted = true;
        return closed;
      }),
    });
    await session.browser();
    session.activity()();
    for (let i = 0; i < 50 && !closeStarted; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(closeStarted, true, "the idle timer started closing the browser");

    let reattached = false;
    const again = session.browser().then((live) => {
      reattached = true;
      return live;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reattached, false, "a reattach would overlap the old connection's tab churn");

    finishClose();
    await again;
    assert.equal(reattached, true);
    await session.close();
  });

  it("never releases a browser a named job is still driving", async () => {
    let closed = 0;
    const session = new Session({ idleMs: 30, connect: async (name) => fakeLive(name, () => (closed += 1)) });
    await session.browser();
    session.jobs.start("poll", async ({ signal, sleep }) => {
      while (!signal.aborted) await sleep(10);
    });
    session.activity()();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, 0, "a job outlives its call on purpose");

    session.jobs.cancel("poll");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, 1);
    await session.close();
  });

  it("does not hand a quiet browser back unless the operator opted in", async () => {
    const before = process.env.BC_MCP_IDLE_MS;
    delete process.env.BC_MCP_IDLE_MS;
    let closed = 0;
    const session = new Session({ connect: async (name) => fakeLive(name, () => (closed += 1)) });
    try {
      await session.browser();
      session.activity()(); // a tool call just finished, and nothing else will happen
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(closed, 0, "the server guessed the agent was done");
      const status = await session.status();
      assert.deepEqual(status.idle, { afterMs: 0, enabled: false, busy: 0 }, "status says no timer is running");
    } finally {
      await session.close();
      if (before === undefined) delete process.env.BC_MCP_IDLE_MS;
      else process.env.BC_MCP_IDLE_MS = before;
    }
    assert.equal(closed, 1, "closing the session is what hands it back");
  });

  it("hands the browser back on request, and keeps state for the next attach", async () => {
    let closed = 0;
    let attaches = 0;
    const session = new Session({
      connect: async (name) => {
        attaches += 1;
        return fakeLive(name, () => (closed += 1));
      },
    });
    await session.browser();
    session.scriptState.kept = "yes";
    const result = await callTool("browser_release", {}, session);
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).released, true);
    assert.equal(closed, 1, "the explicit release closed the browser");
    const live = await session.browser();
    assert.equal(live.scriptState.kept, "yes", "state belongs to the session, not the browser");
    assert.equal(attaches, 2, "the next call attached again");
    await session.close();
    assert.equal(closed, 2);
  });

  it("refuses an explicit release while a named job still needs the browser", async () => {
    let closed = 0;
    const session = new Session({ connect: async (name) => fakeLive(name, () => (closed += 1)) });
    await session.browser();
    session.jobs.start("poll", async ({ signal, sleep }) => {
      while (!signal.aborted) await sleep(10);
    });
    const result = await callTool("browser_release", {}, session);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /poll/);
    assert.match(result.content[0].text, /jobs\.cancel/, "the agent is told how to get unstuck");
    assert.equal(closed, 0, "a job outlives its call on purpose");
    session.jobs.cancel("poll");
    await session.close();
    assert.equal(closed, 1);
  });

  it("refuses an explicit release under another tool call that is still running", async () => {
    let closed = 0;
    const session = new Session({ connect: async (name) => fakeLive(name, () => (closed += 1)) });
    await session.browser();
    const first = session.activity();
    const second = session.activity(); // two calls: one of them is not this release
    await assert.rejects(() => session.handBack(), /still using this browser/);
    first();
    second();
    assert.equal(closed, 0);
    await session.close();
    assert.equal(closed, 1);
  });
});

describe("client identity", () => {
  it("names the tab group after BC_CLIENT_NAME, else the working directory", () => {
    const before = process.env.BC_CLIENT_NAME;
    try {
      process.env.BC_CLIENT_NAME = "alpha-project";
      assert.equal(clientName(), "alpha-project");
      delete process.env.BC_CLIENT_NAME;
      assert.match(clientName(), /\S/, "a fallback name is always available");
    } finally {
      if (before === undefined) delete process.env.BC_CLIENT_NAME;
      else process.env.BC_CLIENT_NAME = before;
    }
  });
});

describe("lifecycle", () => {
  it("exits cleanly on stdin EOF without ever being initialised", async () => {
    const client = startClient(NO_BROWSER);
    assert.equal(await client.stop(), 0);
    assert.deepEqual(client.lines, [], "a server nobody spoke to writes nothing to stdout");
  });

  it("exits when the client drops the pipe without closing it politely", async () => {
    // A client that dies takes its end of stdin with it, SIGKILL included —
    // this is the kernel doing the work, which is why the server needs no
    // liveness heuristic of its own.
    const client = startClient(NO_BROWSER);
    client.child.stdin.destroy();
    const code = await new Promise((resolve) => client.child.on("exit", resolve));
    assert.equal(code, 0, "a broken pipe is a clean exit, not a crash");
  });

  it("hands stdout back when it stops, so a second server can have it", () => {
    // startServer is this package's entry point: a host may run one, stop it
    // and start another in the same process. A capture left behind would be
    // taken for the real write and send the next server's replies to stderr.
    const output = new PassThrough();
    const real = output.write;
    const transport = createStdioTransport({
      input: new PassThrough(),
      output,
      onMessage: () => {},
      onParseError: () => {},
      onEnd: () => {},
    });
    assert.notEqual(output.write, real, "while serving, nobody else's writes reach stdout");
    transport.stop();
    assert.equal(output.write, real);
  });

  it("refuses to sit on a terminal, where no client can ever close stdin", () => {
    // The one lifetime the pipes cannot express: a stdin shared with something
    // that will never close it (a terminal, or a caller spawning with
    // stdio:"inherit"). Say so rather than wait forever.
    assert.equal(clientOwnsStdin({ isTTY: true }), false);
    assert.equal(clientOwnsStdin({ isTTY: undefined }), true, "a pipe is what a client gives us");
  });
});
