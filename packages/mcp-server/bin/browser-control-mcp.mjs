#!/usr/bin/env node
// Entry point: an MCP stdio server for browser-control.
//
// Non-goal: doing anything before a client asks. No browser is attached and
// playwright-core is not even loaded until the first tool call that needs one,
// so an idle server costs a bare Node process.
//
//   browser-control-mcp            # spoken to by the MCP client over stdio
//   BC_MODE=cdp browser-control-mcp
import { startServer } from "../src/server.mjs";

startServer();
