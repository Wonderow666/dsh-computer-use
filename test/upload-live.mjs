// Live check for v0.23.0: a click given in picture pixels, and a file handed to
// a real Win32 file dialog.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTool } from "./_harness.mjs";

const { run } = await loadTool();
const artifactsDir = path.join(os.tmpdir(), "dsh-upload-live");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!cond) failed++;
};

let launched;
try { launched = await run({ action: "launch", path: "notepad.exe" }); }
catch (e) { console.log("skip: notepad will not start here:", e.message); process.exit(0); }
await sleep(2000);

let win = null;
for (let i = 0; i < 10 && !win; i++) {
  const list = await run({ action: "windows" });
  win = (list.windows || []).find((w) => /notepad/i.test(w.process || "") && w.visible !== false);
  if (!win) await sleep(400);
}
check("notepad is up", Boolean(win), win ? `hwnd ${win.hwnd} "${win.title}"` : "none");
if (!win) process.exit(1);
const hwnd = String(win.hwnd);

// 1. Picture pixels: the screenshot is downscaled, and nobody should do the math.
const shot = await run({ action: "screenshot", hwnd });
const near = (a, b) => Math.abs(a - b) <= 2;
const expectX = Math.round(shot.x + 30 * shot.scale);
const expectY = Math.round(shot.y + 8 * shot.scale);
const click = await run({ action: "click", imgx: 30, imgy: 8 });
check("a click in picture pixels maps to the right screen point",
  near(click.x, expectX) && near(click.y, expectY),
  `picture (30,8) -> screen (${click.x},${click.y}), expected (${expectX},${expectY}) at scale ${shot.scale}`);
check("the click was actually sent", click.ok === true, JSON.stringify(click).slice(0, 140));

// 2. upload: open a real file dialog, then hand it a path.
const file = path.join(artifactsDir, "upload-live.txt");
fs.mkdirSync(artifactsDir, { recursive: true });
fs.writeFileSync(file, "dsh upload ok\n", "utf8");
await run({ action: "focus", hwnd });
await run({ action: "key", hwnd, keys: "ctrl+o" });
let dialog = null;
for (let i = 0; i < 20 && !dialog; i++) {
  await sleep(250);
  const modals = await run({ action: "modals" });
  dialog = (modals.modals || modals.items || []).find((d) => /#32770/.test(String(d.class || "")));
}
check("ctrl+o opened a file dialog", Boolean(dialog), dialog ? `"${dialog.title}" ${dialog.class}` : "none");
if (!dialog) {
  await run({ action: "kill", pid: launched.pid }).catch(() => {});
  process.exit(1);
}

const up = await run({ action: "upload", path: file });
check("upload says it handled the dialog", up.ok === true, JSON.stringify(up).slice(0, 200));
check("the dialog closed", up.closed === true, String(up.closed));

await sleep(800);
const read = await run({ action: "readtext", hwnd });
const body = String(read.text || "");
check("the file the dialog opened is on screen", /dsh upload ok/.test(body), body.replace(/\s+/g, " ").slice(0, 160));

await run({ action: "kill", pid: launched.pid }).catch(() => {});
console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
