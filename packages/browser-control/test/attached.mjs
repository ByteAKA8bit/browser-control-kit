// Attach once for a suite, or say plainly why the suite cannot run.
//
// These suites drive the operator's real browser, so they depend on a machine
// that has one set up: Chrome running, the Playwright Extension installed in
// the profile, a token. A missing prerequisite is not a failing test — it is a
// suite that has nothing to say — so it is reported as a skip with the reason,
// the same policy scripts/check.mjs applies to its browser tier. Anything else
// (a real transport bug) still fails loudly.
import { attach } from "../src/attach.mjs";

const NOT_SET_UP = [
  [/did not connect within|Playwright Extension not found/, "the Playwright Extension did not connect (not installed, or Chrome's profile directory is unreadable)"],
  [/no extension token|PLAYWRIGHT_MCP_EXTENSION_TOKEN/, "no Playwright Extension token (see README: Token)"],
  [/ECONNREFUSED|never accepted a connection|No CDP shim|no approved Chrome connection|stopped answering/, "no CDP shim is reachable with an approved Chrome connection (npm run shim)"],
];

/**
 * @returns {Promise<{ attached: object|null, skip: string|false }>} `skip` carries the reason.
 */
export async function attachOrSkip(options = {}) {
  try {
    return { attached: await attach(options), skip: false };
  } catch (err) {
    const message = String(err?.message ?? err).split("\n")[0];
    const known = NOT_SET_UP.find(([pattern]) => pattern.test(message));
    if (!known) throw err; // a genuine failure: let it fail the suite
    return { attached: null, skip: `${known[1]} — ${message.slice(0, 120)}` };
  }
}
