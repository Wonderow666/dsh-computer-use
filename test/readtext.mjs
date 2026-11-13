// Read-only integration check for the text channel and capture trimming.
// Nothing here injects input, so it is safe to run on a machine in use.
//
//   node test/readtext.mjs
//
// It launches a console (the one window class that always exposes text), reads
// it back through UIA, waits for a regex, and proves that --trim shrinks a
// capture whose content sits inside a larger background.
import { loadTool } from "./_harness.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { ARTIFACTS, ENGINE } from "./_harness.mjs";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}

const { run } = await loadTool();

// 1. a window that answers with text: the console
const launched = await run({ action: "launch", path: "C:\\Windows\\System32\\cmd.exe" });
const pid = launched.pid;
console.log(`launched cmd.exe pid=${pid} hwnd=${launched.hwnd}`);

let con = null;
for (let i = 0; i < 20 && !con; i++) {
  const list = await run({ action: "windows" });
  con = (list.windows || []).find((w) => Number(w.pid) === Number(pid) && w.visible);
  if (!con) await new Promise((r) => setTimeout(r, 250));
}
check("console window appeared", Boolean(con), con && `hwnd=${con.hwnd} rect=${con.rect.w}x${con.rect.h}`);

const read = await run({ action: "readtext", hwnd: String(con.hwnd), chars: 400 });
check("readtext finds a text channel", read.chars > 0 && read.strategy !== "none", `strategy=${read.strategy} chars=${read.chars}`);
check("readtext returns the banner", /Microsoft Windows|Windows \[/.test(read.text || ""), (read.text || "").slice(0, 40));

const waited = await run({ action: "waittext", hwnd: String(con.hwnd), regex: "dsh-computer-use>", timeout: 4000 });
check("waittext matches the prompt", waited.matched === true, `waitedMs=${waited.waitedMs}`);

// 2. a window that exposes nothing: readtext must say so, not invent text
const dsh = (await run({ action: "windows" })).windows.find((w) => /DeepSeek|Chrome_WidgetWin/i.test(`${w.title} ${w.class}`));
if (dsh) {
  const empty = await run({ action: "readtext", hwnd: String(dsh.hwnd), chars: 500 });
  check("a window without a text channel reports none", empty.chars === 0 && Boolean(empty.hint), `strategy=${empty.strategy}`);
}

// 3. trim: a console client area is mostly one colour, so the text block is a
//    small island inside it and --trim has something to cut. (White page with a
//    dialog on it behaves the same way; a photo background does not, and trim
//    correctly leaves such a capture untouched.)
const geom = await run({ action: "geom", hwnd: String(con.hwnd) });
const c = geom.client;
const origin = geom.clientOrigin;
const region = `${origin.x},${origin.y},${origin.x + c.w},${origin.y + c.h}`;
const raw = await run({ action: "screenshot", region, maxw: 0 });
const cut = await run({ action: "screenshot", region, maxw: 0, trim: true });
check("--trim shrinks a capture with margins", cut.w * cut.h < raw.w * raw.h, `${raw.w}x${raw.h} -> ${cut.w}x${cut.h}`);
check("--trim reports the crop box", Boolean(cut.trim), cut.trim && JSON.stringify(cut.trim));

// 4. the plugin's own screenshots land in artifacts and stay readable
for (const f of [raw.path, cut.path]) {
  check(`png written: ${path.basename(f)}`, fs.existsSync(f) && fs.statSync(f).size > 1000, fs.existsSync(f) ? `${fs.statSync(f).size} bytes` : "missing");
}

// cleanup: kill the console we started, never the one the user may own
const killed = spawnSync(ENGINE, ["kill", "--pid", String(pid)], { encoding: "utf8" });
check("console closed", killed.status === 0, (killed.stdout || "").trim().slice(0, 80));

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed  (artifacts: ${ARTIFACTS})\n`);
