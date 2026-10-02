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
import path from "node:path";

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
    assert.ok(result.serverInfo.version, "serverInfo carries a version");
  });

  it("falls back to its own version when the client asks for an unknown one", async () => {
    const { result } = await client.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    assert.equal(result.protocolVersion, "2025-06-18");
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
      "browser_evaluate",
      "browser_fill",
      "browser_navigate",
      "browser_screenshot",
      "browser_status",
      "browser_tab_close",
      "browser_tab_select",
      "browser_tabs",
      "browser_text",
      "browser_type",
      "browser_wait_for",
    ]);
    for (const tool of result.tools) {
      assert.match(tool.description, /^\S.*\.$/, `${tool.name} needs a description that reads as a sentence`);
      assert.ok(!tool.description.includes("\n"), `${tool.name} description must be one line`);
      // Long enough to steer behaviour, short enough to stay in a tool list: the
      // tab tools have to explain why they will not open a tab for you.
      assert.ok(tool.description.length <= 320, `${tool.name} description must stay readable (${tool.description.length} chars)`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} schema`);
      assert.equal(typeof tool.inputSchema.properties, "object");
      assert.ok(Array.isArray(tool.inputSchema.required), `${tool.name} declares required`);
      for (const key of tool.inputSchema.required) {
        assert.ok(tool.inputSchema.properties[key], `${tool.name} requires "${key}" but does not declare it`);
      }
    }
    assert.ok(
      !result.tools.some((tool) => /new_tab|open_tab|tab_new/.test(tool.name)),
      "no tool may let an agent grow the tab count",
    );
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
});

describe("lifecycle", () => {
  it("exits cleanly on stdin EOF without ever being initialised", async () => {
    const client = startClient(NO_BROWSER);
    assert.equal(await client.stop(), 0);
    assert.deepEqual(client.lines, [], "a server nobody spoke to writes nothing to stdout");
  });
});
