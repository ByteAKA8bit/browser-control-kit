// NDJSON framing over stdin/stdout. Non-goal: JSON-RPC semantics
// (./server.mjs) and browsers (./tools.mjs) — nothing here imports
// browser-control, so an idle server never loads playwright-core.
// Invariant: stdout carries protocol bytes and nothing else; one stray print
// desynchronises the stream and the client reports "server disconnected".

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
 * Take over `stdout`: the returned `write` is the only one still reaching it,
 * everyone else is rerouted to stderr. `restore()` is mandatory — a host can
 * start a second server in-process, and a capture left in place would be taken
 * for the real write, sending that server's protocol bytes to stderr.
 */
export function captureStdout(stdout = process.stdout, stderr = process.stderr) {
  const original = stdout.write;
  const write = original.bind(stdout);
  const reroute = (chunk, encoding, cb) => stderr.write(chunk, encoding, cb);
  stdout.write = reroute;
  // Only our own capture is ours to undo; a later wrapper owns what it added.
  return { write, restore: () => { if (stdout.write === reroute) stdout.write = original; } };
}

/** Queue writes behind backpressure so a screenshot never interleaves with the next reply. */
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
 * The client owns these pipes, so stdin ending or either stream breaking means
 * it is gone — including when killed, since the kernel closes its end. NEVER
 * swap this for `process.ppid` watching: launchers that exit immediately would
 * end live sessions, it is a no-op on Windows and under PID 1, and it needs a
 * polling timer. A stdin shared via `stdio: "inherit"` is a bug in the spawn.
 */
export function clientOwnsStdin(input = process.stdin) {
  return !input.isTTY;
}

/** Wire stdin/stdout into one message stream. */
export function createStdioTransport({ input = process.stdin, output = process.stdout, onMessage, onParseError, onEnd }) {
  const captured = captureStdout(output);
  const send = createWriter(captured.write, output);
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
  // Every way the client can vanish: stdin ends, stdin breaks, stdout EPIPEs.
  input.on("end", onEnd);
  input.on("error", onEnd);
  output.on("error", onEnd);
  return {
    send: (message) => send(`${JSON.stringify(message)}\n`),
    stop: () => {
      input.pause();
      input.destroy?.();
      captured.restore();
    },
  };
}
