// The MCP wrapper speaks a protocol, so it is tested over the wire: spawn it,
// write one JSON-RPC message per line, read the answers back.
import assert from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { ROOT } from "./_harness.mjs";

const child = spawn(process.execPath, [path.join(ROOT, "mcp", "server.mjs")], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", "pipe"]
});

let pass = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { console.log(`  FAIL ${name} ${extra}`); process.exitCode = 1; }
};

const lines = [];
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) lines.push(JSON.parse(line));
  }
});
const stderr = [];
child.stderr.on("data", (d) => stderr.push(d.toString("utf8")));

const waitFor = async (id, ms = 20000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const hit = lines.find((m) => m && m.id === id);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no answer for id ${id}; got ${JSON.stringify(lines).slice(0, 400)} stderr=${stderr.join("").slice(0, 400)}`);
};
const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
const init = await waitFor(1);
ok("initialize names the server and version", init.result && init.result.serverInfo && init.result.serverInfo.name === "dsh-computer-use" && /^\d+\.\d+\.\d+$/.test(init.result.serverInfo.version), JSON.stringify(init));
ok("it advertises the tools capability", !!(init.result && init.result.capabilities && init.result.capabilities.tools), JSON.stringify(init.result));
ok("it answers with the protocol version asked for", init.result.protocolVersion === "2024-11-05", init.result.protocolVersion);

send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const list = await waitFor(2);
const tools = (list.result && list.result.tools) || [];
ok("there is exactly one tool, named computer", tools.length === 1 && tools[0].name === "computer", JSON.stringify(tools.map((t) => t.name)));
ok("its schema is the plugin's own schema, not a copy", tools[0].inputSchema === undefined ? false : tools[0].inputSchema.properties && tools[0].inputSchema.required.includes("action"), JSON.stringify(tools[0].inputSchema || {}).slice(0, 200));
ok("it has a description worth reading", typeof tools[0].description === "string" && tools[0].description.length > 200);

send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "computer", arguments: { action: "info" } } });
const call = await waitFor(3);
const text = call.result && call.result.content && call.result.content[0] && call.result.content[0].text;
let info = null;
try { info = JSON.parse(text); } catch { /* reported below */ }
ok("a tool call comes back as text content", typeof text === "string" && text.length > 0, JSON.stringify(call).slice(0, 300));
ok("the real engine answered", !!info && info.ok === true && typeof info.screenW === "number", String(text).slice(0, 300));
ok("a successful call is not marked as an error", call.result.isError === false, JSON.stringify(call.result && call.result.isError));

send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "computer", arguments: { action: "no-such-action" } } });
const bad = await waitFor(4);
const badText = bad.result && bad.result.content && bad.result.content[0] && bad.result.content[0].text;
ok("a tool failure is a result with isError, not a protocol error", bad.result && bad.result.isError === true && /must be one of info/i.test(badText || ""), JSON.stringify(bad).slice(0, 300));

send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });
const unknown = await waitFor(5);
ok("an unknown tool is a protocol error (-32602)", !!unknown.error && unknown.error.code === -32602, JSON.stringify(unknown));

send({ jsonrpc: "2.0", id: 6, method: "resources/list" });
const rl = await waitFor(6);
ok("an unknown method is -32601", !!rl.error && rl.error.code === -32601, JSON.stringify(rl));

send({ jsonrpc: "2.0", id: 7, method: "ping" });
const ping = await waitFor(7);
ok("ping answers", !!ping.result, JSON.stringify(ping));

ok("the progress went to stderr, never into the stream", lines.every((m) => m && m.jsonrpc === "2.0"), JSON.stringify(lines).slice(0, 200));

child.stdin.end();
await new Promise((r) => child.on("exit", r));
ok("closing stdin shuts the server down", child.exitCode === 0, String(child.exitCode));

console.log(`\n${pass} passed`);
