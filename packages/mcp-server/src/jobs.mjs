// Real browser work is long: wait for the operator to type a password, poll a
// booking page for an hour, retry a sold-out ticket every 300 ms, sit through a
// payment. None of that fits in one tool call, and a tool call that blocks for
// an hour is a client timeout, not a feature. So a body can hand work to a NAMED
// job that outlives the call, and a later call asks how it is going.
//
// Named, not handles — the same bargain as pages. Each job carries its own
// AbortSignal, its own ring of log lines (so progress is visible while it runs)
// and its final value or error. Nothing here is persisted: the client owning
// this process is the lifetime of everything, jobs included.
const LOG_LINES = Number(process.env.BC_MCP_JOB_LOG ?? 200);

/** A wait that ends when the job does: a cancelled loop must stop sleeping, not keep its timer alive. */
function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("cancelled"));
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** One job table per session. */
export class Jobs {
  #jobs = new Map();

  /**
   * Start `fn` under `name`, replacing a finished job of that name.
   * @param {string} name
   * @param {(ctx: { signal: AbortSignal, sleep: (ms: number) => Promise<void>, log: (...parts: unknown[]) => void }) => Promise<unknown>} fn
   */
  start(name, fn) {
    const key = String(name ?? "").trim();
    if (!key) throw new Error('jobs.start(name, fn) wants a name: that is how a later call asks about it');
    const running = this.#jobs.get(key);
    if (running?.state === "running") throw new Error(`job "${key}" is still running — cancel it first, or use another name`);
    const controller = new AbortController();
    const job = { name: key, state: "running", startedAt: Date.now(), endedAt: null, logs: [], value: undefined, error: null, controller };
    job.log = (...parts) => {
      job.logs.push(`${new Date().toISOString().slice(11, 19)} ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`);
      if (job.logs.length > LOG_LINES) job.logs.splice(0, job.logs.length - LOG_LINES); // a loop running for an hour must not grow
    };
    this.#jobs.set(key, job);
    job.promise = (async () => fn({ signal: controller.signal, sleep: (ms) => waitFor(ms, controller.signal), log: job.log }))().then(
      (value) => {
        job.value = value;
        job.state = "done";
        job.endedAt = Date.now();
        return value;
      },
      (err) => {
        job.error = String(err?.message ?? err).split("\n")[0];
        job.state = controller.signal.aborted ? "cancelled" : "failed";
        job.endedAt = Date.now();
      },
    );
    return this.status(key);
  }

  /** How a job is doing, with its recent log lines — safe to call at any time. */
  status(name) {
    const job = this.#jobs.get(String(name ?? "").trim());
    if (!job) return null;
    return {
      name: job.name,
      state: job.state,
      runningMs: (job.endedAt ?? Date.now()) - job.startedAt,
      logs: job.logs.slice(-20),
      ...(job.state === "done" ? { value: job.value } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  /** Every job this session knows about, newest first. */
  list() {
    return [...this.#jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map((job) => this.status(job.name));
  }

  /** Wait for a job to finish, optionally giving up after `timeoutMs` and leaving it running. */
  async wait(name, timeoutMs) {
    const job = this.#jobs.get(String(name ?? "").trim());
    if (!job) return null;
    if (!(Number(timeoutMs) > 0)) await job.promise;
    else {
      let timer = null;
      const capped = new Promise((resolve) => {
        timer = setTimeout(resolve, Number(timeoutMs));
        timer.unref?.();
      });
      await Promise.race([job.promise, capped]);
      clearTimeout(timer);
    }
    return this.status(job.name);
  }

  /** Ask a job to stop; it sees `signal.aborted` and whatever it awaits rejects. */
  cancel(name) {
    const job = this.#jobs.get(String(name ?? "").trim());
    if (!job || job.state !== "running") return this.status(name);
    job.controller.abort(new Error(`job "${job.name}" was cancelled`));
    return this.status(job.name);
  }

  /** Stop everything (server shutdown): a job must not outlive the session it drives. */
  cancelAll() {
    for (const job of this.#jobs.values()) if (job.state === "running") job.controller.abort(new Error(`job "${job.name}" was cancelled: the MCP client disconnected`));
  }
}
