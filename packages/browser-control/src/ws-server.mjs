// A WebSocket server small enough to own: Node 22 ships a WebSocket *client*
// (used to talk to Chrome) but no server, and this package has exactly one
// dependency on purpose. Automation clients connect here instead of to Chrome —
// one approved CDP connection instead of one approval dialog per run
// (see ./cdp-shim.mjs).
//
// Non-goals: permessage-deflate (CDP payloads are already JSON over loopback),
// subprotocol negotiation, client role. Scope is RFC 6455 text/continuation/
// ping/pong/close; binary frames decode to Buffers, which CDP never sends.
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// One ceiling for three shapes of the same attack (one huge frame, a slow
// half-frame, a continuation flood): a declared frame length, the bytes
// buffered for a frame that never completes, and the running total of a
// fragmented message. All answered with close 1009. Screenshots are big; a bad
// length is not. Edit it here — a knob for it would be a knob for a DoS.
const MAX_MESSAGE = 256 * 1024 * 1024;

export const accept = (key) =>
  createHash("sha1")
    .update(key + GUID)
    .digest("base64");

/**
 * Complete the HTTP upgrade and return a connection, or null when the request is
 * not a valid WebSocket handshake (the caller then destroys the socket).
 */
export function upgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (req.headers.upgrade?.toLowerCase() !== "websocket" || !key) return null;
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept(key)}`,
      "\r\n",
    ].join("\r\n"),
  );
  socket.setNoDelay(true);
  return new WsConnection(socket, head);
}

/** One client. `onMessage(string|Buffer)` and `onClose()` are assigned by the caller. */
export class WsConnection {
  constructor(socket, head) {
    this.socket = socket;
    this.onMessage = () => {};
    this.onClose = () => {};
    this.closed = false;
    this._buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._fragmentBytes = 0;
    // Per connection so a test can lower the ceiling instead of pushing 256MB through a socket.
    this._max = MAX_MESSAGE;
    socket.on("data", (chunk) => this.#ingest(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.#safely("onClose", () => this.onClose());
    });
  }

  /** Send one text frame (strings) or binary frame (Buffers). */
  send(data) {
    if (this.closed) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    this.socket.write(encodeFrame(Buffer.isBuffer(data) ? 0x2 : 0x1, payload));
    return true;
  }

  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    const reason = Buffer.alloc(2);
    reason.writeUInt16BE(code);
    try {
      this.socket.write(encodeFrame(0x8, reason));
    } catch {} // the peer may already be gone; closing is best-effort
    this.socket.end();
    this.#safely("onClose", () => this.onClose());
  }

  /** Run a caller-assigned handler; a handler bug must not take a resident process down. Wraps callbacks only, never the decoder. */
  #safely(name, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`websocket ${name} handler threw: ${String(err?.message ?? err).split("\n")[0]} — the fault is in the handler, not in the frame; this connection stays up`);
    }
  }

  /** Over the ceiling: let go of every buffered byte and close with 1009 ("message too big"). */
  #overflow(detail) {
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentBytes = 0;
    console.error(
      `websocket message over the ${this._max}-byte ceiling (${detail}); closing this connection with 1009 — raise MAX_MESSAGE in src/ws-server.mjs if a client legitimately sends more than that in one message`,
    );
    this.close(1009);
  }

  #ingest(chunk) {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    for (;;) {
      let frame;
      try {
        frame = decodeFrame(this._buffer, this._max);
      } catch (err) {
        // Thrown from a socket "data" listener this would be an uncaught exception.
        return this.#overflow(String(err?.message ?? err).split("\n")[0]);
      }
      if (!frame) {
        // Nothing decodable left, so every remaining byte belongs to ONE unfinished
        // frame. Measured inside the loop, not on arrival: a chunk carrying several
        // complete frames was otherwise blamed as one giant one. Slack is one maximal
        // header (2 + 8 length + 4 mask key) so a payload of exactly the ceiling fits.
        if (this._buffer.length > this._max + 14) this.#overflow(`${this._buffer.length} bytes buffered for one incomplete frame`);
        return;
      }
      this._buffer = this._buffer.subarray(frame.size);
      this.#dispatch(frame);
      if (this.closed) return;
    }
  }

  #dispatch(frame) {
    if (frame.opcode === 0x8) return this.close(1000); // close
    if (frame.opcode === 0x9) return void this.socket.write(encodeFrame(0xa, frame.payload)); // ping → pong
    if (frame.opcode === 0xa) return; // pong
    if (frame.opcode === 0x0) {
      this._fragments.push(frame.payload); // continuation
      this._fragmentBytes += frame.payload.length;
    } else {
      this._fragments = [frame.payload];
      this._fragmentOpcode = frame.opcode;
      this._fragmentBytes = frame.payload.length;
    }
    // Every fragment can be small and legal while the message they build is not.
    if (this._fragmentBytes > this._max) return this.#overflow(`${this._fragmentBytes} bytes across ${this._fragments.length} fragments`);
    if (!frame.fin) return;
    const payload = this._fragments.length === 1 ? this._fragments[0] : Buffer.concat(this._fragments);
    this._fragments = [];
    this._fragmentBytes = 0;
    this.#safely("onMessage", () => this.onMessage(this._fragmentOpcode === 0x2 ? payload : payload.toString("utf8")));
  }
}

/** Frame a payload for sending; servers never mask (RFC 6455 §5.1). */
export function encodeFrame(opcode, payload) {
  const length = payload.length;
  const head = length < 126 ? 2 : length < 65_536 ? 4 : 10;
  const frame = Buffer.allocUnsafe(head + length);
  frame[0] = 0x80 | opcode; // FIN + opcode
  if (length < 126) {
    frame[1] = length;
  } else if (length < 65_536) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  payload.copy(frame, head);
  return frame;
}

/**
 * Decode one frame, or null when `buffer` does not hold a whole one yet.
 * @returns {{ fin: boolean, opcode: number, payload: Buffer, size: number } | null}
 */
export function decodeFrame(buffer, max = MAX_MESSAGE) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(max)) throw new Error(`websocket frame too large: ${big} bytes declared`);
    length = Number(big);
    offset = 10;
  }
  const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  // Clients MUST mask; unmasking in place is the whole cost of the frame.
  if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
  return { fin, opcode, payload, size: offset + length };
}
