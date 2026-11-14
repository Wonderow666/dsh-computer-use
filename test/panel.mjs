// The browser panel: routes, token enforcement and the action whitelist.
//
//   node test/panel.mjs
//
// First half runs the panel against a stub executor (fast, no engine); second
// half boots the real plugin with panelPort and asks its live endpoint for the
// desktop state, which proves the wiring end to end.
import { loadTool, ARTIFACTS } from "./_harness.mjs";
import { startPanel, createPanelHandler } from "../lib/panel.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}

const seen = [];
const fakeExec = async (args) => {
  seen.push(args);
  switch (args.action) {
    case "state":
      return { ok: true, locked: false, lockAppRunning: false, foreground: { hwnd: 1, process: "stub.exe" } };
    case "ui":
      return { ok: true, count: 2, scanned: 5, items: [{ id: "0.1", role: "Button", name: "OK" }] };
    case "screenshot":
      return { ok: true, path: png, w: 100, h: 50, srcW: 100, srcH: 50, x: 0, y: 0, bytes: 68 };
    case "hit":
      return { ok: true, window: { hwnd: 1 }, element: { id: "0.1.2", role: "Button", name: "OK" } };
    default:
      return { ok: true, action: args.action };
  }
};

fs.mkdirSync(ARTIFACTS, { recursive: true });
const png = path.join(ARTIFACTS, "panel-test.png");
fs.writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));

const panel = await startPanel({ exec: fakeExec, port: 0, artifactsDir: ARTIFACTS });
const base = `http://127.0.0.1:${panel.port}`;
const auth = { headers: { "x-panel-token": panel.token } };

const noToken = await fetch(base + "/");
check("a request without the token is refused", noToken.status === 401, `status ${noToken.status}`);

const page = await fetch(`${base}/?t=${panel.token}`);
const html = await page.text();
check("the page is served with the token", page.status === 200 && html.includes("computer"));
check("the page carries the click-to-inspect hook", html.includes("/api/hit"));

const state = await (await fetch(base + "/api/state", auth)).json();
check("state answers through the panel", state.ok === true && state.locked === false);

const ui = await (await fetch(base + "/api/ui?hwnd=1", auth)).json();
check("ui forwards the window and reports controls", ui.count === 2 && seen.some((a) => a.action === "ui" && a.hwnd === "1"));

const shot = await (await fetch(base + "/api/shot?hwnd=1&maxw=1400", auth)).json();
check("shot returns a path", shot.ok === true && shot.w === 100);

const img = await fetch(`${base}/api/png?p=${encodeURIComponent(png)}&t=${panel.token}`);
check("the screenshot bytes are served", img.status === 200 && img.headers.get("content-type") === "image/png");

const outside = await fetch(`${base}/api/png?p=${encodeURIComponent("C:\\Windows\\notepad.exe")}&t=${panel.token}`);
check("the panel refuses to serve files outside its artifacts", outside.status === 404, `status ${outside.status}`);

const hit = await (await fetch(base + "/api/hit", {
  method: "POST",
  headers: { "x-panel-token": panel.token, "content-type": "application/json" },
  body: JSON.stringify({ x: 10, y: 20 })
})).json();
check("hit reports the element under the point", hit.element && hit.element.id === "0.1.2");

const act = await fetch(base + "/api/act", {
  method: "POST",
  headers: { "x-panel-token": panel.token, "content-type": "application/json" },
  body: JSON.stringify({ action: "click", hwnd: "1", x: 10, y: 20 })
});
check("an allowed action runs", act.status === 200 && seen.some((a) => a.action === "click"));

const bad = await fetch(base + "/api/act", {
  method: "POST",
  headers: { "x-panel-token": panel.token, "content-type": "application/json" },
  body: JSON.stringify({ action: "kill", pid: 4 })
});
check("a non-whitelisted action is refused", bad.status === 403, `status ${bad.status}`);

const log = await (await fetch(base + "/api/log", auth)).json();
check("the panel keeps an action log", log.lines.length > 0 && log.lines.some((l) => l.includes("act click")));

await panel.close();

// Wiring: the real plugin, with panelPort requested, publishes a usable URL.
const { run } = await loadTool({ panelPort: 0 });
const info = await run({ action: "info" });
check("the plugin still works with the panel on", info.ok === true, `screen ${info.screenW}x${info.screenH}`);

const manifest = path.join(ARTIFACTS, "e2e", "panel.json");
let published = null;
for (let i = 0; i < 20 && !published; i++) {
  if (fs.existsSync(manifest)) published = JSON.parse(fs.readFileSync(manifest, "utf8"));
  else await new Promise((r) => setTimeout(r, 100));
}
check("the plugin publishes the panel URL to artifacts", Boolean(published && published.url), published && published.url);

if (published) {
  const live = await fetch(`http://127.0.0.1:${published.port}/api/state`, { headers: { "x-panel-token": published.token } });
  const liveState = await live.json();
  check("the live panel answers with real desktop state", live.status === 200 && liveState.ok === true && Boolean(liveState.foreground), `locked=${liveState.locked}`);
}

// The same handler mounts on DSH's own web server under a prefix: the client
// tab frames it same-origin, so the page must carry that prefix in every fetch
// and the API must answer under it too.
const mounted = http.createServer((req, res) => {
  createPanelHandler({ exec: fakeExec, artifactsDir: ARTIFACTS, prefix: "/computer-use/panel" }).handler(req, res);
});
await new Promise((resolve) => mounted.listen(0, "127.0.0.1", resolve));
const mountPort = mounted.address().port;
const mountBase = `http://127.0.0.1:${mountPort}/computer-use/panel`;
const mountPage = await fetch(`${mountBase}/`);
const mountHtml = await mountPage.text();
check("the prefixed mount serves the page without a token", mountPage.status === 200 && mountHtml.includes("/api/hit"));
check("the prefixed page bakes the mount prefix into its fetches", mountHtml.includes('const base = "/computer-use/panel"'));
const mountState = await fetch(`${mountBase}/api/state`);
const mountStateJson = await mountState.json();
check("the prefixed mount answers the API", mountState.status === 200 && mountStateJson.ok === true);
const mountOff = await fetch(`http://127.0.0.1:${mountPort}/api/state`);
check("the prefixed mount refuses paths outside its prefix", mountOff.status === 404, `status ${mountOff.status}`);
mounted.closeAllConnections?.();
await new Promise((resolve) => mounted.close(resolve));

// The real plugin must mount the panel on the host web server, with the prefix
// the client tab frames.
const plugin = await import("../lib/index.js");
const mounts = [];
const hostCtx = {
  tools: { register: () => {} },
  webServer: { register: (route) => { mounts.push(route); return () => {}; } },
  effect: (fn) => { const off = fn(); return () => { if (typeof off === "function") off(); }; }
};
plugin.apply(hostCtx, { enabled: true, panelPort: false, artifactsDir: path.join(ARTIFACTS, "e2e") });
check("the plugin mounts the panel on the host web server", mounts.length === 1 && mounts[0].path === "/computer-use/panel" && mounts[0].kind === "prefix", mounts.map((m) => `${m.kind} ${m.path}`).join(", "));
const host = http.createServer((req, res) => mounts[0].handler(req, res));
await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
const hostPort = host.address().port;
const hostPage = await fetch(`http://127.0.0.1:${hostPort}/computer-use/panel/`);
const hostHtml = await hostPage.text();
check("the host mount serves the framed page", hostPage.status === 200 && hostHtml.includes('const base = "/computer-use/panel"'));
await fetch(`http://127.0.0.1:${hostPort}/computer-use/panel/api/state`).then((r) => r.json()).then(
  (s) => check("the host mount reaches the real desktop", s.ok === true && Boolean(s.foreground), `locked=${s.locked}`),
  (e) => check("the host mount reaches the real desktop", false, String(e && e.message))
);
host.closeAllConnections?.();
await new Promise((resolve) => host.close(resolve));

// The client bundle: run it the way DSH's loader does, then check it declares
// the services it needs and registers one tab type plus its body.
let bundle = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { bundle = def; } } };
const fakeReact = { createElement: (type, props) => ({ type, props }), useState: (v) => [v, () => {}] };
await import("../lib/client.js");
const client = bundle.factory((name) => {
  if (name === "react") return fakeReact;
  throw new Error(`unexpected require: ${name}`);
});
const tabCalls = [];
const seatCalls = [];
const effects = [];
client.apply({
  effect: (fn) => { effects.push(fn); },
  sidebarRightTabs: { register: (def) => { tabCalls.push(def); return () => {}; } },
  slots: { register: (seat) => { seatCalls.push(seat); return () => {}; } }
});
for (const fn of effects) fn();
check("the client declares the services it injects", Array.isArray(client.inject) && client.inject.includes("sidebarRightTabs") && client.inject.includes("slots"), client.inject.join(", "));
check("the client registers one sidebar tab type", tabCalls.length === 1 && tabCalls[0].id === "dsh-computer-use/panel" && tabCalls[0].kind === "computer-use-panel", tabCalls.map((t) => t.kind).join(","));
check("the client registers the tab body under the same key", seatCalls.length === 1 && seatCalls[0].name === "sidebar.right.pane.tab" && seatCalls[0].key === "dsh-computer-use/panel", seatCalls.map((s) => s.name).join(","));
const body = client.PanelBody();
check("the tab body frames the host-mounted panel", body && body.props && body.props.src === "/computer-use/panel/", body && body.props && body.props.src);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
// The panel the plugin started is a live listener on purpose; this script is
// done with it, so leave rather than keep the event loop alive.
process.exit(failed ? 1 : 0);
