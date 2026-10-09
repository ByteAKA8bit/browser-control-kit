// MCP server loop: JSON-RPC 2.0 over the stdio framing in ./transport.mjs.
// Hand-rolled: the repo carries one third-party dependency (playwright-core)
// and the whole protocol path stays readable in two screens.
// Non-goal: resources, prompts, sampling, batching. Invariant: the server
// exits only when its client is gone, never because a page threw.
import { createRequire } from "node:module";
import { clientOwnsStdin, createStdioTransport, log } from "./transport.mjs";
import { INSTRUCTIONS, InvalidParams, Session, callTool, toolSpecs } from "./tools.mjs";

// The manifest is the one version; a copy here drifts, and this is what a
// client reports when an operator asks which server is running.
const require = createRequire(import.meta.url);
const { name, version } = require("../package.json");
const SERVER_INFO = { name, version };
const LATEST_PROTOCOL = "2025-06-18";
const PROTOCOL_VERSIONS = [LATEST_PROTOCOL, "2025-03-26", "2024-11-05"];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** Speak the client's version when we know it, otherwise offer our newest. */
function negotiateProtocol(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL;
}

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Start serving; returns the transport so a host can stop it. */
export function startServer({ input = process.stdin, output = process.stdout } = {}) {
  // A terminal on stdin means no MCP client: a server waiting for a human to type JSON-RPC never ends.
  if (!clientOwnsStdin(input)) {
    log("stdin is a terminal, so no MCP client is attached. Launch this from a client, or pipe JSON-RPC in.");
    process.exitCode = 2;
    return null;
  }
  const session = new Session();

  // MCP stdio has no shutdown request, so "client gone" is the only exit, and
  // it has several spellings (stdin ended, either stream broke) — run once.
  let stopping = false;
  const stop = async (why) => {
    if (stopping) return;
    stopping = true;
    log(`${why}, shutting down`);
    transport.stop();
    await session.close();
    // Our own waits end with session.close(); a timer the script body created
    // itself is not ours to clear, and with the client gone and the browser
    // closed, waiting for it is waiting forever. BC_MCP_EXIT_GRACE_MS=0 waits.
    const grace = Number(process.env.BC_MCP_EXIT_GRACE_MS ?? 250);
    if (grace > 0) setTimeout(() => process.exit(0), grace).unref(); // unref'd: a clean process still exits at once
  };

  const methods = {
    // instructions is the one place the addressing model is explained.
    initialize: (params) => ({
      protocolVersion: negotiateProtocol(params.protocolVersion),
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    }),
    ping: () => ({}),
    "tools/list": () => ({ tools: toolSpecs() }),
    "tools/call": (params) => {
      if (typeof params.name !== "string") throw new InvalidParams('tools/call requires a string "name"');
      return callTool(params.name, params.arguments ?? {}, session);
    },
  };

  /** One request in, at most one reply out. Notifications reply with nothing. */
  const handle = async (message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return failure(null, INVALID_REQUEST, "expected a single JSON-RPC 2.0 request object");
    }
    const notification = message.id === undefined;
    const id = message.id ?? null;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return notification ? null : failure(id, INVALID_REQUEST, 'a request needs "jsonrpc":"2.0" and a string "method"');
    }
    // Answering a notification is a protocol violation some clients treat as a fatal desync.
    if (notification) {
      log(`notification ${message.method}`);
      return null;
    }
    const method = methods[message.method];
    if (!method) return failure(id, METHOD_NOT_FOUND, `unknown method "${message.method}"`);
    try {
      return result(id, await method(message.params ?? {}));
    } catch (err) {
      const code = err instanceof InvalidParams ? INVALID_PARAMS : INTERNAL_ERROR;
      return failure(id, code, String(err?.message ?? err).split("\n")[0]);
    }
  };

  const transport = createStdioTransport({
    input,
    output,
    onMessage: (message) => {
      void handle(message).then((reply) => {
        if (reply) transport.send(reply);
      });
    },
    onParseError: (line) => {
      log(`malformed JSON (${line.length} bytes)`);
      transport.send(failure(null, PARSE_ERROR, "invalid JSON: messages are one JSON object per line"));
    },
    onEnd: () => void stop("client closed the stream"),
  });

  // A page that throws or a socket that dies mid-screenshot is loud on stderr; dying here is what makes a client look flaky.
  process.on("uncaughtException", (err) => log(`uncaught: ${String(err?.stack ?? err).split("\n")[0]}`));
  process.on("unhandledRejection", (err) => log(`unhandled rejection: ${String(err?.message ?? err).split("\n")[0]}`));

  log(`ready (${SERVER_INFO.version}, protocol ${LATEST_PROTOCOL})`);
  return transport;
}
