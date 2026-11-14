// The browser panel: routes, token enforcement and the action whitelist.
//
//   node test/panel.mjs
//
// First half runs the panel against a stub executor (fast, no engine); second
// half boots the real plugin with panelPort and asks its live endpoint for the
// desktop state, which proves the wiring end to end.
import { loadTool, ARTIFACTS } from "./_harness.mjs";
import { startPanel } from "../lib/panel.js";
import fs from "node:fs";
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

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
// The panel the plugin started is a live listener on purpose; this script is
// done with it, so leave rather than keep the event loop alive.
process.exit(failed ? 1 : 0);
