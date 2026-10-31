// Real input-injection verification against the WinForms fixture in test/target:
// focus -> type Unicode text -> click Save at its UIA rect -> read the file back
// -> invoke the same button through UI Automation -> read again. Covers
// SendInput keyboard, SendInput mouse and the UIA pattern path.
//
// It steals the foreground for a few seconds. Usage:
//   node test/input.mjs [hwnd-to-restore]
import fs from "node:fs";
import path from "node:path";
import { ARTIFACTS, ROOT, loadTool, sleep } from "./_harness.mjs";

const TARGET = path.join(ROOT, "test", "target", "target.exe");
const OUT = path.join(ROOT, "test", "target", "out.txt");

const { run } = await loadTool({ artifactsDir: path.join(ARTIFACTS, "input") });

const before = await run({ action: "windows" });
const restore = process.argv[2] || String((before.foreground || {}).hwnd || "");
console.log("before foreground:", (before.foreground || {}).title);
console.log("will restore focus to:", restore);

try { fs.unlinkSync(OUT); } catch {}
// Windows may refuse ShellExecute on a freshly built unsigned exe (Smart App
// Control / ASR -> error 1223), so this harness tolerates a failed launch and
// accepts a fixture that was started out of band.
try {
  const launched = await run({ action: "launch", path: TARGET, args: `"${OUT}"` });
  console.log("launch:", JSON.stringify(launched).slice(0, 160));
} catch (e) {
  console.log("launch skipped:", String(e.message).slice(0, 120));
  console.log("           start it yourself: test\\target\\target.exe \"test\\target\\out.txt\"");
}
await sleep(1200);

const wins = await run({ action: "windows" });
const target = (wins.windows || []).find((w) => w.visible && w.rect && w.rect.w > 0
  && (/target\.exe/i.test(w.process) || /Test Target/i.test(w.title)));
if (!target) throw new Error(`target window missing: ${(wins.windows || []).map((w) => w.process + "/" + w.title).join(", ")}`);
console.log("target window:", target.hwnd, target.class, JSON.stringify(target.title));

// 1. keyboard: the tool focuses the window, then types through SendInput.
const TEXT = "dsh-computer-use: \u4e2d\u6587 and ASCII mixed \u2705";
await run({ action: "type", hwnd: String(target.hwnd), text: TEXT });
await sleep(300);

// 2. mouse: click Save at the centre of its UIA rect.
const found = await run({ action: "find", hwnd: String(target.hwnd), name: "saveButton" });
const save = (found.matches || found.nodes || [])[0];
if (!save) throw new Error(`save button not found: ${JSON.stringify(found).slice(0, 300)}`);
const cx = Math.round(save.rect.x + save.rect.w / 2);
const cy = Math.round(save.rect.y + save.rect.h / 2);
console.log("save button:", save.id, JSON.stringify(save.rect), "-> click", cx, cy);
await run({ action: "click", hwnd: String(target.hwnd), x: cx, y: cy });
await sleep(500);

const afterClick = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").replace(/^\uFEFF/, "") : "<missing>";
console.log("file after mouse click:", JSON.stringify(afterClick));
const typedOk = afterClick === TEXT;
console.log("typing round-trip:", typedOk ? "MATCH" : "MISMATCH");
if (!typedOk) process.exitCode = 1;

// 3. UIA only: write the box through its Value pattern (no keyboard, no focus),
//    then drive the button through its Invoke pattern by id.
const TEXT2 = "\u2705 UIA SetValue #2";
const boxFound = await run({ action: "find", hwnd: String(target.hwnd), name: "inputBox" });
const box = (boxFound.matches || boxFound.nodes || [])[0];
if (!box) throw new Error(`input box not found: ${JSON.stringify(boxFound).slice(0, 200)}`);
const setVal = await run({ action: "invoke", hwnd: String(target.hwnd), elementPath: box.id, value: TEXT2 });
console.log("setValue:", JSON.stringify(setVal).slice(0, 200));
await sleep(150);
const inv = await run({ action: "invoke", hwnd: String(target.hwnd), elementPath: save.id });
console.log("invoke:", JSON.stringify(inv).slice(0, 200));
await sleep(400);

const afterInvoke = fs.readFileSync(OUT, "utf8").replace(/^\uFEFF/, "");
console.log("file after UIA invoke:", JSON.stringify(afterInvoke));
const invokedOk = afterInvoke === TEXT2;
console.log("invoke round-trip:", invokedOk ? "MATCH" : "MISMATCH");
if (!invokedOk) process.exitCode = 1;

const shot = await run({ action: "screenshot", hwnd: String(target.hwnd), maxw: 600 });
console.log("proof shot:", shot.path);

await run({ action: "kill", pid: target.pid });
await sleep(300);
if (restore && restore !== String(target.hwnd)) {
  await run({ action: "focus", hwnd: restore });
  console.log("focus restored to", restore);
}
