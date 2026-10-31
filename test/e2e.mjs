// Observation-only smoke test: loads the real plugin, spawns the real engine,
// and reads the desktop. Nothing is clicked, typed or launched here.
//
//   node test/e2e.mjs
import fs from "node:fs";
import { loadTool } from "./_harness.mjs";

const { mod, tool, run } = await loadTool();
console.log("loaded module:", mod.name, "inject:", JSON.stringify(mod.inject));
console.log("registered tool:", tool.name, "| params:", Object.keys(tool.parameters.properties).length);

const info = await run({ action: "info" });
console.log("[info]", JSON.stringify({
  screenW: info.screenW, screenH: info.screenH, cursor: info.cursor,
  foreground: info.foreground && { hwnd: info.foreground.hwnd, process: info.foreground.process },
  monitors: info.monitors,
}).slice(0, 600));

const windows = await run({ action: "windows" });
const visible = windows.windows || [];
console.log("[windows] visible:", visible.length,
  visible.slice(0, 6).map((w) => `${w.hwnd}:${w.process || w.class}`).join(", "));

const shot = await run({ action: "screenshot", maxw: 900 });
console.log("[screenshot]", JSON.stringify({
  path: shot.path, w: shot.w, h: shot.h, srcW: shot.srcW, srcH: shot.srcH, scale: shot.scale,
}).slice(0, 400));
console.log("          png present:", fs.existsSync(shot.path));

const clip = await run({ action: "clipboard", clipboardCommand: "get" });
const clipBody = String(clip.text || "");
console.log("[clipboard] chars:", clipBody.length, "head:", clipBody.slice(0, 6).replace(/./g, "*"));

const dry = await run({ action: "click", x: 40, y: 40, dryRun: true });
console.log("[dryRun click]", JSON.stringify({ dryRun: dry.dryRun, argv: dry.argv, focused: dry.focused }).slice(0, 300));

const native = visible.find((w) => w.class && !/Chrome_WidgetWin|UnrealWindow|ConsoleWindowClass/.test(w.class) && !w.minimized);
if (native) {
  const snap = await run({ action: "snapshot", hwnd: String(native.hwnd), depth: 4, max: 40 });
  const nodes = snap.nodes || [];
  console.log(`[snapshot] ${native.class} -> nodes:`, nodes.length,
    nodes.slice(0, 5).map((n) => `${n.id}:${n.role}:${n.name}`).join(" | "));
} else {
  console.log("[snapshot] no native (non-Chromium) window available");
}

console.log("\nOK: real engine, real spawn, observation path verified.");
