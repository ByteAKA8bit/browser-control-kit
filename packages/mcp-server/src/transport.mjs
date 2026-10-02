// Newline-delimited JSON over stdin/stdout — the framing layer only.
//
// Non-goal: JSON-RPC semantics (src/server.mjs) and anything to do with a
// browser (src/tools.mjs). Nothing here imports browser-control, so an idle
// server never loads playwright-core.
//
// Two properties every MCP client silently depends on, and that hand-rolled
// servers usually get wrong:
//   * stdout carries protocol bytes and NOTHING else. One stray diagnostic
//     print from any module in the process desynchronises the stream and the
//     client reports "server disconnected" with no explanation.
//   * a response larger than the pipe buffer (a screenshot) must be queued on
//     backpressure, never written while an earlier one is still draining.

/** Split arbitrary stdin chunks into whole lines; blank lines are ignored. */
export function createLineDecoder(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
      nl = buffer.indexOf("\n");
    }
  };
}

/**
 * Take over `stdout`: returns the only function that still reaches it, and
 * reroutes everyone else's writes (a stray print, a dependency's banner) to
 * stderr instead of letting them corrupt the protocol stream.
 */
export function captureStdout(stdout = process.stdout, stderr = process.stderr) {
  const real = stdout.write.bind(stdout);
  stdout.write = (chunk, encoding, cb) => stderr.write(chunk, encoding, cb);
  return real;
}

/** Serialise writes behind backpressure so no two messages interleave. */
export function createWriter(write, stream) {
  const queue = [];
  let blocked = false;
  const pump = () => {
    while (!blocked && queue.length) {
      if (write(queue.shift()) === false) {
        blocked = true;
        stream.once("drain", () => {
          blocked = false;
          pump();
        });
      }
    }
  };
  return (text) => {
    queue.push(text);
    pump();
  };
}

/** Diagnostics go to stderr, always; BC_MCP_QUIET=1 silences them. */
export function log(message) {
  if (process.env.BC_MCP_QUIET === "1") return;
  process.stderr.write(`[browser-control-mcp] ${message}\n`);
}

/**
 * Wire stdin/stdout into one message stream.
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream,
 *           onMessage: (message: unknown) => void, onParseError: (line: string) => void,
 *           onEnd: () => void }} handlers
 */
export function createStdioTransport({ input = process.stdin, output = process.stdout, onMessage, onParseError, onEnd }) {
  const send = createWriter(captureStdout(output), output);
  const decode = createLineDecoder((line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // A malformed line is the client's bug to hear about, not ours to die of.
      onParseError(line);
      return;
    }
    onMessage(message);
  });
  input.setEncoding("utf8");
  input.on("data", decode);
  input.on("end", onEnd);
  return {
    send: (message) => send(`${JSON.stringify(message)}\n`),
    stop: () => {
      input.pause();
      input.destroy?.();
    },
  };
}
