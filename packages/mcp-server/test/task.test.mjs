// Why this exists: the task file is the only thing that survives the process,
// and a wrong recovery rule either loses the agent's state or repeats an action
// that already happened. Every case here is a restart.
//
//   node --test test/task.test.mjs
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Task, encodeState, taskId } from "../src/task.mjs";

const dirs = [];
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bc-task-"));
  dirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("task state", () => {
  it("brings state back after the process restarts", () => {
    const dir = temp();
    const first = new Task({ client: "proj", dir });
    first.state.booking = { id: "A1" };
    first.sync({ state: first.state });

    const second = new Task({ client: "proj", dir });
    assert.deepEqual(second.state, { booking: { id: "A1" } });
    assert.ok(second.report().state.bytes > 0);
  });

  it("keeps intent, next step and the journal on disk", () => {
    const dir = temp();
    new Task({ client: "proj", dir }).edit({ intent: "book a table", next: "paste the code", note: "operator has the phone" });

    const reopened = new Task({ client: "proj", dir });
    const report = reopened.report();
    assert.equal(report.intent, "book a table");
    assert.equal(report.next, "paste the code");
    assert.match(report.journal.join("\n"), /paste the code/);
    assert.match(readFileSync(path.join(dir, "proj", "journal.ndjson"), "utf8"), /operator has the phone/);
  });

  it("clears the same state object a running script holds, and archives the journal", () => {
    const dir = temp();
    const first = new Task({ client: "proj", dir });
    const held = first.state; // exactly what Session.scriptState points at
    held.keep = 1;
    first.sync({ state: held });
    first.edit({ intent: "old goal", note: "before reset" });
    first.edit({ reset: true });

    assert.deepEqual(Object.keys(held), [], "reset must empty the live object, not swap it");
    assert.ok(readdirSync(path.join(dir, "proj")).some((file) => file.startsWith("journal-")), "the old journal was archived");
    const reopened = new Task({ client: "proj", dir });
    assert.equal(reopened.report().intent, "");
    assert.deepEqual(reopened.state, {});
  });

  it("tells a resumed agent what the task was doing", () => {
    const dir = temp();
    const first = new Task({ client: "proj", dir });
    assert.equal(first.resume(), "", "a fresh task has nothing to resume");
    first.edit({ intent: "book a table", next: "paste the code" });
    first.sync({ jobs: [{ name: "snipe", state: "running", startedAt: 1 }] });

    const reopened = new Task({ client: "proj", dir });
    assert.match(reopened.resume(), /book a table/);
    assert.match(reopened.resume(), /next: paste the code/);
    assert.match(reopened.resume(), /snipe/);
  });

  it("marks a job that was running as interrupted, and never restarts it", () => {
    const dir = temp();
    new Task({ client: "proj", dir }).sync({ jobs: [{ name: "snipe", state: "running", startedAt: 1 }] });

    const reopened = new Task({ client: "proj", dir });
    const report = reopened.report();
    assert.equal(report.jobs[0].state, "interrupted");
    assert.match(report.journal.join("\n"), /interrupted: snipe/);
  });

  it("keeps an interrupted job visible after the next process writes its own job table", () => {
    const dir = temp();
    new Task({ client: "proj", dir }).sync({ jobs: [{ name: "snipe", state: "running", startedAt: 1 }] });

    const reopened = new Task({ client: "proj", dir });
    reopened.sync({ jobs: [] }); // this process started no jobs of its own
    assert.equal(reopened.report().jobs[0].state, "interrupted", "an empty table must not erase the warning");

    const later = new Task({ client: "proj", dir });
    assert.equal(later.report().jobs[0].name, "snipe");
    later.edit({ reset: true });
    assert.deepEqual(later.report().jobs, [], "only an explicit reset forgets it");
  });

  it("lets a new job of the same name replace the interrupted record", () => {
    const dir = temp();
    new Task({ client: "proj", dir }).sync({ jobs: [{ name: "snipe", state: "running", startedAt: 1 }] });
    const task = new Task({ client: "proj", dir });
    task.sync({ jobs: [{ name: "snipe", state: "done", startedAt: 2 }] });
    assert.equal(task.report().jobs[0].state, "done");
  });
});

describe("state encoding", () => {
  it("stores what JSON can and names what it cannot", () => {
    const shared = { a: 1 };
    const { text, lost } = encodeState({
      shared,
      again: shared,
      fn: () => {},
      buf: Buffer.from("hi"),
      big: 10n,
      when: new Date(0),
    });
    assert.match(text, /\[Buffer 2 bytes\]/);
    assert.match(text, /"big":"10"/);
    assert.match(text, /1970-01-01/);
    assert.match(lost.join(","), /function fn/);
    assert.match(lost.join(","), /Buffer buf/);
  });

  it("keeps the last good copy when state exceeds the limit", () => {
    const dir = temp();
    const before = process.env.BC_MCP_TASK_STATE_MAX;
    process.env.BC_MCP_TASK_STATE_MAX = "200";
    try {
      const task = new Task({ client: "proj", dir });
      task.state.ok = "x".repeat(100);
      task.sync({ state: task.state });
      task.state.big = "y".repeat(400);
      const result = task.sync({ state: task.state });
      assert.equal(result.saved, true, "the journal and the skip notice still get written");
      assert.ok(task.report().state.skipped);

      const reopened = new Task({ client: "proj", dir });
      assert.equal(reopened.state.big, undefined, "an oversized value must not be written");
      assert.equal(reopened.state.ok.length, 100);
      assert.match(reopened.report().journal.join("\n"), /state too large/);
    } finally {
      if (before === undefined) delete process.env.BC_MCP_TASK_STATE_MAX;
      else process.env.BC_MCP_TASK_STATE_MAX = before;
    }
  });

  it("keeps an unreadable task file instead of deleting the only copy", () => {
    const dir = temp();
    const folder = path.join(dir, "proj");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "task.json"), "{not json");

    const task = new Task({ client: "proj", dir });
    assert.ok(task.loadError);
    assert.equal(task.report().intent, "");
    assert.match(task.resume(), /could not be read/);
    assert.ok(readdirSync(folder).some((file) => file.startsWith("task.json.corrupt-")));
  });
});

describe("saved pages", () => {
  it("remembers a URL and keeps it when the tab closes", () => {
    const dir = temp();
    const first = new Task({ client: "proj", dir });
    first.rememberSurface("docs", { url: "https://example.com/docs", title: "Docs" });
    first.sync({ surfaces: [{ name: "docs", url: "https://example.com/docs" }] });
    first.sync({ surfaces: [] }); // the tab went away

    const reopened = new Task({ client: "proj", dir });
    assert.equal(reopened.surface("docs").title, "Docs", "a stable URL keeps the title a navigate gave it");
    assert.equal(reopened.surface("docs").url, "https://example.com/docs");
  });

  it("follows a page that moved", () => {
    const dir = temp();
    const task = new Task({ client: "proj", dir });
    task.rememberSurface("docs", { url: "https://example.com/old" });
    task.sync({ surfaces: [{ name: "docs", url: "https://example.com/new" }] });
    assert.equal(new Task({ client: "proj", dir }).surface("docs").url, "https://example.com/new");
  });
});

describe("switches", () => {
  it("writes nothing when BC_MCP_TASK=0, and says so", () => {
    const dir = temp();
    const before = process.env.BC_MCP_TASK;
    process.env.BC_MCP_TASK = "0";
    try {
      const task = new Task({ client: "off", dir });
      assert.throws(() => task.edit({ note: "x" }), /BC_MCP_TASK=0/);
      assert.equal(existsSync(path.join(dir, "off")), false);
      assert.equal(task.report().enabled, false);
    } finally {
      if (before === undefined) delete process.env.BC_MCP_TASK;
      else process.env.BC_MCP_TASK = before;
    }
  });

  it("makes a directory-safe id from the client, with BC_TASK_ID winning", () => {
    const before = process.env.BC_TASK_ID;
    delete process.env.BC_TASK_ID;
    try {
      assert.equal(taskId("My Project"), "my-project");
      process.env.BC_TASK_ID = "Agent/Session: one";
      assert.equal(taskId("My Project"), "agent-session-one");
    } finally {
      if (before === undefined) delete process.env.BC_TASK_ID;
      else process.env.BC_TASK_ID = before;
    }
  });
});
