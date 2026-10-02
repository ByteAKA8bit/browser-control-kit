// Why these exist: the shim proxies Chrome's CDP socket so the operator approves
// ONE connection instead of one per run — which means a hand-rolled RFC 6455
// server sits between every automation client and the browser. Frame boundaries
// (126/65536 length switches, client masking, fragmentation, control frames) are
// exactly where such a codec breaks, and a break looks like a hung automation
// run, not an error. No browser needed.
//
//   node --test test/ws-server.test.mjs
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { accept, decodeFrame, encodeFrame, upgrade } from "../src/ws-server.mjs";

describe("frame codec", () => {
  it("round-trips the three payload-length encodings", () => {
    for (const size of [0, 125, 126, 65_535, 65_536, 200_000]) {
      const payload = Buffer.alloc(size, 0x61);
      const frame = encodeFrame(0x1, payload);
      const header = size < 126 ? 2 : size < 65_536 ? 4 : 10;
      assert.equal(frame.length, header + size, `header size for ${size}`);
      const decoded = decodeFrame(frame);
      assert.equal(decoded.payload.length, size);
      assert.equal(decoded.size, frame.length);
      assert.equal(decoded.fin, true);
    }
  });

  it("unmasks client frames (clients MUST mask, servers MUST NOT)", () => {
    const payload = Buffer.from("ping the browser", "utf8");
    const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i & 3];
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);

    assert.equal(decodeFrame(frame).payload.toString(), "ping the browser");
    assert.equal((encodeFrame(0x1, payload)[1] & 0x80) === 0, true, "server frames are never masked");
  });

  it("returns null until a whole frame has arrived", () => {
    const frame = encodeFrame(0x1, Buffer.alloc(300, 0x62));
    assert.equal(decodeFrame(frame.subarray(0, 1)), null);
    assert.equal(decodeFrame(frame.subarray(0, 3)), null, "16-bit length header is incomplete");
    assert.equal(decodeFrame(frame.subarray(0, frame.length - 1)), null, "payload is incomplete");
    assert.equal(decodeFrame(frame).payload.length, 300);
  });

  it("refuses an absurd declared length instead of allocating it", () => {
    const frame = Buffer.alloc(10);
    frame[0] = 0x81;
    frame[1] = 127;
    frame.writeBigUInt64BE(1n << 40n, 2);
    assert.throws(() => decodeFrame(frame), /frame too large/);
  });

  it("computes the handshake accept key from RFC 6455", () => {
    assert.equal(accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

describe("live connection", () => {
  let server;
  let port;
  const received = [];
  const serverConns = [];
  const closed = [];

  before(async () => {
    server = createServer((_req, res) => res.end());
    server.on("upgrade", (req, socket, head) => {
      const conn = upgrade(req, socket, head);
      serverConns.push(conn);
      conn.onMessage = (msg) => {
        received.push(msg);
        conn.send(msg); // echo
      };
      conn.onClose = () => closed.push(conn);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });

  after(() => server.close());

  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/test`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("handshake failed"));
    });
    return ws;
  };

  it("completes a real handshake and echoes a message", async () => {
    const ws = await connect();
    const reply = new Promise((r) => (ws.onmessage = (e) => r(e.data)));
    ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    assert.equal(await reply, '{"id":1,"method":"Browser.getVersion"}');
    ws.close();
  });

  it("survives a payload larger than a single TCP segment (screenshots are)", async () => {
    const ws = await connect();
    const big = "x".repeat(300_000);
    const reply = new Promise((r) => (ws.onmessage = (e) => r(e.data)));
    ws.send(big);
    const echoed = await reply;
    assert.equal(echoed.length, big.length, "large frames must survive both directions");
    ws.close();
  });

  it("tells the server when a client goes away (the shim frees its state there)", async () => {
    const ws = await connect();
    const conn = serverConns[serverConns.length - 1];
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(conn.closed, true);
    assert.equal(closed.filter((c) => c === conn).length, 1, "onClose fires exactly once");
  });

  // The global WebSocket client will not fragment a message, send a stray ping,
  // or declare a length it has no intention of delivering — which is exactly
  // the half of RFC 6455 a proxy in front of the operator's browser must take
  // from a hostile or merely buggy client. So these speak the wire directly.
  const rawConnect = async () => {
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", resolve);
    });
    const handshake = new Promise((resolve) => socket.once("data", (chunk) => resolve(chunk.toString("latin1"))));
    socket.write(
      [
        "GET /devtools/browser/raw HTTP/1.1",
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==",
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n"),
    );
    assert.match(await handshake, /^HTTP\/1\.1 101 /);
    return socket;
  };

  /** One masked client frame; `fin: false` makes it a fragment. */
  const clientFrame = (opcode, payload, fin = true) => {
    const body = Buffer.isBuffer(payload) ? Buffer.from(payload) : Buffer.from(payload, "utf8");
    const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    let head;
    if (body.length < 126) {
      head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | body.length]);
    } else if (body.length < 65_536) {
      head = Buffer.alloc(4);
      head.writeUInt16BE(body.length, 2);
      head[1] = 0x80 | 126;
    } else {
      head = Buffer.alloc(10);
      head.writeBigUInt64BE(BigInt(body.length), 2);
      head[1] = 0x80 | 127;
    }
    head[0] = (fin ? 0x80 : 0) | opcode;
    for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i & 3];
    return Buffer.concat([head, mask, body]);
  };

  /** Server frames are unmasked and may be coalesced, so decode from a running buffer. */
  const reader = (socket) => {
    let buffer = Buffer.alloc(0);
    const ready = [];
    const waiting = [];
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) return;
        buffer = buffer.subarray(frame.size);
        if (waiting.length) waiting.shift()(frame);
        else ready.push(frame);
      }
    });
    return () => (ready.length ? Promise.resolve(ready.shift()) : new Promise((r) => waiting.push(r)));
  };

  it("reassembles a message split across continuation frames (multi-byte UTF-8 cut in half)", async () => {
    const socket = await rawConnect();
    const next = reader(socket);
    const message = "ページを開く — 日本語の本文";
    const bytes = Buffer.from(message, "utf8");
    const cut = 7; // inside a 3-byte character: decoding per fragment would mojibake it
    assert.equal(bytes[cut] & 0xc0, 0x80, "the split must land on a UTF-8 continuation byte");
    socket.write(clientFrame(0x1, bytes.subarray(0, cut), false));
    socket.write(clientFrame(0x0, bytes.subarray(cut, cut + 5), false));
    socket.write(clientFrame(0x0, bytes.subarray(cut + 5), true));
    const echo = await next();
    assert.equal(echo.opcode, 0x1, "a fragmented text message echoes back as one text frame");
    assert.equal(echo.payload.toString("utf8"), message);
    assert.equal(received[received.length - 1], message, "the handler sees the whole message, once");
    socket.destroy();
  });

  it("answers a ping with a pong and a close with a close", async () => {
    const socket = await rawConnect();
    const next = reader(socket);
    const conn = serverConns[serverConns.length - 1];
    socket.write(clientFrame(0x9, "keep-alive"));
    const pong = await next();
    assert.equal(pong.opcode, 0xa);
    assert.equal(pong.payload.toString(), "keep-alive", "a pong carries the ping's payload back");
    socket.write(clientFrame(0x8, Buffer.alloc(0)));
    const bye = await next();
    assert.equal(bye.opcode, 0x8);
    assert.equal(bye.payload.readUInt16BE(0), 1000);
    assert.equal(conn.closed, true, "a close frame ends the connection, not just the client's half");
    socket.destroy();
  });

  it("refuses a fragment flood on the same path as one oversized frame", async () => {
    // The real ceiling is 256MB; pushing that through a socket proves nothing
    // the path does not, so each connection's copy of it is lowered instead.
    const flood = await rawConnect();
    serverConns[serverConns.length - 1]._max = 65_536;
    const nextFlood = reader(flood);
    const part = Buffer.alloc(32_768, 0x61);
    // Paced so the server consumes each fragment before the next arrives: that
    // is what makes the running total, not one fat read buffer, the thing that
    // trips the ceiling.
    flood.write(clientFrame(0x1, part, false));
    await new Promise((r) => setTimeout(r, 20));
    flood.write(clientFrame(0x0, part, false));
    await new Promise((r) => setTimeout(r, 20));
    flood.write(clientFrame(0x0, part, false)); // every fragment is legal; the total is not
    const floodClose = await nextFlood();
    assert.equal(floodClose.opcode, 0x8);
    assert.equal(floodClose.payload.readUInt16BE(0), 1009, "fragments that never end close with message-too-big");
    flood.destroy();

    const huge = await rawConnect();
    serverConns[serverConns.length - 1]._max = 65_536;
    const nextHuge = reader(huge);
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(1n << 40n, 2);
    huge.write(header); // a terabyte promised, nothing delivered
    const hugeClose = await nextHuge();
    assert.equal(hugeClose.opcode, 0x8);
    assert.equal(hugeClose.payload.readUInt16BE(0), 1009, "an absurd length closes too, instead of throwing out of a data event");
    huge.destroy();
  });

  it("survives a handler that throws (the shim's bug must not kill its process)", async () => {
    const ws = await connect();
    const conn = serverConns[serverConns.length - 1];
    let calls = 0;
    conn.onMessage = () => {
      calls += 1;
      throw new Error("handler bug");
    };
    ws.send("boom");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 1);
    assert.equal(conn.closed, false, "a throwing handler is the caller's fault, not this connection's end");
    conn.onMessage = (msg) => conn.send(msg);
    const reply = new Promise((r) => (ws.onmessage = (e) => r(e.data)));
    ws.send("still here");
    assert.equal(await reply, "still here", "the connection still works after a handler threw");
    ws.close();
  });

  // The ceiling is a limit on one message, not on how much a client may have in
  // flight. A busy CDP client pipelines commands, so a single read can carry
  // dozens of complete frames whose bytes add up past the ceiling while every
  // one of them is tiny. Blaming that read on an oversized frame kills a
  // perfectly legal connection.
  it("delivers many complete frames coalesced in one read even when their bytes together exceed the ceiling", async () => {
    const socket = await rawConnect();
    const conn = serverConns[serverConns.length - 1];
    conn._max = 4096;
    const next = reader(socket);
    const body = "a".repeat(1000); // each frame is a quarter of the ceiling
    const count = 40; // together ~40KB, an order of magnitude over it
    socket.write(Buffer.concat(Array.from({ length: count }, (_, i) => clientFrame(0x1, `${i}:${body}`))));
    for (let i = 0; i < count; i += 1) {
      const echo = await next();
      assert.equal(echo.opcode, 0x1, "every coalesced frame comes back as its own text frame");
      assert.equal(echo.payload.toString("utf8"), `${i}:${body}`, "frames stay in order and keep their payloads");
    }
    assert.equal(conn.closed, false, "a read full of legal frames must not be mistaken for one oversized frame");
    socket.destroy();
  });

  it("closes 1009 for a stalled frame whose declared length alone is over the ceiling", async () => {
    const socket = await rawConnect();
    const conn = serverConns[serverConns.length - 1];
    conn._max = 4096;
    const next = reader(socket);
    const header = Buffer.alloc(8);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(60_000, 2); // a 16-bit length: under decodeFrame's throw, over the ceiling
    socket.write(Buffer.concat([header, Buffer.alloc(8192)])); // and then stops delivering
    const bye = await next();
    assert.equal(bye.opcode, 0x8);
    assert.equal(bye.payload.readUInt16BE(0), 1009, "one frame nobody can finish ends like any other too-big message");
    socket.destroy();
  });

  it("releases the bytes of a message it refuses, and never hands that message to the handler", async () => {
    const socket = await rawConnect();
    const conn = serverConns[serverConns.length - 1];
    conn._max = 4096;
    const next = reader(socket);
    const seen = [];
    conn.onMessage = (msg) => seen.push(msg);
    const part = Buffer.alloc(3000, 0x62);
    socket.write(clientFrame(0x1, part, false));
    await new Promise((r) => setTimeout(r, 20));
    socket.write(clientFrame(0x0, part, false)); // 6000 bytes of fragments, over the ceiling
    const bye = await next();
    assert.equal(bye.payload.readUInt16BE(0), 1009);
    assert.equal(conn._buffer.length, 0, "refusing a message must release its bytes, not keep holding them");
    assert.equal(conn._fragments.length, 0);
    assert.equal(conn._fragmentBytes, 0);
    assert.deepEqual(seen, [], "the refused fragments are dropped, not delivered as a partial message");
    socket.destroy();
  });

  it("accepts a payload of exactly the ceiling that arrives across several reads", async () => {
    const socket = await rawConnect();
    const conn = serverConns[serverConns.length - 1];
    conn._max = 8192;
    const next = reader(socket);
    const frame = clientFrame(0x1, Buffer.alloc(8192, 0x63)); // 8 bytes of header+mask, then the ceiling exactly
    socket.write(frame.subarray(0, 4000)); // incomplete: the buffer sits just under max + header slack
    await new Promise((r) => setTimeout(r, 20));
    socket.write(frame.subarray(4000));
    const echo = await next();
    assert.equal(echo.opcode, 0x1);
    assert.equal(echo.payload.length, 8192, "the ceiling is inclusive — a message of exactly max is legal");
    assert.equal(conn.closed, false);
    socket.destroy();
  });

  it("completes the close even when the onClose handler throws", async () => {
    const socket = await rawConnect();
    const conn = serverConns[serverConns.length - 1];
    const next = reader(socket);
    let calls = 0;
    conn.onClose = () => {
      calls += 1;
      throw new Error("close handler bug");
    };
    socket.write(clientFrame(0x8, Buffer.alloc(0)));
    const bye = await next();
    assert.equal(bye.opcode, 0x8, "the peer is still told goodbye");
    assert.equal(bye.payload.readUInt16BE(0), 1000);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 1, "a throwing onClose runs once and is not retried on the socket's own close event");
    assert.equal(conn.closed, true, "the connection is still marked closed after its handler threw");
    socket.destroy();
  });
});
