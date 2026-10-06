// Why these exist: the launchd agent is a plist, a plist is XML, and the three
// things that make it load were shipped on a one-off `plutil -lint` and nothing
// else. A home directory may legally contain `&`, `<` or a space (`/tmp/bc
// smoke/a&b<c`), and an unescaped one yields a file launchctl refuses with a
// parse error that names nothing; a wrong escape is worse, since it loads and
// hands the shim a path that is not the operator's. KeepAlive=true without an
// explicit ThrottleInterval is launchd's 10-second relaunch loop, which is the
// reason the key is there at all.
//
// scripts/install-shim-service.mjs builds that plist with pure string
// concatenation, so all of it is checked here with no launchd, no launchctl, no
// `~/Library/LaunchAgents` and no temp files except in the macOS-only
// cross-check against Apple's own parser (skipped elsewhere). XML is validated
// by the strict reader below rather than by substring matching, so a test fails
// on what launchd would actually reject.
//
//   node --test test/shim-service.test.mjs
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ENV_KEYS, buildPlist, captureEnv, footprint } from "../../../scripts/install-shim-service.mjs";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const TAG = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*"[^"<]*")*)\s*(\/?)>/;

/** Text content, refusing every `&` that is not a legal reference — the mistake under test. */
function decodeText(raw, at) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "&") {
      out += raw[i];
      continue;
    }
    const ref = /^&(?:([a-zA-Z]+)|#(\d+)|#x([0-9A-Fa-f]+));/.exec(raw.slice(i));
    if (!ref) throw new Error(`unescaped "&" at offset ${at + i}: ${JSON.stringify(raw.slice(i, i + 24))}`);
    if (ref[1] !== undefined) {
      if (!(ref[1] in ENTITIES)) throw new Error(`unknown entity &${ref[1]};`);
      out += ENTITIES[ref[1]];
    } else {
      out += String.fromCodePoint(parseInt(ref[2] ?? ref[3], ref[2] !== undefined ? 10 : 16));
    }
    i += ref[0].length - 1;
  }
  return out;
}

/** A strict XML reader: well-formedness only, which is exactly what a plist needs. */
function parseXml(src) {
  const root = { name: "#document", attrs: {}, children: [], text: "" };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      top().text += decodeText(src.slice(i), i);
      break;
    }
    if (lt > i) top().text += decodeText(src.slice(i, lt), i);
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      if (end === -1) throw new Error(`unterminated comment at offset ${lt}`);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) {
      const close = src.startsWith("<?", lt) ? "?>" : ">";
      const end = src.indexOf(close, lt + 2);
      if (end === -1) throw new Error(`unterminated declaration at offset ${lt}`);
      i = end + close.length;
      continue;
    }
    const tag = TAG.exec(src.slice(lt));
    if (!tag) throw new Error(`malformed markup at offset ${lt}: ${JSON.stringify(src.slice(lt, lt + 24))}`);
    const [all, closing, name, attrs, selfClose] = tag;
    if (closing) {
      if (stack.length === 1) throw new Error(`stray </${name}> at offset ${lt}`);
      const open = stack.pop();
      if (open.name !== name) throw new Error(`</${name}> closes <${open.name}> at offset ${lt}`);
    } else {
      const el = { name, attrs: {}, children: [], text: "" };
      for (const [, key, value] of attrs.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*"([^"<]*)"/g)) el.attrs[key] = decodeText(value, lt);
      top().children.push(el);
      if (!selfClose) stack.push(el);
    }
    i = lt + all.length;
  }
  if (stack.length !== 1) throw new Error(`unclosed <${top().name}>`);
  return root;
}

/** The plist node types this agent uses, as plain JS values. */
function plistValue(el) {
  switch (el.name) {
    case "dict": {
      const kids = el.children;
      if (kids.length % 2) throw new Error("<dict> has a key without a value");
      const out = {};
      for (let i = 0; i < kids.length; i += 2) {
        if (kids[i].name !== "key") throw new Error(`expected <key>, got <${kids[i].name}>`);
        out[kids[i].text] = plistValue(kids[i + 1]);
      }
      return out;
    }
    case "array":
      return el.children.map(plistValue);
    case "string":
      return el.text;
    case "true":
      return true;
    case "false":
      return false;
    case "integer":
      if (!/^-?\d+$/.test(el.text.trim())) throw new Error(`<integer> is not an integer: ${el.text}`);
      return Number(el.text.trim());
    case "real":
      return Number(el.text.trim());
    default:
      throw new Error(`unsupported plist node <${el.name}>`);
  }
}

function parsePlist(text) {
  const plist = parseXml(text).children.find((el) => el.name === "plist");
  if (!plist) throw new Error("no <plist> root element");
  if (plist.children.length !== 1) throw new Error(`<plist> holds ${plist.children.length} values`);
  return plistValue(plist.children[0]);
}

/** A home directory and values that are legal on macOS and hostile to XML. */
const HOSTILE = {
  label: "com.browser-control.shim",
  nodePath: '/opt/node & co/bin/"node"',
  shimPath: "/Users/a&b/src/<kit>/packages/browser-control/src/cdp-shim.mjs",
  logDir: "/tmp/bc smoke/a&b<c>d'e",
  env: { SHIM_PORT: "93&33", CHROME_HOST: '127.0.0.1 <"primary">' },
};

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("launchd agent plist", () => {
  it("is well-formed XML even when every value is hostile to XML", () => {
    const parsed = parsePlist(buildPlist(HOSTILE));
    // The strict reader throws on any `&` or `<` that survived unescaped.
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["EnvironmentVariables", "KeepAlive", "Label", "ProcessType", "ProgramArguments", "RunAtLoad", "StandardErrorPath", "StandardOutPath", "ThrottleInterval"],
    );
  });

  it("escapes without changing the values launchd will hand the shim", () => {
    const parsed = parsePlist(buildPlist(HOSTILE));
    assert.deepEqual(parsed.ProgramArguments, [HOSTILE.nodePath, HOSTILE.shimPath]);
    assert.equal(parsed.Label, HOSTILE.label);
    assert.equal(parsed.StandardOutPath, path.join(HOSTILE.logDir, "shim.log"));
    assert.equal(parsed.StandardErrorPath, path.join(HOSTILE.logDir, "shim.err.log"));
    assert.deepEqual(parsed.EnvironmentVariables, HOSTILE.env);
    // Nothing escaped stayed escaped: an `&amp;` left in a value is a different path.
    for (const value of [parsed.StandardOutPath, parsed.ProgramArguments[1], parsed.EnvironmentVariables.SHIM_PORT]) {
      assert.equal(value.includes("&amp;"), false);
      assert.equal(value.includes("&"), true);
    }
  });

  it("keeps KeepAlive armed behind a positive ThrottleInterval", () => {
    const parsed = parsePlist(buildPlist({ logDir: "/tmp/bc" }));
    assert.equal(parsed.KeepAlive, true, "the agent must be restarted when it dies");
    assert.equal(Number.isInteger(parsed.ThrottleInterval), true);
    assert.equal(parsed.ThrottleInterval > 0, true, "KeepAlive with no throttle is launchd's 10s relaunch loop");
    assert.equal(parsed.RunAtLoad, true);
  });

  it("captures the shim variables that are actually set, and only those", () => {
    const captured = captureEnv({
      SHIM_PORT: "9333",
      CHROME_PORT_FILE: "/tmp/bc/port",
      CHROME_PORT: "", // set but empty: no value to pass on
      PATH: "/usr/bin", // not ours
      HOME: "/Users/op",
    });
    assert.deepEqual(captured, { SHIM_PORT: "9333", CHROME_PORT_FILE: "/tmp/bc/port" });
    assert.deepEqual(captureEnv({}), {});
    assert.deepEqual(ENV_KEYS, ["SHIM_PORT", "CHROME_PORT", "CHROME_PORT_FILE", "CHROME_HOST", "BC_SHIM_KEEPALIVE_MS"]);
  });

  it("writes the captured variables into EnvironmentVariables, inventing none", () => {
    const env = captureEnv({
      SHIM_PORT: "9333",
      CHROME_PORT: "9222",
      CHROME_PORT_FILE: "/tmp/bc/port",
      CHROME_HOST: "127.0.0.1",
      BC_SHIM_KEEPALIVE_MS: "15000",
    });
    const parsed = parsePlist(buildPlist({ logDir: "/tmp/bc", env }));
    assert.deepEqual(parsed.EnvironmentVariables, env);
  });

  it("omits EnvironmentVariables entirely when nothing was set", () => {
    const parsed = parsePlist(buildPlist({ logDir: "/tmp/bc", env: captureEnv({}) }));
    assert.equal("EnvironmentVariables" in parsed, false, "an empty dict would pin empty values on the shim");
    assert.equal(parsed.StandardOutPath, path.join("/tmp/bc", "shim.log"));
  });

  it("the reader used above rejects what launchd would reject", () => {
    // Without this, a permissive reader would make the escaping tests vacuous.
    const wrap = (body) => `<plist version="1.0"><dict>${body}</dict></plist>`;
    assert.throws(() => parsePlist(wrap("<key>a</key><string>a & b</string>")), /unescaped/);
    assert.throws(() => parsePlist(wrap("<key>a</key><string>a < b</string>")), /malformed markup/);
    assert.throws(() => parsePlist(wrap("<key>a</key><string>a</strung>")), /closes <string>/);
    assert.throws(() => parsePlist('<plist version="1.0"><dict><key>a</key><string>a</string>'), /unclosed/);
    assert.throws(() => parsePlist(wrap("<key>a</key>")), /key without a value/);
    assert.equal(parsePlist(wrap("<key>a&amp;b</key><string>x&lt;y</string>"))["a&b"], "x<y");
  });

  it(
    "parses as a property list for Apple's own parser too",
    { skip: process.platform === "darwin" ? false : "plutil is macOS-only" },
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "bc-plist-"));
      tmpDirs.push(dir);
      const file = path.join(dir, "com.browser-control.shim.plist");
      const text = buildPlist(HOSTILE);
      writeFileSync(file, text);
      execFileSync("plutil", ["-lint", file], { stdio: "pipe" });
      const apple = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { stdio: "pipe" }).toString());
      assert.deepEqual(apple, parsePlist(text));
      assert.deepEqual(apple.ProgramArguments, [HOSTILE.nodePath, HOSTILE.shimPath]);
      assert.deepEqual(apple.EnvironmentVariables, HOSTILE.env);
      assert.equal(apple.KeepAlive, true);
      assert.equal(apple.ThrottleInterval > 0, true);
    },
  );
});

// "What did installing this put on my machine?" must have one answer, and
// --uninstall must delete exactly that answer. Both read the same list, so the
// list is what gets pinned: miss a file here and it is left behind forever.
describe("footprint", () => {
  const home = "/Users/op";
  const paths = footprint({ home });

  it("names every path the kit can create, and nothing outside one cache directory", () => {
    const ours = paths.filter((entry) => entry.ours).map((entry) => entry.path);
    assert.deepEqual(ours, [
      `${home}/Library/LaunchAgents/com.browser-control.shim.plist`,
      `${home}/.cache/browser-control/shim.log`,
      `${home}/.cache/browser-control/shim.err.log`,
      `${home}/.cache/browser-control`,
    ]);
    assert.ok(
      ours.every((file) => file.startsWith(`${home}/.cache/browser-control`) || file.endsWith(".plist")),
      "one directory plus the plist launchd insists on owning",
    );
  });

  it("keeps the operator's token out of what gets removed", () => {
    const token = paths.find((entry) => entry.path.endsWith("/token"));
    assert.equal(token.ours, false, "deleting a secret the operator pasted is not cleanup");
    assert.match(token.what, /never written/);
  });

  it("follows BC_SHIM_LOG_DIR, so the logs cannot end up somewhere unlisted", () => {
    const moved = footprint({ home, logDir: "/tmp/bc-logs" });
    assert.deepEqual(
      moved.filter((entry) => entry.path.endsWith(".log")).map((entry) => entry.path),
      ["/tmp/bc-logs/shim.log", "/tmp/bc-logs/shim.err.log"],
    );
    assert.ok(moved.some((entry) => entry.path === "/tmp/bc-logs" && entry.dir));
  });

  it("names the global npm link too, without claiming the right to delete it", () => {
    const listed = footprint({ home, npmPrefix: "/opt/node" }).filter((entry) => entry.path.startsWith("/opt/node"));
    assert.deepEqual(
      listed.map((entry) => [entry.path, entry.ours]),
      [
        ["/opt/node/bin/browser-control-mcp", false],
        ["/opt/node/lib/node_modules/browser-control-mcp", false],
      ],
    );
    assert.match(listed[0].what, /npm rm -g/);
  });
});
