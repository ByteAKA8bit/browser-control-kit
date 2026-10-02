// MCP server loop: JSON-RPC 2.0 over the stdio framing in ./transport.mjs.
//
// Hand-rolled on purpose. The repo carries exactly one third-party dependency
// (playwright-core), and an agent debugging a flaky MCP connection can read the
// entire protocol path here in two screens.
//
// Non-goal: every MCP feature. Tools only — no resources, prompts, sampling or
// batching. The server never exits because a page threw; it exits when its
// client is gone — stdin closed, a broken stream, or the client killed — and
// for no other reason.
import { clientOwnsStdin, createStdioTransport, log } from "./transport.mjs";
import { INSTRUCTIONS, InvalidParams, Session, callTool, toolSpecs } from "./tools.mjs";

// Keep in sync with package.json.
const SERVER_INFO = { name: "browser-control-mcp", version: "0.1.0" };
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

/**
 * Start serving. Returns the transport so a host can stop it; the binary just
 * calls this and lets the process live until stdin closes.
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} streams
 */
export function startServer({ input = process.stdin, output = process.stdout } = {}) {
  // The client owns these pipes — that IS the server's lifetime. A terminal on
  // stdin means nobody is speaking MCP here, and a server that waits for a
  // human to type JSON-RPC is a process that never ends.
  if (!clientOwnsStdin(input)) {
    log("stdin is a terminal, so no MCP client is attached. Launch this from a client, or pipe JSON-RPC in.");
    process.exitCode = 2;
    return null;
  }
  const session = new Session();

  // The client going away is the only way out — MCP stdio has no shutdown
  // request, and inventing one would be a second lifecycle to keep correct.
  // "Gone" has several spellings (stdin ended, either stream broke), so this
  // runs at most once.
  let stopping = false;
  const stop = async (why) => {
    if (stopping) return;
    stopping = true;
    log(`${why}, shutting down`);
    transport.stop();
    await session.close();
    // No timers and no sockets of our own: the loop drains the last reply and
    // the process exits on its own.
  };

  const methods = {
    // instructions is the one place the addressing model is explained: once,
    // before the first call, instead of a reminder in every tool description.
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
    // notifications/initialized and friends are acknowledgements; answering one
    // is a protocol violation that some clients treat as a fatal desync.
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

  // A page that throws, a socket that dies mid-screenshot: loud on stderr, and
  // the server keeps answering. Dying here is what makes a client look flaky.
  process.on("uncaughtException", (err) => log(`uncaught: ${String(err?.stack ?? err).split("\n")[0]}`));
  process.on("unhandledRejection", (err) => log(`unhandled rejection: ${String(err?.message ?? err).split("\n")[0]}`));

  log(`ready (${SERVER_INFO.version}, protocol ${LATEST_PROTOCOL})`);
  return transport;
}
