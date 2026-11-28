// Live check for v0.23.0 + v0.27.1: a click given in picture pixels, and a file
// handed to a real Win32 file dialog owned by the app in front.
//
// Notepad is single-instance: launching it while one is running just opens a tab
// in the existing process, so "our" pid is often not the pid that owns the window.
// We therefore track the window (and close only what we actually started).
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

const notepads = async () => {
  const list = await run({ action: "windows" });
  return (list.windows || []).filter((w) => /notepad/i.test(w.process || "") && w.visible !== false);
};

const before = await notepads();
const beforePids = new Set(before.map((w) => w.pid));
let launched;
try { launched = await run({ action: "launch", path: "notepad.exe" }); }
catch (e) { console.log("skip: notepad will not start here:", e.message); process.exit(0); }
await sleep(1500);

// Prefer a window that appeared because of us; fall back to an existing one.
let win = null;
for (let i = 0; i < 12 && !win; i++) {
  const list = await notepads();
  win = list.find((w) => !beforePids.has(w.pid)) || list[0];
  if (!win) await sleep(400);
}
check("a notepad window is up", Boolean(win), win ? `hwnd ${win.hwnd} pid ${win.pid} "${win.title}"` : "none");
if (!win) process.exit(1);

const appPid = win.pid;
const startedIt = !beforePids.has(appPid);
const hwnd = String(win.hwnd);
const cleanup = async () => {
  if (startedIt) await run({ action: "kill", pid: appPid }).catch(() => {});
};

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
await run({ action: "key", hwnd, combo: "ctrl+o" });
let dialog = null;
for (let i = 0; i < 24 && !dialog; i++) {
  await sleep(250);
  const modals = await run({ action: "modals" });
  dialog = (modals.modals || modals.items || []).find(
    (d) => /#32770/.test(String(d.class || "")) && d.pid === appPid
  );
}
check("ctrl+o opened a dialog owned by the app", Boolean(dialog), dialog ? `"${dialog.title}" pid ${dialog.pid}` : "none");
if (!dialog) {
  await cleanup();
  process.exit(1);
}

const up = await run({ action: "upload", path: file });
check("upload picked the app's dialog", up.dialogPid === appPid || up.dialogPid === dialog.pid,
  `picked "${up.dialog}" pid ${up.dialogPid}, wanted ${dialog.pid}`);
check("upload says it handled the dialog", up.ok === true, JSON.stringify(up).slice(0, 200));
check("the dialog closed", up.closed === true, String(up.closed));

await sleep(600);
// Notepad opens the file in its own tab: read the tab that names the file.
let tab = null;
for (let i = 0; i < 12 && !tab; i++) {
  tab = (await notepads()).find((w) => /upload-live\.txt/.test(String(w.title || "")));
  if (!tab) await sleep(300);
}
check("the file opened in its own tab", Boolean(tab), tab ? `hwnd ${tab.hwnd} "${tab.title}"` : "no tab named upload-live.txt");
const read = tab ? await run({ action: "readtext", hwnd: String(tab.hwnd) }) : { text: "" };
const body = String(read.text || "");
check("the file the dialog opened is on screen", /dsh upload ok/.test(body), body.replace(/\s+/g, " ").slice(0, 160));

await cleanup();
console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
