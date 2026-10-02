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
});
