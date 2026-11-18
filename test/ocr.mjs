// Read-only integration check for the OCR channel and the frame quality gate.
// It launches a console, reads it with tesseract, and proves that an impossible
// quality gate refuses the frame instead of handing back a blank image.
//
// Requires tesseract. Point DSH_TESSERACT at the binary, or put it on PATH.
// The script skips itself when tesseract cannot be found, so CI stays green.

import path from "node:path";
import { loadTool } from "./_harness.mjs";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) process.exitCode = 1;
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ""), "..");
const { run } = await loadTool({ enginePath: undefined, tesseract: process.env.DSH_TESSERACT || "tesseract" });

let launched = null;
try {
  launched = await run({ action: "launch", path: "C:\\Windows\\System32\\cmd.exe", cwd: ROOT });
} catch (err) {
  console.log(`SKIP cannot launch a console here: ${err.message}`);
  process.exit(0);
}
const pid = launched.pid;

// The engine adopts a conhost / Windows Terminal window for console apps, whose
// owning process is not the shell itself - trust the returned hwnd first.
let con = Number(launched.hwnd) > 0 ? { hwnd: launched.hwnd, rect: { w: 0, h: 0 }, pid } : null;
for (let i = 0; i < 20 && !con; i++) {
  const list = await run({ action: "windows" });
  con = (list.windows || []).find((w) => Number(w.pid) === Number(pid) && w.visible);
  if (!con) await new Promise((r) => setTimeout(r, 250));
}
check("console window appeared", Boolean(con), con && `hwnd=${con.hwnd} ${con.rect.w}x${con.rect.h}`);
if (!con) process.exit(1);

// A fresh console already shows its banner, which needs no input at all - that
// keeps this test read-only even when another window owns the foreground.
await new Promise((r) => setTimeout(r, 700));

let read = null;
try {
  read = await run({ action: "ocr", hwnd: String(con.hwnd), psm: 6, maxw: 1600 });
} catch (err) {
  if (/could not run tesseract|ENOENT/i.test(err.message)) {
    console.log(`SKIP tesseract is not available: ${err.message}`);
    await run({ action: "kill", pid: Number(pid) });
    process.exit(0);
  }
  throw err;
}
check("ocr returns text", read.chars > 20, `chars=${read.chars} ms=${read.ms}`);
check("ocr reads the console banner or prompt", /Microsoft Windows|Windows \[|dsh-computer-use>|C:\\\\Windows/i.test(read.text || ""), (read.text || "").replace(/\s+/g, " ").slice(0, 60));

// An impossible gate must refuse the frame rather than return a blank picture.
let refused = null;
try {
  await run({ action: "screenshot", hwnd: String(con.hwnd), maxw: 0, minStddev: 200 });
} catch (err) {
  refused = err.message;
}
check("an impossible quality gate refuses the capture", Boolean(refused) && /looks blank/i.test(refused || ""), refused && refused.slice(0, 90));

// A sane gate passes and reports its measurements.
const shot = await run({ action: "screenshot", hwnd: String(con.hwnd), maxw: 0, minStddev: 1, minBrightness: 1 });
check("a real frame passes the gate and reports mean/contrast", Number.isFinite(shot.mean) && Number.isFinite(shot.contrast), `mean=${shot.mean} contrast=${shot.contrast}`);

const closed = await run({ action: "kill", pid: Number(pid) });
check("console closed", Boolean(closed.ok !== false), JSON.stringify(closed));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
