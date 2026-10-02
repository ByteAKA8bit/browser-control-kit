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
 * An MCP stdio server is owned by its client: the protocol hands the other end
 * of these pipes to that client, so the pipes ARE the lifetime. stdin ending —
 * or either stream breaking — means the client is gone, including when it was
 * killed outright, because the kernel closes its end for it.
 *
 * What this deliberately does NOT do is watch `process.ppid` for re-parenting.
 * It reads like a fact and is a guess: plenty of clients are started behind a
 * launcher that exits immediately, and exiting then would end a session that is
 * still working — trading a wasted process for lost work. It is also unreliable
 * exactly where it would matter (Windows has no re-parenting; a container whose
 * parent is already PID 1 never changes) and it would put a polling timer in a
 * server that promises to have none.
 *
 * The one case pipes cannot cover is a caller that hands us a stdin it shares
 * with something else (`stdio: "inherit"`), which nobody will ever close. That
 * is a bug in the spawn, and it is said out loud instead of guessed around.
 */
export function clientOwnsStdin(input = process.stdin) {
  return !input.isTTY;
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
  // Every way the client can vanish, not just the polite one: stdin ends, stdin
  // breaks, or stdout refuses our writes (EPIPE — nobody is reading any more).
  input.on("end", onEnd);
  input.on("error", onEnd);
  output.on("error", onEnd);
  return {
    send: (message) => send(`${JSON.stringify(message)}\n`),
    stop: () => {
      input.pause();
      input.destroy?.();
    },
  };
}
