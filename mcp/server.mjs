#!/usr/bin/env node
// MCP wrapper: the same `computer` tool, spoken by any MCP client.
//
// The plugin already owns the part that matters - the tool definition, the
// engine, the safety rails. This file only translates: MCP JSON-RPC on stdio
// in, `tool.execute()` out. No SDK, no dependencies, ~120 lines.
//
//   node mcp/server.mjs                 # speak MCP on stdin/stdout
//   DSH_COMPUTER_USE_MCP_CONFIG='{"artifactsDir":"..."}' node mcp/server.mjs
//
// stdio transport per the MCP spec: one JSON-RPC message per line, no
// embedded newlines, logs go to stderr so they never corrupt the stream.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const log = (...m) => { try { console.error("[dsh-computer-use/mcp]", ...m); } catch { /* no stderr */ } };

function configFromEnv() {
  const raw = process.env.DSH_COMPUTER_USE_MCP_CONFIG;
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    log("DSH_COMPUTER_USE_MCP_CONFIG is not JSON, ignoring it:", String(e && e.message));
    return {};
  }
}

let tool = null;
try {
  apply({ tools: { register: (def) => { tool = def; } } }, { enabled: true, ...configFromEnv() });
} catch (e) {
  log("the plugin refused to start:", String((e && e.message) || e));
}
if (!tool) {
  log("no tool was registered - nothing to serve");
  process.exit(1);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

// Requests are served one at a time: the desktop is a single resource, and two
// clicks interleaving is not a thing anyone wants.
let queue = Promise.resolve();

async function callTool(args) {
  const out = await tool.execute(args || {}, { signal: undefined });
  const text = out && typeof out.text === "string" ? out.text : JSON.stringify(out);
  return { content: [{ type: "text", text }], isError: false };
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dsh-computer-use", version: PKG.version }
      });
    case "notifications/initialized":
    case "initialized":
      return undefined; // notification: no answer
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: [{
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters
        }]
      });
    case "tools/call": {
      const name = params && params.name;
      if (name !== tool.name) return fail(id, -32602, `unknown tool ${JSON.stringify(name)}; this server offers ${JSON.stringify(tool.name)}`);
      try {
        return reply(id, await callTool(params.arguments));
      } catch (e) {
        // A tool failure is a result with isError, not a protocol error: the
        // model should see the message and decide what to do next.
        return reply(id, { content: [{ type: "text", text: String((e && e.message) || e) }], isError: true });
      }
    }
    default:
      if (isNotification) return undefined;
      return fail(id, -32601, `unknown method ${JSON.stringify(method)}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    fail(null, -32700, "parse error: " + String(e && e.message));
    return;
  }
  queue = queue
    .then(() => handle(msg))
    .catch((e) => {
      log("handler failed:", String((e && e.stack) || e));
      if (msg && msg.id !== undefined) fail(msg.id, -32603, String((e && e.message) || e));
    });
});
rl.on("close", () => { queue.then(() => process.exit(0)); });
log(`serving ${tool.name} v${PKG.version} over stdio`);
