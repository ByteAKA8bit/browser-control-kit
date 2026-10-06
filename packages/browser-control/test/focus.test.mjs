// Why this exists: attaching launches Chrome, Chrome takes the screen, and the
// cure is shelling out to lsappinfo/open. Shelling out fails in ways that must
// never reach the caller — no helper on PATH, no GUI session, a bundle id that
// no longer resolves — and it must never activate an application nobody asked
// for. Both are pinned here; no browser needed.
//
//   node --test test/focus.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { frontmostApp, isBrowser, restoreFrontmost, watchFocus } from "../src/focus.mjs";

describe("frontmostApp", () => {
  it("answers with a bundle id or nothing, and never throws", async () => {
    const app = await frontmostApp();
    assert.ok(app === null || typeof app === "string", `unexpected ${typeof app}`);
    if (process.platform !== "darwin") assert.equal(app, null, "only macOS can be asked this way");
    else if (app !== null) assert.match(app, /^[\w.-]+$/, "a bundle id, not lsappinfo's raw record");
  });
});

describe("restoreFrontmost", () => {
  it("does nothing at all when it was never told who was in front", async () => {
    const result = await restoreFrontmost(null);
    assert.equal(result.restored, false);
    assert.equal(result.skipped, true);
    assert.match(result.reason, process.platform === "darwin" ? /frontmost-app-unknown/ : /macos-only/);
  });

  it("leaves the screen alone when nothing took the focus", async () => {
    const front = await frontmostApp();
    const result = await restoreFrontmost(front);
    assert.equal(result.restored, false, "restoring to where we already are is not a thing to do");
    assert.equal(result.skipped, true);
    assert.match(result.reason, front ? /nothing-took-the-focus/ : /frontmost-app-unknown|macos-only/);
  });

  it("refuses to take the screen back from anything that is not the browser", async () => {
    const before = await frontmostApp();
    const result = await restoreFrontmost("invalid.browser-control.no-such-app");
    assert.equal(result.restored, false);
    assert.equal(await frontmostApp(), before, "the operator moving to another app is not something to undo");
  });
});

describe("isBrowser", () => {
  it("knows which application is allowed to lose the screen", () => {
    for (const app of ["com.google.Chrome", "com.google.Chrome.canary", "org.chromium.Chromium"]) assert.equal(isBrowser(app), true, app);
    for (const app of ["com.microsoft.VSCode", "com.apple.Terminal", "com.googlecode.iterm2", null, undefined, ""]) assert.equal(isBrowser(app), false, String(app));
  });
});

describe("watchFocus", () => {
  it("is a no-op it can still stop when there is nobody to restore", async () => {
    const result = await watchFocus(null).stop();
    assert.equal(result.restored, false);
    assert.equal(result.skipped, true);
  });

  it("stops cleanly without ever having moved the screen", async () => {
    const before = await frontmostApp();
    const watch = watchFocus("invalid.browser-control.no-such-app");
    const result = await watch.stop();
    assert.equal(result.restored, false);
    assert.equal(await frontmostApp(), before, "polling must not be a way to lose your window");
  });
});
